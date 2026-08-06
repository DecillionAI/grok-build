"""Shared helpers for deploying creatures onto a Caspar node.

Used by every deploy entrypoint in this repo:

* ``deploy_grok_creature.py`` — the agent backbone (this repo's Grok Build
  source, compiled into a docker creature);
* ``deploy_sandbox_tool.py``    — the per-space sandbox tool creature;
* ``deploy_github_tool.py``     — the github tool creature.

What lives here is everything that is the same for any docker creature: the durable
deploy-operator identity (``resolve_operator`` — one account for the backbone and
every tool, so redeploys reuse the same creatures/programs), build contexts and
their digests, the CA bundle and credential baking, the "has the node finished
building this image?" wait, and the VM resource knobs.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

GREEN, RED, YELLOW, CYAN, NC = "\033[0;32m", "\033[0;31m", "\033[0;33m", "\033[0;36m", "\033[0m"


def info(m: str) -> None:
    print(f"{CYAN}[deploy]{NC} {m}", flush=True)


def ok(m: str) -> None:
    print(f"{GREEN}[ ok ]{NC} {m}", flush=True)


def warn(m: str) -> None:
    print(f"{YELLOW}[warn]{NC} {m}", flush=True)


def bad(m: str) -> None:
    print(f"{RED}[fail]{NC} {m}", flush=True)


def env_any(*names: str, default: str = "") -> str:
    """First non-empty value among ``names``, else ``default``."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def truthy(value: str) -> bool:
    return str(value).strip().lower() not in ("", "0", "false", "no", "off")


NODE_HOST = env_any("CASPAR_NODE_HOST", default="127.0.0.1")
NODE_PORT = int(env_any("CASPAR_NODE_PORT", default="8074"))
# The platform's deploy operator. Redeploying onto a program id the Decillion
# manifest already records requires logging in as the account that owns it, which
# is why the historical account name is the default and not a new one.
DEPLOY_USER = env_any("CASPAR_DEPLOY_USER", "GROK_ADMIN_USER", "DAVINCI_ADMIN_USER", default="davinci_admin")
CA_BUNDLE_PATH = env_any("CASPAR_CA_BUNDLE", default="/etc/ssl/certs/ca-certificates.crt")


# --------------------------------------------------------------------------- #
# The durable deploy operator — one account for the backbone and every tool
# --------------------------------------------------------------------------- #
#
# A creature/program can only be redeployed by the account that owns it, so every
# deploy in this repo (the Grok Build agent backbone AND the sandbox + github tool
# creatures) MUST run as the *same* account across runs — otherwise a redeploy is
# refused ("access to vm denied") and the script is forced to mint a brand-new
# creature/program, which is exactly the "new programs every deploy" churn we are
# eliminating. The node's dev login is idempotent by email, but that alone is
# fragile: it depends on the node's on-chain account state surviving, and it
# silently forks a new account if the email/username ever differs. So instead of
# trusting a fresh login each run, we persist the operator identity (its user id +
# private key) once and reuse it verbatim forever after — the previous operator
# that deployed the old programs is always found again, byte for byte.


def _operator_identity_path() -> Path:
    """Where the persisted deploy-operator identity lives.

    Defaults next to the Decillion manifest (``CASPAR_MANIFEST``) so it rides the
    same durable, git-ignored location the recorded program ids do, and survives
    the ``git reset --hard`` every CI run does on the checkout."""
    explicit = env_any("CASPAR_DEPLOY_IDENTITY_FILE")
    if explicit:
        return Path(explicit)
    manifest = env_any("CASPAR_MANIFEST")
    base = Path(manifest).resolve().parent if manifest else Path.cwd()
    return base / ".caspar-deploy-operator.json"


def _read_identity(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("user_id") and data.get("private_key"):
        return data
    return None


def _write_identity(path: Path, identity: Dict[str, Any]) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(identity), encoding="utf-8")
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)  # 0600 — it carries a private key
        os.replace(tmp, path)
    except OSError as exc:  # non-fatal: the deploy still works, just not sticky
        warn(f"could not persist the deploy operator identity to {path}: {exc}")


def _looks_like_pem(s: str) -> bool:
    return "-----BEGIN" in s and "PRIVATE KEY" in s


def _resolve_operator_key(raw_key: str, b64_key: str) -> str:
    """Return a usable PEM from whatever the operator secret carries.

    CI secrets get pasted in every shape, so accept them all rather than fail on
    a formatting slip:
      * a raw PEM (real or ``\\n``-escaped newlines) in either variable — used
        as-is (authenticate() restores the line boundaries);
      * base64 of the PEM (the recommended CASPAR_OPERATOR_PRIVATE_KEY_B64) —
        decoded, tolerant of embedded whitespace and missing ``=`` padding.
    Returns "" when neither yields a PEM."""
    # 1) An already-PEM value wins — covers a PEM accidentally placed in the _B64
    #    slot (a common cause of "cannot be 1 more than a multiple of 4").
    for cand in (raw_key, b64_key):
        c = (cand or "").strip()
        if _looks_like_pem(c):
            return c
    # 2) Otherwise treat it as base64 (prefer the _B64 var). Strip whitespace,
    #    accept the URL-safe alphabet (-/_ → +//), and re-pad, so a wrapped,
    #    padding-stripped, or url-safe value still decodes. (Standard b64decode
    #    silently DROPS -/_ chars, which is what produced the "number of data
    #    characters cannot be 1 more than a multiple of 4" failure.)
    for cand in (b64_key, raw_key):
        # '+' in a base64 value frequently arrives as a SPACE — form/URL handling
        # in the secret → SSH → env chain turns '+' into ' ', and those spaces are
        # then dropped, leaving a length that is "1 more than a multiple of 4" and
        # undecodable. Recover them by mapping space→'+' BEFORE stripping the
        # remaining (wrapping) whitespace. Clean single-line base64 has no spaces,
        # so this is a no-op there.
        recovered = (cand or "").replace(" ", "+")
        compact = "".join(recovered.split())
        if not compact:
            continue
        standard = compact.replace("-", "+").replace("_", "/")
        last_exc: Optional[Exception] = None
        for variant in (standard, compact):
            try:
                decoded = base64.b64decode(variant + "=" * (-len(variant) % 4)).decode("utf-8")
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                continue
            if _looks_like_pem(decoded):
                return decoded
        if last_exc is not None:
            warn(f"an operator key value ({len(compact)} base64 chars) could not be decoded: {last_exc}")
        else:
            warn("a base64 operator key decoded but is not a PEM private key — ignoring it")
    return ""


def resolve_operator(client) -> str:
    """Authenticate ``client`` as the ONE durable deploy operator; return its id.

    Every deploy — the backbone and every tool — runs as this same account, so a
    redeploy always owns the creatures/programs it minted and never re-mints them.
    Resolution order (first hit wins):

      1. An identity injected by CI as ``CASPAR_OPERATOR_ID`` +
         ``CASPAR_OPERATOR_PRIVATE_KEY`` — lets the Nest deployer and these scripts
         share a single account explicitly.
      2. The persisted identity file (written here on the first login) — the normal
         steady state: the same account, byte for byte, on every subsequent run.
      3. A fresh ``login(DEPLOY_USER)``, whose resulting identity is then persisted
         so runs 2+ take path (2).
    """
    op_id = env_any("CASPAR_OPERATOR_ID", "CASPAR_OPERATOR_USER_ID")
    op_key = _resolve_operator_key(
        os.environ.get("CASPAR_OPERATOR_PRIVATE_KEY", ""),
        os.environ.get("CASPAR_OPERATOR_PRIVATE_KEY_B64", ""),
    )
    if op_id and op_key:
        client.authenticate(op_id, op_key)  # authenticate() normalizes PEM newlines
        ok(f"deploy operator from env: {op_id} (pinned; redeploys reuse this account and never re-mint)")
        return op_id
    if op_id and not op_key:
        # A half-configured pin is the classic cause of "still re-minting despite
        # pinning": the id is set, the key never arrived (or was unreadable), so we
        # fall back to the file/login path and drift. Make it LOUD instead of silent.
        warn(f"CASPAR_OPERATOR_ID={op_id} is set but no usable private key was provided. "
             "The pinned operator is NOT in effect — falling back to the persisted file / login, "
             "which is what causes tool programs to re-mint. Set CASPAR_OPERATOR_PRIVATE_KEY_B64 to the "
             "base64 of the PEM (base64 -w0 < operator.pem); a raw or \\n-escaped PEM is also accepted.")

    path = _operator_identity_path()
    saved = _read_identity(path)
    if saved:
        client.authenticate(saved["user_id"], saved["private_key"])
        ok(f"deploy operator restored from {path.name}: {saved['user_id']} "
           f"(username {saved.get('username') or DEPLOY_USER})")
        return saved["user_id"]

    client.login(DEPLOY_USER)
    ok(f"deploy operator logged in as {DEPLOY_USER} (user_id={client.user_id})")
    _write_identity(path, {"user_id": client.user_id, "private_key": client.priv_pem, "username": DEPLOY_USER})
    info(f"persisted the deploy operator identity to {path} — future redeploys reuse this exact account")
    return client.user_id

# The node has no true "unlimited" exec cap (`runEntity` clamps <= 0 to 60 and
# always spawns a reaper), so "unlimited" is a very large but i64-safe value.
VM_MAX_UNLIMITED = 10_000_000_000

# Label stamped into every creature image, carrying a digest of the build context
# it was built from. It is what lets a redeploy tell "the node already built this"
# from "the node has not finished building yet".
CONTEXT_LABEL = "org.decillion.build-context"

# Substituted into a Dockerfile at every `CA_MARKER` — once per build stage — so the
# egress-gateway CA is trusted both while the image installs dependencies and while
# the creature makes API calls. A host with a TLS-intercepting proxy fails every
# dependency download without it. Appended at the end for a Dockerfile with no
# marker (single-stage tool images).
CA_MARKER = "# >>> caspar-ca <<<"
CA_SNIPPET = (
    "COPY ca-certificates.crt /etc/ssl/certs/caspar-ca.crt\n"
    "ENV SSL_CERT_FILE=/etc/ssl/certs/caspar-ca.crt "
    "REQUESTS_CA_BUNDLE=/etc/ssl/certs/caspar-ca.crt "
    "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/caspar-ca.crt"
)


def b64_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode()


def b64_file(path: Path) -> str:
    return b64_bytes(path.read_bytes())


def ca_bundle_bytes() -> Optional[bytes]:
    """The host CA bundle (including any egress-gateway CA), or ``None``."""
    try:
        data = Path(CA_BUNDLE_PATH).read_bytes()
        return data if data.strip() else None
    except OSError:
        return None


def apply_ca(dockerfile: bytes, files: Dict[str, str]) -> bytes:
    """Ship the host CA bundle into the context and trust it in every stage."""
    ca = ca_bundle_bytes()
    if ca is None:
        warn("no host CA bundle found — the image will trust only its own roots")
        return dockerfile
    files["ca-certificates.crt"] = b64_bytes(ca)
    if CA_MARKER.encode() in dockerfile:
        return dockerfile.replace(CA_MARKER.encode(), CA_SNIPPET.encode())
    return dockerfile + b"\n" + CA_SNIPPET.encode() + b"\n"


def bake_snippet(env: Dict[str, str]) -> str:
    """A Dockerfile ``ENV`` line baking key=value pairs into the image.

    Credentials are baked into the image rather than sent in a signal, so nothing
    an agent's prompt can influence ever carries them.
    """
    parts = []
    for key, value in env.items():
        if value == "":
            continue
        escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
        parts.append(f'{key}="{escaped}"')
    return ("ENV " + " ".join(parts) + "\n") if parts else ""


def context_digest(dockerfile: bytes, files_b64: Dict[str, str]) -> str:
    """sha256 over the whole build context (Dockerfile + every shipped file)."""
    h = hashlib.sha256()
    h.update(dockerfile)
    for name in sorted(files_b64 or {}):
        h.update(name.encode())
        h.update(files_b64[name].encode())
    return h.hexdigest()


def stamp_context(dockerfile: bytes, files_b64: Dict[str, str]) -> Tuple[bytes, str]:
    """Append the context LABEL to a Dockerfile. Returns (dockerfile, digest)."""
    digest = context_digest(dockerfile, files_b64)
    return dockerfile + f'\nLABEL {CONTEXT_LABEL}="{digest}"\n'.encode(), digest


def image_tag(program_id: str, entity_id: str) -> str:
    return f"{program_id.replace('@', '_')}/{entity_id}"


def docker_image_id(program_id: str, entity_id: str) -> str:
    """Current image id for a program/entity tag, or "" (also when docker is unreachable)."""
    try:
        out = subprocess.run(["docker", "images", "--no-trunc", "--format", "{{.ID}}", image_tag(program_id, entity_id)],
                             capture_output=True, text=True, timeout=15)
        lines = [line.strip() for line in out.stdout.splitlines() if line.strip()]
        return lines[0] if lines else ""
    except Exception:  # noqa: BLE001 — the deployer does not always share the node's docker socket
        return ""


def docker_image_context(program_id: str, entity_id: str) -> str:
    """The context digest baked into the current image, or "" when absent."""
    try:
        out = subprocess.run(
            ["docker", "inspect", "--format", '{{index .Config.Labels "' + CONTEXT_LABEL + '"}}',
             image_tag(program_id, entity_id)],
            capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def wait_for_image(program_id: str, entity_id: str, *, timeout: int,
                   prev_image_id: str = "", expect_context: str = "") -> bool:
    """Wait until the node has (re)built the entity's image.

    The node builds asynchronously and only re-tags on success, so on a redeploy the
    old tag is present the whole time — waiting for the context digest to appear is
    what makes this both correct and terminating (an unchanged context is already
    satisfied, so a no-op rebuild returns at once).
    """
    tag = image_tag(program_id, entity_id)
    deadline = time.time() + timeout
    info(f"waiting for the node to build image {tag} (≤{timeout}s)…")
    while time.time() < deadline:
        if expect_context and docker_image_context(program_id, entity_id) == expect_context:
            ok(f"image built from the deployed context: {tag}")
            return True
        current = docker_image_id(program_id, entity_id)
        if prev_image_id and current and current != prev_image_id:
            ok(f"image rebuilt: {tag} -> {current[:19]}")
            return True
        if not prev_image_id and not expect_context and current:
            ok(f"image present: {tag}")
            return True
        time.sleep(3)
    warn(f"image {tag} did not appear/change within {timeout}s — proceeding with the current image; "
         "check the node's build logs if the entity misbehaves (a host that cannot query docker "
         "always reports empty here, which must not fail an otherwise fine deploy)")
    return True


def vm_max_seconds(*names: str, default: str = "unlimited") -> int:
    """Resolve a VM exec cap from the environment; "unlimited" → the i64-safe max."""
    raw = env_any(*names, default=default).lower()
    if raw in ("0", "-1", "none", "inf", "infinite", "unlimited", "immortal", "forever"):
        return VM_MAX_UNLIMITED
    try:
        value = int(raw)
    except ValueError:
        return VM_MAX_UNLIMITED
    return VM_MAX_UNLIMITED if value <= 0 else value


def vm_label(max_seconds: int) -> str:
    return "unlimited (~317y)" if max_seconds == VM_MAX_UNLIMITED else f"{max_seconds}s"
