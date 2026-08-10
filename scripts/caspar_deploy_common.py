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
from typing import Any, Dict, Optional, Tuple, List

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

# --------------------------------------------------------------------------- #
# Deterministic docker-tool program: discover-or-create, never re-mint
# --------------------------------------------------------------------------- #
#
# A docker tool creature (the per-space sandbox, the github tool) must land on the
# SAME program across deploys, or every space that added it ends up pointing at a
# dead id. The reliable way to guarantee that is the one the Nest deployer already
# uses for its WASM endpoints — and the reason those never churn: give the tool's
# machine creature a STABLE username and re-find it by that username each run,
# rather than trusting a recorded program id that a node reset can strand under a
# different owner.
#
# There is deliberately NO re-mint fallback. With one operator that owns what it
# created, a redeploy always finds its own machine. A stable-named machine owned
# by someone else is a real misconfiguration (two operators, or a hand-minted
# program) — we fail loudly so it gets fixed, instead of silently minting an
# ever-climbing new id every deploy (the churn this replaces).


def ensure_docker_program(
    client,
    operator_id: str,
    *,
    machine_name: str,
    program_path: str,
    comment: str,
) -> Tuple[str, str]:
    """Resolve ``(creature_id, program_id)`` for a docker tool, deterministically.

    * Re-find the tool's machine by its stable username; reuse its docker program.
    * Create the machine + program only when it does not exist yet (first deploy /
      a freshly-reproduced node).
    * Never re-mint: a stable-named machine owned by a different account is fatal.
    """
    source = operator_id.split("@", 1)[1] if "@" in operator_id else "global"
    username = f"{machine_name}@{source}"
    # Re-find the machine by enumerating creatures and matching the unqualified
    # local part — getByUsername can't (the node stores + uniquely indexes the
    # username qualified with its own source, which getByUsername doesn't match),
    # so a redeploy would miss the machine it already owns and then collide on
    # create with "creature username already exists". Prefer an operator-owned
    # match; remember a foreign-owned one so the ownership guard below can report
    # it clearly. Fall back to the raw getByUsername probe only if listing fails.
    want = machine_name[:32]
    existing = None
    foreign = None
    try:
        for c in client.list_creatures():
            uname = str(c.get("username") or "")
            if uname.split("@", 1)[0] != want and uname != want:
                continue
            cid = str(c.get("id") or "")
            if not cid:
                continue
            owner = str(c.get("ownerId") or c.get("owner_id") or "")
            entry = {"id": cid, "ownerId": owner}
            if owner == operator_id:
                existing = entry
                break
            foreign = foreign or entry
    except Exception:  # noqa: BLE001 — fall through to the raw probe
        existing = None
    if existing is None:
        existing = foreign or client.get_by_username(username) or client.get_by_username(want)
    if existing:
        creature_id = str(existing.get("id") or "")
        owner = str(existing.get("ownerId") or existing.get("owner_id") or "")
        if owner != operator_id:
            raise RuntimeError(
                f"machine {username} exists but is owned by {owner!r}, not the deploy operator "
                f"{operator_id!r}. Refusing to re-mint. Deploy as the owning operator (one operator for "
                f"the backbone and every tool), or wipe the node so its state is reproduced under it."
            )
        for prog in client.list_programs():
            if str(prog.get("machineId") or prog.get("machine_id") or "") == creature_id:
                program_id = str(prog.get("id") or "")
                if program_id:
                    info(f"reusing {machine_name}: creature {creature_id} program {program_id} (owned by operator)")
                    return creature_id, program_id
        # The machine exists but carries no program yet (an interrupted first
        # deploy) — add the program to the machine we already own.
        program_id = client.create_program(creature_id, program_path, "docker", comment)
        info(f"reusing machine {creature_id}, created its program {program_id}")
        return creature_id, program_id
    creature_id = client.create_machine_creature(machine_name)
    program_id = client.create_program(creature_id, program_path, "docker", comment)
    info(f"created machine creature {creature_id} and program {program_id} (first deploy of {machine_name})")
    return creature_id, program_id


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


# ── on-chain platform-tool registry (market creature) ────────────────────────
# A platform tool (the per-space sandbox, the github tool) is announced into the
# `market` creature's on-chain `platform` bucket at DEPLOY time — by the operator
# that just deployed it, the "whoever deploys a tool registers it" mechanism — so
# nothing about which tools exist is stored or seeded by the running Nest server.
# `spaces/create` reads that bucket to attach every `autoAttach` tool to new
# spaces, and the client's addable-tools list reads it via `market/listPlatform`.
# register/unregister/list are three separate WASM endpoints sharing one on-chain
# bucket; each is resolved from the manifest by its `<ns>/<action>` key.

# The descriptor fields the discovery/planning layer reads back — the same subset
# Nest's `descriptor.fromMetadata` produced, so the on-chain entry is identical
# whether it was written by the old boot seeder or by this deploy path.
_DESCRIPTOR_FIELDS = (
    "kind", "name", "username", "avatar", "pricing", "category", "usecases",
    "howToTalk", "argSchema", "requiredArgs", "function", "functions", "tools",
    "maxExecSeconds", "outputSchema", "skill", "requiresNetwork", "risk",
)


def load_manifest() -> Dict[str, Any]:
    """The Decillion deploy manifest (``CASPAR_MANIFEST``) as a dict, or ``{}``."""
    path = env_any("CASPAR_MANIFEST")
    if not path:
        return {}
    try:
        return json.loads(Path(path).read_text())
    except Exception:  # noqa: BLE001
        return {}


def manifest_endpoint(manifest: Dict[str, Any], key: str) -> Optional[Dict[str, str]]:
    """The ``{creatureId, programId, entityId}`` record for a per-route endpoint
    (e.g. ``market/registerPlatform``), or ``None`` when the manifest lacks it."""
    eps = manifest.get("endpoints") if isinstance(manifest, dict) else None
    rec = eps.get(key) if isinstance(eps, dict) else None
    return rec if isinstance(rec, dict) and rec.get("programId") else None


def normalize_descriptor(meta: Dict[str, Any]) -> Dict[str, Any]:
    """The tool's ``point.metadata.json`` reduced to the discovery descriptor —
    the exact subset ``descriptor.fromMetadata`` keeps (nested ``decillion`` block
    unwrapped when present, else the flat metadata itself)."""
    if not isinstance(meta, dict):
        return {}
    d = meta
    pub = meta.get("public")
    if isinstance(pub, dict) and isinstance(pub.get("decillion"), dict):
        d = pub["decillion"]
    elif isinstance(meta.get("decillion"), dict):
        d = meta["decillion"]
    out: Dict[str, Any] = {}
    for f in _DESCRIPTOR_FIELDS:
        if d.get(f) is not None:
            out[f] = d[f]
    out.setdefault("usecases", d.get("usecases") or [])
    out.setdefault("howToTalk", d.get("howToTalk") or "")
    return out


def register_platform_tool(client, manifest: Dict[str, Any], *, key: str,
                           program_id: str, creature_id: str, entity_id: str,
                           metadata: Dict[str, Any]) -> bool:
    """Announce a just-deployed platform tool into the market creature's registry,
    then VERIFY it landed. Returns True only when a follow-up ``listPlatform`` shows
    the program — so an untested-against-a-live-node signal fails LOUDLY at deploy
    time instead of silently leaving new spaces without the tool.

    Best-effort about the *manifest*: with no ``market/registerPlatform`` endpoint
    (a node that predates the split market endpoints) it warns and returns False,
    leaving the tool deployed but unregistered — the caller decides whether that is
    fatal."""
    reg = manifest_endpoint(manifest, "market/registerPlatform")
    if not reg:
        warn("no market/registerPlatform endpoint in the manifest — cannot register "
             f"the {key} platform tool on-chain (is the market creature deployed?)")
        return False
    d = normalize_descriptor(metadata)
    display = str(d.get("name") or key)
    auto_attach = bool(d.get("autoAttach") if "autoAttach" in d else metadata.get("autoAttach", False))
    payload = {
        "key": key,
        "name": display,
        "programId": program_id,
        "creatureId": creature_id,
        "entityId": entity_id or key,
        "autoAttach": auto_attach,
        "descriptor": d,
    }
    res = client.signal_wasm_endpoint(
        creature_id=reg["creatureId"], program_id=reg["programId"],
        action="registerPlatform", payload=payload,
    )
    if not res.get("ok"):
        warn(f"registerPlatform signal for {key} did not confirm: {res.get('error') or res}")
        # fall through to the verify — the write may have applied even if the reply
        # was missed; only a listPlatform miss is treated as failure.
    if platform_registered(client, manifest, program_id):
        ok(f"registered platform tool {key} (program {program_id}, autoAttach={auto_attach})")
        return True
    warn(f"platform tool {key} is NOT in the on-chain registry after registerPlatform "
         f"(program {program_id}) — new spaces will not attach it until this is fixed")
    return False


def platform_registered(client, manifest: Dict[str, Any], program_id: str) -> bool:
    """Whether ``program_id`` appears in the market creature's ``platform`` bucket."""
    for row in list_platform_registry(client, manifest):
        if str(row.get("programId") or "") == program_id:
            return True
    return False


def list_platform_registry(client, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The current on-chain platform bucket as a list of entry dicts (or ``[]``)."""
    lp = manifest_endpoint(manifest, "market/listPlatform")
    if not lp:
        return []
    res = client.signal_wasm_endpoint(
        creature_id=lp["creatureId"], program_id=lp["programId"],
        action="listPlatform", payload={},
    )
    result = res.get("result") if isinstance(res, dict) else None
    rows = result.get("platform") if isinstance(result, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def reconcile_platform_registry(client, manifest: Dict[str, Any],
                                current_program_ids: List[str]) -> None:
    """Remove any stale entry whose programId is not among the currently-deployed
    tools — a churned id, or the old Nest backend that used to be registered here.
    Guarded on a non-empty current set so a failed list can never wipe the registry.

    This is the reconcile the Nest boot seeder used to do; it belongs to the deploy
    (which knows exactly which tools it just deployed) now that seeding does."""
    current = {p for p in current_program_ids if p}
    if not current:
        warn("platform reconcile skipped — no current tool program ids to compare against")
        return
    unreg = manifest_endpoint(manifest, "market/unregisterPlatform")
    if not unreg:
        return
    for row in list_platform_registry(client, manifest):
        pid = str(row.get("programId") or "")
        if not pid or pid in current:
            continue
        res = client.signal_wasm_endpoint(
            creature_id=unreg["creatureId"], program_id=unreg["programId"],
            action="unregisterPlatform", payload={"programId": pid},
        )
        label = row.get("key") or row.get("name") or pid
        if res.get("ok") or not platform_registered(client, manifest, pid):
            ok(f"unregistered stale platform entry {label} (program {pid})")
        else:
            warn(f"could not unregister stale platform entry {label} (program {pid}): "
                 f"{res.get('error') or res}")


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
    """The image tag a program/entity *would* have if tags were keyed by program.

    They are NOT. The node builds and runs `<machine_id>/<entity_id>` — see caspar's
    `vms/docker/src/controller.rs::docker_image_ref`, which takes the **machine
    (creature) id**, not the program id. Those differ (a creature minted as
    `8@global` gets program `10@global`), and a redeploy onto an existing program
    does not even know the machine id: it was minted on the *first* deploy.

    So this is only a display/fallback hint. Anything that must actually FIND the
    image goes through the context-digest label instead (`images_with_context`),
    which is exact and needs no id mapping at all.
    """
    return f"{program_id.replace('@', '_')}/{entity_id}"


def images_with_context(digest: str) -> List[str]:
    """Image tags carrying our context-digest label — the reliable way to find one.

    Every Dockerfile this repo deploys is stamped with `LABEL <CONTEXT_LABEL>=
    <digest>` (see `stamp_context`), so asking docker for images with that exact
    label answers "has the node finished building MY context?" without knowing how
    the image is named. Matching on the tag instead is what made every build wait
    burn its full timeout: the tag we guessed never existed.
    """
    cli = docker_cli()
    if not cli or not digest:
        return []
    try:
        out = subprocess.run(
            [*cli, "images", "--filter", f"label={CONTEXT_LABEL}={digest}", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True, text=True, timeout=15)
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except Exception:  # noqa: BLE001
        return []


def image_built_for_context(digest: str) -> bool:
    """True when an image built from exactly this context already exists."""
    return bool(images_with_context(digest))


# How this process talks to docker, resolved once. The node builds creature images
# on its own docker daemon; this script only *observes* that. On a host where the
# deploy user is not in the docker group the plain CLI fails, and every observation
# silently returns "" — which used to mean the build wait burned its whole timeout
# on every deploy and then warned about an image it was never able to see.
_DOCKER_CLI: Optional[List[str]] = None
_DOCKER_PROBED = False


def docker_cli() -> Optional[List[str]]:
    """The docker command this process can actually use, or None if there is none."""
    global _DOCKER_CLI, _DOCKER_PROBED  # noqa: PLW0603 — a process-wide probe, done once
    if _DOCKER_PROBED:
        return _DOCKER_CLI
    _DOCKER_PROBED = True
    for candidate in (["docker"], ["sudo", "-n", "docker"]):
        try:
            out = subprocess.run([*candidate, "version", "--format", "{{.Server.Version}}"],
                                 capture_output=True, text=True, timeout=15)
            if out.returncode == 0:
                _DOCKER_CLI = candidate
                return _DOCKER_CLI
        except Exception:  # noqa: BLE001 — try the next way in
            continue
    return None


def docker_image_id(program_id: str, entity_id: str) -> str:
    """Current image id for a program/entity tag, or "" (also when docker is unreachable)."""
    cli = docker_cli()
    if not cli:
        return ""
    try:
        out = subprocess.run([*cli, "images", "--no-trunc", "--format", "{{.ID}}", image_tag(program_id, entity_id)],
                             capture_output=True, text=True, timeout=15)
        lines = [line.strip() for line in out.stdout.splitlines() if line.strip()]
        return lines[0] if lines else ""
    except Exception:  # noqa: BLE001 — the deployer does not always share the node's docker socket
        return ""


def docker_image_context(program_id: str, entity_id: str) -> str:
    """The context digest baked into the current image, or "" when absent."""
    cli = docker_cli()
    if not cli:
        return ""
    try:
        out = subprocess.run(
            [*cli, "inspect", "--format", '{{index .Config.Labels "' + CONTEXT_LABEL + '"}}',
             image_tag(program_id, entity_id)],
            capture_output=True, text=True, timeout=15)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:  # noqa: BLE001
        return ""


def build_log_lines(client) -> List[str]:
    """The node's docker BUILD output.

    The runtime emits image-build output before any VM exists, onto a node-wide
    stream: vm id ``main``, log type ``build`` (see the docker plugin's
    ``emit_vm_log`` calls, and the readVmLogs handler which deliberately leaves
    build streams readable by any authenticated user). That is the only place the
    reason for a failed or slow build is written — polling for the image only ever
    says "still not there".
    """
    if client is None:
        return []
    try:
        from caspar_signaling import log_text  # local import: same directory

        return [log_text(entry).rstrip() for entry in client.read_vm_logs("main", "build", count=400)]
    except Exception:  # noqa: BLE001 — diagnostics must never break a deploy
        return []


# Lines that mean the build is over and failed. The plugin turns a bollard build
# error into `docker build failed: …` after echoing the daemon's own message.
_BUILD_FAILURE_MARKERS = ("docker build failed", "failed to solve", "returned a non-zero code")


def wait_for_image(program_id: str, entity_id: str, *, timeout: int,
                   prev_image_id: str = "", expect_context: str = "", client=None) -> bool:
    """Wait until the node has (re)built the entity's image.

    The node builds asynchronously and only re-tags on success, so on a redeploy the
    old tag is present the whole time — waiting for the context digest to appear is
    what makes this both correct and terminating (an unchanged context is already
    satisfied, so a no-op rebuild returns at once).
    """
    tag = image_tag(program_id, entity_id)
    if not docker_cli():
        # Polling would ask a docker this process cannot talk to, get "" every time,
        # and burn the entire timeout before warning about an image it never had a
        # way to see. Say so once and move on: the entity's readiness check (its
        # first log line) is the real evidence that the build produced something
        # runnable, and it costs minutes instead of a quarter of an hour.
        warn(f"cannot query docker from this process, so the node's build of {tag} is not observable here "
             "— skipping the image wait (add this user to the docker group, or allow passwordless sudo, "
             "to get build observability back). The entity's readiness check is the real signal.")
        return True
    started = time.time()
    deadline = started + timeout
    info(f"waiting for the node to build image {tag} (≤{timeout}s)…")
    # A silent 15-minute wait is indistinguishable from a hung deploy — and that is
    # exactly what this looked like from the CI log. Report progress while waiting.
    heartbeat = float(env_any("CASPAR_WAIT_HEARTBEAT_SECS", default="30")) or 30.0
    next_beat = started + heartbeat
    # Echo the node's own build output as it happens. This is the difference
    # between "10 minutes and no progress" and watching the base image pull, the
    # apt install and the bundle download go by — or seeing exactly which step
    # failed, immediately, instead of at the end of a 900s timeout.
    printed = 0
    while time.time() < deadline:
        lines = build_log_lines(client)
        if len(lines) < printed:  # the stream rotated; resync rather than skip
            printed = 0
        for line in lines[printed:]:
            if line:
                print(f"    build | {line[:400]}", flush=True)
        printed = len(lines)
        failure = next((line for line in lines if any(m in line.lower() for m in _BUILD_FAILURE_MARKERS)), "")
        if failure:
            bad(f"the node's image build FAILED: {failure[:400]}")
            bad("the container will keep running whatever image it had before this deploy")
            return False
        if expect_context:
            built = images_with_context(expect_context)
            if built:
                ok(f"image built from the deployed context: {', '.join(built[:3])}")
                return True
        current = docker_image_id(program_id, entity_id)
        if prev_image_id and current and current != prev_image_id:
            ok(f"image rebuilt: {tag} -> {current[:19]}")
            return True
        if not prev_image_id and not expect_context and current:
            ok(f"image present: {tag}")
            return True
        now = time.time()
        if now >= next_beat:
            info(f"  … still building {tag} — {int(now - started)}s elapsed of {timeout}s "
                 f"(the node builds asynchronously; this only watches)")
            next_beat = now + heartbeat
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
