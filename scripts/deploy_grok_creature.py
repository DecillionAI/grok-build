#!/usr/bin/env python3
"""Deploy Grok Build onto a running Caspar node as a `docker` creature entity.

The creature is the signaling bridge in `caspar/` plus the Grok Build CLI: the
node builds the image, starts one long-lived container, and the container serves
every prompt the Decillion backend signals it (see `caspar/README.md`).

It is the platform's **agent backbone** — the program every Decillion agent proxy
forwards its prompts to. It speaks the wire contract the davinci agent creature
spoke (`davinci/step` / `davinci/result`, the `davinci.agent` manifest slot), so
it is a drop-in replacement for whatever backbone the manifest already points at.

What this script does, in order:

  1. log in to the node as the deploy operator (the SAME account that owns the
     program being reused — a program can only be redeployed by its owner);
  2. gzip-tar the build context — just the `caspar/` bridge by default (~200 KB),
     or this repo's Rust source in `source` mode;
  3. compose the Dockerfile: `caspar/Dockerfile.fetch` (stamped with the published
     bundle's URL + commit) or `caspar/Dockerfile`, plus the host CA bundle, the
     baked env (the xAI credentials, never written to disk here) and a
     context-digest LABEL;
  4. deploy the entity — onto an EXISTING program id when one is given, so
     already-deployed agent proxies keep pointing at a valid backbone;
  5. wait for the node to finish building the image (by watching for the digest
     LABEL, so a fully-cached rebuild does not burn the whole timeout);
  6. `runEntity` with `forceRestart`, so the new image actually runs.

Environment
-----------
Connection (plaintext TCP, matching the local `casparctl` node):
    CASPAR_NODE_HOST        node host                     (default 127.0.0.1)
    CASPAR_NODE_PORT        node TCP port                 (default 8074)
    CASPAR_CA_BUNDLE        host CA bundle baked into the image for egress TLS
                            (default /etc/ssl/certs/ca-certificates.crt)
    CASPAR_DEPLOY_IDENTITY_FILE  persisted deploy-operator identity, shared with
                            every tool deploy so a redeploy reuses the same account
                            and program (default: next to CASPAR_MANIFEST)
    CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY  inject the operator explicitly
    CASPAR_DEPLOY_USER      first-login username only      (default davinci_admin)

Program / entity:
    GROK_REUSE_PROGRAM_ID   redeploy onto this existing program (no new creature)
    GROK_ENTITY_ID          entity id                    (default davinci)
    GROK_STOP_PROGRAM_ID    stop mode: stop this program's entity and exit
    DAVINCI_* equivalents are accepted for every one of the three above, so this
    script is a drop-in for the davinci deploy entrypoint the Decillion CI calls.

Grok backbone (baked into the image; read from this environment only):
    XAI_API_KEY / GROK_CODE_XAI_API_KEY
    GROK_CREATURE_MODEL, GROK_CREATURE_LLM_* (a non-xAI default backbone)

Agent build:
    GROK_CLI_SOURCE         prebuilt (default: the IMAGE downloads the bundle this
                            repo's build-grok-creature workflow published —
                            caspar/Dockerfile.fetch; nothing is compiled anywhere)
                            | source (compile crates/ inside the image; its context
                              exceeds what a deploy signal can carry, see below)
                            | release (the image downloads the published x.ai CLI)
    GROK_BUNDLE_URL         the bundle to download. Derived when unset from this
                            checkout's origin remote + branch:
                            .../releases/download/creature-<branch>/bundle.tar.gz
    GROK_BUNDLE_REPO / GROK_BUNDLE_BRANCH  override just those parts of the URL
    GROK_BUNDLE_TOKEN       bearer token, only for a private backbone repo (the
                            NODE must be able to fetch the URL too, so prefer a
                            publicly readable asset)
    GROK_MAX_DEPLOY_MB      refuse a payload over this (default 16). A deploy is
                            ONE frame and caspar caps it at 20 MB; an oversized
                            frame is answered by closing the socket, which reaches
                            the deployer as a bare "[Errno 32] Broken pipe". This
                            is why the ~170 MB binary is fetched by the image
                            rather than shipped in the payload.
    GROK_RUNTIME_BASE       runtime image base (default node:22-trixie-slim via ECR)

VM:
    GROK_RUN_ENTITY         1 to start the VM after deploy (default), 0 to skip
    GROK_WAIT_READY         1 to wait for the creature's GROK_READY line (default)
    GROK_READY_TIMEOUT      seconds to wait for it (default 180, or 600 when the
                            image build could not be observed from this host)
    GROK_RESTART_ON_NOT_READY  1 (default) to restart the entity once if it never
                            reported ready — the node builds asynchronously, so a
                            container started mid-build runs the PREVIOUS image and
                            only a restart picks up the new one
    GROK_VM_RAM_MB          default 2048     GROK_VM_DISK_GB   default 8
    GROK_VM_CPUS            default 2        GROK_VM_MAX_SECONDS default unlimited
    GROK_FORCE_RESTART      default 1
    GROK_REBUILD_TIMEOUT    image build wait, seconds (default 900; a `source`
                            build of the whole workspace needs far more)

Output (stdout, machine-readable — the CI greps these):
    DAVINCI_PROGRAM_ID=<id>     GROK_PROGRAM_ID=<id>
    DAVINCI_ENTITY_ID=<id>      GROK_ENTITY_ID=<id>
    DAVINCI_VM_ID=<vmId>        GROK_VM_ID=<vmId>
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.request
from pathlib import Path
from typing import Dict, Tuple

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    NODE_HOST,
    NODE_PORT,
    apply_ca,
    b64_bytes,
    bad,
    bake_snippet,
    docker_cli,
    docker_image_context,
    docker_image_id,
    env_any,
    info,
    ok,
    resolve_operator,
    stamp_context,
    truthy,
    vm_label,
    vm_max_seconds,
    wait_for_image,
    warn,
)
from caspar_signaling import CasparSignalingClient, log_text  # noqa: E402

ENTITY_ID = env_any("GROK_ENTITY_ID", "DAVINCI_ENTITY_ID", "CLAUDE_ENTITY_ID", default="davinci")

# Where the agent's binary comes from:
#   prebuilt (default) the IMAGE downloads the bundle this repo's
#                      `build-grok-creature` workflow published (caspar/Dockerfile.fetch);
#   source            compile this repo's crates/ inside the image;
#   release           the image downloads the published x.ai CLI.
CLI_SOURCES = ("prebuilt", "source", "release")

# How big a deploy payload the node will accept. A deploy is ONE length-prefixed
# frame; caspar caps it (network/framing.rs MAX_FRAME_LEN = 20 MB, and the TCP
# client path at 32 MB) and simply closes the connection when a frame is over —
# which surfaces here as `[Errno 32] Broken pipe`, with nothing explaining why. So
# the payload is checked before it is sent, well under the smaller cap.
MAX_PAYLOAD_MB = int(env_any("GROK_MAX_DEPLOY_MB", default="16"))


def resolve_cli_source() -> str:
    mode = env_any("GROK_CLI_SOURCE", "CLAUDE_CODE_CLI_SOURCE", default="prebuilt").lower()
    # The old backbone spelled its in-image compile "source" and its download path
    # "npm"; map that so an unchanged CI keeps working.
    if mode == "npm":
        mode = "release"
    if mode not in CLI_SOURCES:
        warn(f"unknown GROK_CLI_SOURCE={mode!r} — falling back to 'prebuilt'")
        mode = "prebuilt"
    return mode


def git_output(*args: str) -> str:
    try:
        import subprocess

        out = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, timeout=30)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:  # noqa: BLE001 — a missing/odd checkout just means "derive nothing"
        return ""


def bundle_url() -> str:
    """The published bundle the image will download.

    Explicit `GROK_BUNDLE_URL` wins. Otherwise it is derived from this checkout:
    the origin remote's `owner/repo` and the branch it is on, which is exactly what
    the `build-grok-creature` workflow publishes as `creature-<branch>`.
    """
    explicit = env_any("GROK_BUNDLE_URL", default="")
    if explicit:
        return explicit
    remote = env_any("GROK_BUNDLE_REPO", default="") or git_output("remote", "get-url", "origin")
    branch = env_any("GROK_BUNDLE_BRANCH", "AGENT_BRANCH", default="") or git_output("rev-parse", "--abbrev-ref", "HEAD")
    path = re.sub(r"^[a-z]+://[^/]+/", "", remote or "").removesuffix(".git")
    path = re.sub(r"^git@[^:]+:", "", path)
    if not path:
        return ""
    slug = (branch or "main").replace("/", "-")
    return f"https://github.com/{path}/releases/download/creature-{slug}/bundle.tar.gz"


def bundle_sha(url: str) -> str:
    """The commit the published bundle was built from, for the image's cache key.

    Best-effort: the manifest sits next to the bundle. Without it the build still
    works — it just cannot tell a refreshed bundle at the same URL from the one it
    already cached, so the label falls back to a timestamp.
    """
    if not url.endswith("bundle.tar.gz"):
        return ""
    manifest_url = url[: -len("bundle.tar.gz")] + "manifest.json"
    request = urllib.request.Request(manifest_url)
    token = env_any("GROK_BUNDLE_TOKEN", default="")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            data = json.loads(response.read().decode("utf-8"))
        return str(data.get("gitSha") or "")
    except Exception as exc:  # noqa: BLE001 — advisory only
        warn(f"could not read the bundle manifest ({exc}); the image cannot cache-key on the bundle's commit")
        return ""


# The backbone credentials + runtime knobs to bake into the image. Read from this
# host's environment only — never written to the repo, never sent in a signal.
BAKE_ENV_NAMES = (
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "GROK_CREATURE_MODEL",
    "GROK_CREATURE_PERMISSION_MODE",
    "GROK_CREATURE_MAX_WALL_SECONDS",
    "GROK_CREATURE_MAX_TURNS",
    "GROK_CREATURE_TOOL_TIMEOUT",
    "GROK_CREATURE_TASK_WAIT",
    "GROK_CREATURE_TRACE_ALL",
    "GROK_CREATURE_STREAM_STEPS",
    "GROK_CREATURE_HISTORY_TURNS",
    "GROK_CREATURE_USER",
    "GROK_CREATURE_FORCE_SANDBOX_FS",
    "GROK_CREATURE_DISALLOWED_TOOLS",
    "GROK_CREATURE_DISCOVER_TOOLS",
    "GROK_CREATURE_AUTH_FILE",
)

# A deploy host's proxy is usually a *loopback* proxy, which inside the creature's
# network namespace points at nothing — so proxying is opt-in, never inherited.
PROXY_ENV_NAMES = ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy")


def bake_env() -> Dict[str, str]:
    """The Grok credentials/knobs to bake into the creature image."""
    names = list(BAKE_ENV_NAMES)
    if truthy(os.environ.get("GROK_BAKE_PROXY", "")):
        names += list(PROXY_ENV_NAMES)
    env = {name: os.environ[name].strip() for name in names if os.environ.get(name, "").strip()}
    # A default (non-xAI) backbone for agents that bring no provider of their own:
    # the same {provider, model, api_key} shape a per-agent override uses, so the
    # creature serves it through exactly one code path.
    provider = env_any("GROK_CREATURE_LLM_PROVIDER", default="")
    api_key = env_any("GROK_CREATURE_LLM_API_KEY", default="")
    if provider and api_key:
        env["GROK_CREATURE_LLM_PROVIDER"] = provider
        env["GROK_CREATURE_LLM_API_KEY"] = api_key
        for name in ("GROK_CREATURE_LLM_MODEL", "GROK_CREATURE_LLM_BASE_URL"):
            value = env_any(name, default="")
            if value:
                env[name] = value
    for name in PROXY_ENV_NAMES:
        value = env.get(name, "")
        if value and ("127.0.0.1" in value or "localhost" in value):
            warn(f"{name} points at loopback ({value}) — inside the creature that address is not the proxy; "
                 "unset GROK_BAKE_PROXY or give the proxy an address reachable from the docker network")
    return env


# Directories/files of this repo that go into the image build context in `source`
# mode. The agent is COMPILED FROM THIS SOURCE inside the image (see
# caspar/Dockerfile); target/, docs and the vendored notices are not needed to
# build it, so they stay out of a payload that travels over a signal.
CONTEXT_TREES = ("crates", "prod", "bin", "third_party", "caspar", ".cargo")
CONTEXT_FILES = ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "clippy.toml", "rustfmt.toml", "SOURCE_REV")
CONTEXT_EXCLUDE_SUFFIXES = (".map", ".log")
CONTEXT_EXCLUDE_DIRS = {"__pycache__", "node_modules", ".git", "target", "docs"}


def _tar_filter(entry: tarfile.TarInfo):
    parts = set(entry.name.split("/"))
    if parts & CONTEXT_EXCLUDE_DIRS:
        return None
    if entry.name.endswith(CONTEXT_EXCLUDE_SUFFIXES):
        return None
    # Deterministic metadata: the context digest must not change just because a
    # file was checked out at a different time or by a different user.
    entry.uid = entry.gid = 0
    entry.uname = entry.gname = "root"
    entry.mtime = 0
    return entry


def bundle_tar_gz() -> bytes:
    """Gzip a tar of the build context.

    This travels inside a deploy signal, so it has to stay small (see
    MAX_PAYLOAD_MB). In `prebuilt` and `release` mode it is just the ~200 KB
    signaling bridge — the agent binary is downloaded by the image build itself.
    `source` mode ships the whole Rust workspace, which is far over that limit on
    this repo and is why it is neither the default nor generally usable here.
    `ADD bundle.tar.gz` unpacks it in the image.
    """
    mode = resolve_cli_source()

    buf = io.BytesIO()
    # mtime=0 keeps the gzip header (and therefore the context digest) stable.
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        tar.gzip_mtime = 0  # type: ignore[attr-defined]  (documented no-op on old pythons)
        caspar_root = REPO / "caspar"
        if mode in ("prebuilt", "release"):
            what = "the published bundle" if mode == "prebuilt" else "the published grok binary"
            info(f"shipping only the signaling bridge — the image downloads {what}")
            for path in sorted(p for p in caspar_root.rglob("*") if p.is_file()):
                tar.add(path, arcname=str(path.relative_to(REPO)), filter=_tar_filter)
        else:
            for tree in CONTEXT_TREES:
                root = REPO / tree
                if not root.exists():
                    continue
                for path in sorted(p for p in root.rglob("*") if p.is_file()):
                    tar.add(path, arcname=str(path.relative_to(REPO)), filter=_tar_filter)
            for name in CONTEXT_FILES:
                path = REPO / name
                if path.exists():
                    tar.add(path, arcname=name, filter=_tar_filter)
    return buf.getvalue()


def compose_dockerfile(files: Dict[str, str]) -> Tuple[bytes, str]:
    """The image's Dockerfile: repo file + build mode + CA + baked env + label."""
    cli_source = resolve_cli_source()
    mode_blurb = {
        "prebuilt": " (the image downloads the bundle this repo's workflow published)",
        "source": " (compiling crates/ inside the image — slow; expect tens of minutes)",
        "release": " (downloading the published grok binary)",
    }[cli_source]
    info(f"agent build mode: {cli_source}{mode_blurb}")

    dockerfile_name = "Dockerfile.fetch" if cli_source == "prebuilt" else "Dockerfile"
    dockerfile = (REPO / "caspar" / dockerfile_name).read_bytes()

    if cli_source == "prebuilt":
        # The binary cannot ride the deploy signal (it is ~170 MB), so the image
        # fetches it. Everything the build needs to do that is stamped in here.
        url = bundle_url()
        if not url:
            bad("GROK_CLI_SOURCE=prebuilt, but no bundle URL could be determined. "
                "Set GROK_BUNDLE_URL, or run from a checkout whose origin remote and branch "
                "name the published creature-<branch> release.")
            raise SystemExit(2)
        sha = bundle_sha(url) or f"unknown-{int(time.time())}"
        info(f"agent binary: {url}")
        info(f"published from commit {sha}")
        dockerfile = dockerfile.replace(b"ARG GROK_BUNDLE_URL", f"ARG GROK_BUNDLE_URL={url}".encode(), 1)
        dockerfile = dockerfile.replace(b"ARG GROK_BUNDLE_SHA=unknown", f"ARG GROK_BUNDLE_SHA={sha}".encode(), 1)

    # These substitutions apply to caspar/Dockerfile (source/release); the fetch
    # Dockerfile has no GROK_CLI_SOURCE ARG, so the replace is a no-op there.
    dockerfile = dockerfile.replace(b"ARG GROK_CLI_SOURCE=source", f"ARG GROK_CLI_SOURCE={cli_source}".encode())
    runtime_base = env_any("GROK_RUNTIME_BASE", default="")
    if runtime_base:
        info(f"runtime image base: {runtime_base}")
        dockerfile = dockerfile.replace(
            b"ARG RUNTIME_BASE=public.ecr.aws/docker/library/node:22-trixie-slim",
            f"ARG RUNTIME_BASE={runtime_base}".encode(),
        )

    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    if baked:
        # Report the names only — a key must never reach a log.
        info(f"baking backbone credentials/knobs into the image: {', '.join(sorted(baked))}")
    else:
        info("no default backbone credentials baked into the image. This is fine when every agent "
             "brings its own LLM provider + key (config.llm: xai/openai/anthropic/gemini/openrouter) — "
             "those runs carry their own endpoint. Only agents with NO per-agent LLM override need a "
             "default backbone here (XAI_API_KEY, or the GROK_CREATURE_LLM_* trio).")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def report_not_ready(logs) -> None:
    """Explain a container that never announced itself, from what it *did* say.

    "no GROK_READY in the VM logs" on its own is a dead end: it is equally the
    shape of a build that failed, a build still running, an old image left in place,
    and a creature that crashed on boot. The logs distinguish those, and we already
    have them here — so print the tail and name the case rather than making an
    operator go dig for `/machines/readVmLogs`.
    """
    lines = [log_text(entry).rstrip() for entry in (logs or [])]
    lines = [line for line in lines if line]
    if not lines:
        warn("the creature produced NO log output at all. Most likely the node is still building the image "
             "(it builds asynchronously, and this deploy could not observe it), or the build failed and there "
             "is nothing runnable to start. Re-run once the build settles, and check the node's docker build "
             "logs for this program.")
        return

    joined = "\n".join(lines)
    if "GROK_BOOT" in joined or "GROK_BRIDGE" in joined:
        warn("the creature started but never reported GROK_READY — it is running this build and failing to "
             "reach the gateway. The tail below is from the creature itself.")
    elif "CLAUDE_READY" in joined or "CLAUDE_BOOT" in joined or "CLAUDE_BRIDGE" in joined:
        bad("the container that is running is the PREVIOUS backbone (it logs CLAUDE_* sentinels), not this "
            "build — the node started an older image, so the new one did not finish building in time. "
            "Re-run the deploy; the image build continues in the background.")
    else:
        warn("no GROK_READY in the VM logs, and nothing recognisable from this creature either — the tail "
             "below is whatever the container did emit.")
    tail = lines[-20:]
    warn(f"last {len(tail)} VM log line(s):")
    for line in tail:
        print(f"    | {line[:400]}", flush=True)


def deploy(client: CasparSignalingClient, *, program_id: str, entity_id: str) -> Dict[str, str]:
    """Deploy (or redeploy) the creature entity; returns the ids it landed on."""
    creature_id = ""
    prev_image_id = ""
    if program_id:
        info(f"redeploying the grok-build entity onto existing program {program_id} (entity {entity_id}) — no new creature")
        # Capture the image id BEFORE the rebuild so the wait can detect a change.
        prev_image_id = docker_image_id(program_id, entity_id)
    else:
        suffix = os.urandom(4).hex()
        creature_id = client.create_machine_creature(f"m-grok-build-{suffix}")
        program_id = client.create_program(creature_id, "/grok-build", "docker", "grok build agent")
        info(f"created machine creature {creature_id} and program {program_id}")

    context = bundle_tar_gz()
    encoded_mb = len(context) * 4 / 3 / 1048576
    info(f"build context: {len(context) / 1048576:.1f} MiB gzipped ({encoded_mb:.1f} MiB as base64 in the deploy signal)")
    if encoded_mb > MAX_PAYLOAD_MB:
        # The node closes the connection on an oversized frame, which would reach
        # us as an unexplained "[Errno 32] Broken pipe" halfway through the send.
        bad(f"the deploy payload is {encoded_mb:.1f} MiB, over the {MAX_PAYLOAD_MB} MiB a single deploy signal may carry.")
        bad("The node rejects an oversized frame by closing the socket, which looks like a broken pipe.")
        if resolve_cli_source() == "source":
            bad("`source` mode ships the whole Rust workspace — use the default GROK_CLI_SOURCE=prebuilt, "
                "where the image downloads the published bundle instead.")
        else:
            bad("Raise GROK_MAX_DEPLOY_MB only if this node's frame cap is genuinely larger.")
        raise SystemExit(2)
    files: Dict[str, str] = {"bundle.tar.gz": b64_bytes(context)}
    dockerfile, digest = compose_dockerfile(files)
    already_current = bool(prev_image_id) and docker_image_context(program_id, entity_id) == digest

    client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files)
    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        timeout = int(env_any("GROK_REBUILD_TIMEOUT", "DAVINCI_REBUILD_TIMEOUT", default="900"))
        wait_for_image(program_id, entity_id, timeout=timeout, prev_image_id=prev_image_id, expect_context=digest)
    ok(f"grok-build creature deployed: program={program_id} entity={entity_id}")
    return {"creature_id": creature_id, "program_id": program_id, "entity_id": entity_id}


def main() -> int:
    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
    # Authenticate as the ONE durable deploy operator (the same account the tool
    # deploys use), so this redeploy owns the agent program it minted before and
    # keeps every deployed agent proxy pointing at the same backbone.
    resolve_operator(client)

    # Stop mode: bring a running entity down gracefully, then exit. The Decillion
    # CI uses this before restarting the node, so the VM is not yanked with it.
    stop_pid = env_any("GROK_STOP_PROGRAM_ID", "DAVINCI_STOP_PROGRAM_ID", "CLAUDE_STOP_PROGRAM_ID")
    if stop_pid:
        info(f"stopping entity {ENTITY_ID} on program {stop_pid} (graceful pre-shutdown)")
        try:
            client.stop_entity(stop_pid, ENTITY_ID)
            ok(f"stopEntity requested for {stop_pid}/{ENTITY_ID}")
            print(f"DAVINCI_STOPPED={stop_pid}", flush=True)
            print(f"GROK_STOPPED={stop_pid}", flush=True)
        except Exception as exc:  # noqa: BLE001 — the entity may not be running
            warn(f"stopEntity failed ({exc}); the entity may not be running")
        client.close()
        return 0

    reuse_pid = env_any("GROK_REUSE_PROGRAM_ID", "DAVINCI_REUSE_PROGRAM_ID", "CLAUDE_REUSE_PROGRAM_ID")
    try:
        deployed = deploy(client, program_id=reuse_pid, entity_id=ENTITY_ID)
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    # Machine-readable markers. Both spellings are printed so this script is a
    # drop-in for the davinci deploy entrypoint the Decillion CI greps.
    for prefix in ("DAVINCI", "GROK"):
        print(f"{prefix}_PROGRAM_ID=" + deployed["program_id"], flush=True)
        print(f"{prefix}_ENTITY_ID=" + deployed["entity_id"], flush=True)

    if truthy(env_any("GROK_RUN_ENTITY", "DAVINCI_RUN_ENTITY", default="1")):
        ram = int(env_any("GROK_VM_RAM_MB", "DAVINCI_VM_RAM_MB", default="2048"))
        disk = int(env_any("GROK_VM_DISK_GB", "DAVINCI_VM_DISK_GB", default="8"))
        cpus = int(env_any("GROK_VM_CPUS", "DAVINCI_VM_CPUS", default="2"))
        max_seconds = vm_max_seconds("GROK_VM_MAX_SECONDS", "DAVINCI_VM_MAX_SECONDS")
        label = vm_label(max_seconds)
        # forceRestart is essential after a (re)deploy: without it the node's
        # idempotent run_vm resumes the OLD container (old code) instead of
        # creating a fresh one from the just-built image.
        force_restart = truthy(env_any("GROK_FORCE_RESTART", "DAVINCI_FORCE_RESTART", default="1"))
        info(f"starting the creature as a standalone VM entity (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={label} forceRestart={force_restart})")
        def start(attempt: int) -> str:
            vm = client.run_entity(deployed["program_id"], deployed["entity_id"], ram_mb=ram, disk_gb=disk,
                                   cpu_cores=cpus, max_exec_seconds=max_seconds, force_restart=force_restart)
            if vm:
                ok(f"grok-build VM entity running: {vm}" + (f" (attempt {attempt})" if attempt > 1 else ""))
            return vm

        try:
            vm_id = start(1)
            if vm_id:
                print("DAVINCI_VM_ID=" + vm_id, flush=True)
                print("GROK_VM_ID=" + vm_id, flush=True)
                if truthy(env_any("GROK_WAIT_READY", default="1")):
                    # When the image build could not be observed (no docker access
                    # here), this wait is the ONLY evidence the build produced a
                    # runnable image — so it has to outlast a cold build+boot, not
                    # just a boot.
                    default_ready = "180" if docker_cli() else "600"
                    ready_timeout = int(env_any("GROK_READY_TIMEOUT", default=default_ready))
                    found, logs = client.wait_for_vm_log(vm_id, "GROK_READY", timeout=ready_timeout, poll=3)
                    if not found and truthy(env_any("GROK_RESTART_ON_NOT_READY", default="1")):
                        # The node builds asynchronously: a container started before
                        # the build finished is running the PREVIOUS image, and no
                        # amount of further waiting changes that — but a restart now,
                        # with the build finished, picks the new image up. This is
                        # the whole reason a deploy could report success while the
                        # old backbone kept serving.
                        warn("not ready yet — restarting the entity once, in case it was started before the "
                             "node finished building the new image")
                        restarted = start(2)
                        if restarted:
                            vm_id = restarted
                            print("DAVINCI_VM_ID=" + vm_id, flush=True)
                            print("GROK_VM_ID=" + vm_id, flush=True)
                            found, logs = client.wait_for_vm_log(vm_id, "GROK_READY", timeout=ready_timeout, poll=3)
                    if found:
                        ok("creature is connected to the gateway and serving prompts (GROK_READY)")
                    else:
                        report_not_ready(logs)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the program is deployed and the backend can still spawn it per prompt")
    else:
        info("GROK_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
