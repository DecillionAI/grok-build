#!/usr/bin/env python3
"""Deploy the github tool creature onto a running Caspar node.

The github tool gives a Decillion space a full git + GitHub client: a member
connects a GitHub account (OAuth web application flow) and then people and agents
in the space clone, branch, commit, push, pull, merge and open/merge PRs. One
docker creature serves every space (per-space state is keyed by the space id), so
it is deployed once and any space adds it from its tool-management page.

The creature (`caspar/tools/github`) and the shared tool runtime
(`caspar/tools/_runtime`) live in this repository because it is the platform's
agent backbone — deploying agents and the tools they use should not need two
checkouts.

The GitHub OAuth app credentials are read from this process's environment and
**baked into the creature image**, so they never travel in a signal payload an
agent's prompt could influence, and are never written to the repo.

Environment
-----------
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE

    Deploy operator (shared with the agent backbone + every other tool, so a
    redeploy owns the program it minted and never mints a fresh one — see
    caspar_deploy_common.resolve_operator):
      CASPAR_DEPLOY_IDENTITY_FILE   persisted operator identity (default: next to
                                    CASPAR_MANIFEST)
      CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY   inject it explicitly
      CASPAR_DEPLOY_USER            first-login username only (default davinci_admin)

    (the program is resolved deterministically by the tool's stable machine
     username — see caspar_deploy_common.ensure_docker_program — so there is no
     reuse-id env and no re-mint: a redeploy always re-finds its own program.)
    GITHUB_TOOL_ENTITY_ID     entity id (default github)
    GITHUB_RUN_ENTITY         1 (default) to start it serving after the deploy
    GITHUB_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
    GITHUB_REBUILD_TIMEOUT    image build wait, seconds (default 600)

    GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, GITHUB_OAUTH_REDIRECT_URI
                              (all required for a usable web OAuth flow),
    GITHUB_OAUTH_SCOPES, GITHUB_API_BASE, GITHUB_WEB_BASE, GITHUB_*  → baked in

Output (stdout, machine-readable — the CI greps these):
    GITHUB_TOOL_PROGRAM_ID=<id>
    GITHUB_TOOL_CREATURE_ID=<id>
    GITHUB_TOOL_ENTITY_ID=github
    GITHUB_TOOL_FRONTEND_ENTITY_ID=frontend
    GITHUB_TOOL_VM_ID=<vmId>         (when the standalone runEntity start succeeds)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Dict

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    NODE_HOST,
    NODE_PORT,
    apply_ca,
    b64_bytes,
    b64_file,
    bad,
    bake_snippet,
    ensure_docker_program,
    image_built_for_context,
    docker_image_id,
    env_any,
    info,
    load_manifest,
    ok,
    register_platform_tool,
    resolve_operator,
    stamp_context,
    truthy,
    vm_label,
    vm_max_seconds,
    wait_for_image,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402

TOOL_ID = "github"
TOOLS_DIR = REPO / "caspar" / "tools"

# The deterministic custom VM-gateway path the OAuth callback is served under.
# Combined with the tool's machine-creature username it yields a FIXED node
# ingress URL — `/{creatureUsername}/{GATEWAY_PATH}/oauth/callback` — that is
# stable across redeploys (the node re-points the route at each fresh serving
# instance). Register that exact URL once as the GitHub OAuth app's callback URL
# (and as GITHUB_OAUTH_REDIRECT_URI). Overridable via GITHUB_GATEWAY_PATH.
GATEWAY_PATH = (os.environ.get("GITHUB_GATEWAY_PATH", "").strip() or "github").strip("/")

# The tool's Victor mini-app front-end: an Elpian-based dashboard that runs in the
# Decillion client (not on the node) and reaches this back-end over the host
# bridge. It ships as a *downloadable* `frontend` entity on the SAME program as
# the docker back-end, so a space that has the tool also has its UI.
FRONTEND_ENTITY_ID = "frontend"
FRONTEND_SOURCE = TOOLS_DIR / TOOL_ID / "frontend" / "dashboard.js"

# Every name the tool reads from its environment. Baked into the image so an
# agent's prompt can never redirect the OAuth app or the API host.
GITHUB_ENV_NAMES = (
    "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_REDIRECT_URI",
    "GITHUB_OAUTH_SCOPES", "GITHUB_OAUTH_STATE_TTL_S",
    "GITHUB_API_BASE", "GITHUB_WEB_BASE",
    "GITHUB_HTTP_TIMEOUT", "GITHUB_MAX_OUTPUT", "GITHUB_MAX_READ_BYTES",
    "GITHUB_GIT_TIMEOUT_S", "GITHUB_API_PAGE_CAP", "GITHUB_WORKSPACE",
)


# GitHub Actions forbids secret/variable names starting with the reserved GITHUB_
# prefix, so the OAuth app may arrive under a GH_OAUTH_* alias. Map each alias to
# the GITHUB_OAUTH_* name the image expects (the GITHUB_* spelling wins if set).
_ALIASES = {
    "GH_OAUTH_CLIENT_ID": "GITHUB_OAUTH_CLIENT_ID",
    "GH_OAUTH_CLIENT_SECRET": "GITHUB_OAUTH_CLIENT_SECRET",
    "GH_OAUTH_REDIRECT_URI": "GITHUB_OAUTH_REDIRECT_URI",
    "GH_OAUTH_SCOPES": "GITHUB_OAUTH_SCOPES",
}


def _resolve_aliases() -> None:
    for alias, target in _ALIASES.items():
        if not os.environ.get(target, "").strip() and os.environ.get(alias, "").strip():
            os.environ[target] = os.environ[alias].strip()


def bake_env() -> Dict[str, str]:
    _resolve_aliases()
    return {name: os.environ[name].strip() for name in GITHUB_ENV_NAMES if os.environ.get(name, "").strip()}


def build_context() -> Dict[str, str]:
    """The tool's docker build context: the shared runtime + this tool's code."""
    runtime = TOOLS_DIR / "_runtime"
    tool_dir = TOOLS_DIR / TOOL_ID
    return {
        "tool_runtime.py": b64_file(runtime / "tool_runtime.py"),
        # The docker-host bridge client — how the tool persists its per-space
        # tokens/connections in the node's key/value store.
        "caspar_bridge.py": b64_file(runtime / "caspar_bridge.py"),
        "tool.py": b64_file(tool_dir / "tool.py"),
        "requirements.txt": b64_file(tool_dir / "requirements.txt"),
        "point.metadata.json": b64_file(tool_dir / "point.metadata.json"),
    }


def descriptor() -> Dict[str, object]:
    """The tool's own metadata — deployed with it so the node/Nest/agents can
    read how to use it (it doubles as the Davinci program descriptor)."""
    try:
        return json.loads((TOOLS_DIR / TOOL_ID / "point.metadata.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def deploy_frontend(client: "CasparSignalingClient", program_id: str) -> bool:
    """Deploy the tool's downloadable Victor front-end onto the same program.

    Non-fatal: a node that predates downloadable entities (or a missing source)
    only warns — the back-end is fully functional without the UI."""
    if not FRONTEND_SOURCE.exists():
        warn(f"no front-end source at {FRONTEND_SOURCE} — skipping the desktop UI")
        return False
    try:
        client.deploy(
            program_id,
            FRONTEND_ENTITY_ID,
            "javascript",
            b64_file(FRONTEND_SOURCE),
            metadata={"decillion": {"tool_id": TOOL_ID, "kind": "frontend",
                                    "host": "victor", "entry": "module.js"}},
            downloadable=True,
        )
    except Exception as exc:  # noqa: BLE001 — the back-end deploy already succeeded
        warn(f"front-end deploy failed ({exc}); the tool works, but its desktop UI won't load")
        return False
    ok(f"{TOOL_ID} front-end deployed: program={program_id} entity={FRONTEND_ENTITY_ID} (downloadable)")
    print("GITHUB_TOOL_FRONTEND_ENTITY_ID=" + FRONTEND_ENTITY_ID, flush=True)
    return True


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    if baked.get("GITHUB_OAUTH_CLIENT_ID"):
        info(f"baking GitHub OAuth app into the image (client_id={baked['GITHUB_OAUTH_CLIENT_ID'][:6]}…)")
        # The web (authorization-code) flow needs the secret AND the callback URL;
        # without either the connect flow fails at token exchange or authorize.
        if not baked.get("GITHUB_OAUTH_CLIENT_SECRET"):
            warn("no GITHUB_OAUTH_CLIENT_SECRET — the web OAuth flow cannot exchange the code for a "
                 "token; set it (GH_OAUTH_CLIENT_SECRET in CI) or connecting will fail")
        if not baked.get("GITHUB_OAUTH_REDIRECT_URI"):
            warn("no GITHUB_OAUTH_REDIRECT_URI — set it to Nest's callback "
                 "(…/api/github/oauth/callback) and register the same URL on the OAuth app, or "
                 "connecting will fail")
    else:
        warn("no GITHUB_OAUTH_CLIENT_ID in the environment — the creature will deploy but the connect "
             "flow will fail until the OAuth app is baked in")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def _log_oauth_callback_url(creature_id: str) -> None:
    """Record the FIXED node VM-HTTP-ingress URL that reaches the github tool's
    OAuth callback, so the operator registers it once as the GitHub OAuth app's
    callback URL (and as GITHUB_OAUTH_REDIRECT_URI). The callback runs INSIDE the
    container now, not on Nest.

    The URL addresses the creature by its **id** (`{creature_id}`, e.g.
    `7@global`) — path-safe — rather than its username, because the node qualifies
    usernames with its own source (e.g. `m-tool-github@http://host:port`), whose
    `://` cannot go in a URL path. The gateway resolves either form, but only the
    id form yields a valid URL here. It is deterministic and stable across
    redeploys (the id never changes and the node re-points the route at each fresh
    serving instance), so the OAuth app's registered redirect URI never has to be
    updated again.

    The base must be the node's PUBLIC VM-ingress origin — set
    GITHUB_VM_HTTP_INGRESS_BASE / CASPAR_VM_HTTP_INGRESS_BASE (e.g.
    https://api.decillionai.com) — and that origin must reverse-proxy to the
    node's VM HTTP ingress port; otherwise the printed path is only a suffix."""
    ingress_path = f"/{creature_id}/{GATEWAY_PATH}/oauth/callback"
    base = env_any("GITHUB_VM_HTTP_INGRESS_BASE", "CASPAR_VM_HTTP_INGRESS_BASE", default="").rstrip("/")
    if not base:
        warn("GITHUB_VM_HTTP_INGRESS_BASE / CASPAR_VM_HTTP_INGRESS_BASE is unset — the OAuth callback URL "
             "below is only the ingress path suffix; prefix it with the node's public VM-ingress origin")
    full = (base + ingress_path) if base else ingress_path
    print("GITHUB_OAUTH_CALLBACK_INGRESS=" + full, flush=True)
    info(f"github OAuth callback is served in-container at a FIXED url; register it as the OAuth app's "
         f"redirect URI (and GITHUB_OAUTH_REDIRECT_URI): {full}")
    manifest = env_any("CASPAR_MANIFEST", default="")
    if manifest:
        try:
            out = Path(manifest).resolve().parent / ".github-oauth-callback-url"
            out.write_text(full + "\n")
            ok(f"github OAuth callback ingress URL written to {out}")
        except Exception as exc:  # noqa: BLE001
            warn(f"could not write github OAuth callback url file: {exc}")


def main() -> int:
    entity_id = env_any("GITHUB_TOOL_ENTITY_ID", default=TOOL_ID)

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
    # Authenticate as the ONE deploy operator and resolve this tool's program
    # deterministically: re-find the machine by its stable username (reuse its
    # program), or create it on the first deploy. No recorded-id reuse, no re-mint.
    operator_id = resolve_operator(client)
    creature_id, program_id = ensure_docker_program(
        client, operator_id,
        machine_name=f"m-tool-{TOOL_ID}",
        program_path=f"/tools/{TOOL_ID}",
        comment=f"tool {TOOL_ID}",
    )
    prev_image_id = docker_image_id(program_id, entity_id)

    files = build_context()
    dockerfile, digest = compose_dockerfile(files)
    # Does an image built from exactly this context already exist? Asked by
    # LABEL, because the node names images by machine id, not program id.
    already_current = image_built_for_context(digest)

    try:
        # `gatewayPath` binds the deterministic OAuth-callback route at deploy
        # time (targeting the entity's default container); the runEntity start
        # below re-points it at the warm serving instance. Either way the
        # external URL is the same fixed `/{username}/{GATEWAY_PATH}/…`.
        client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files,
                      metadata={"decillion": descriptor(), "gatewayPath": GATEWAY_PATH})
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        wait_for_image(program_id, entity_id, timeout=int(env_any("GITHUB_REBUILD_TIMEOUT", default="600")),
                       prev_image_id=prev_image_id, expect_context=digest, client=client)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("GITHUB_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("GITHUB_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("GITHUB_TOOL_ENTITY_ID=" + entity_id, flush=True)

    # Ship the downloadable Victor front-end onto the same program (best-effort).
    deploy_frontend(client, program_id)

    # Announce the tool into the on-chain platform registry (the market creature),
    # as the deploying operator — no running Nest server involved. MarketService's
    # addable-tools list reads this bucket via market/listPlatform. Verifies the
    # write landed so a wire failure surfaces here rather than as a missing tool.
    register_platform_tool(
        client, load_manifest(),
        key=TOOL_ID, program_id=program_id, creature_id=creature_id,
        entity_id=entity_id, metadata=descriptor(),
    )

    # Start it as a long-lived serving creature so signals hit a warm container.
    if truthy(env_any("GITHUB_RUN_ENTITY", default="1")):
        ram = int(env_any("GITHUB_VM_RAM_MB", default="512"))
        disk = int(env_any("GITHUB_VM_DISK_GB", default="4"))
        cpus = int(env_any("GITHUB_VM_CPUS", default="1"))
        max_seconds = vm_max_seconds("GITHUB_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True,
                                      gateway_path=GATEWAY_PATH)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("GITHUB_TOOL_VM_ID=" + vm_id, flush=True)
                info(f"bound fixed VM-gateway route '{GATEWAY_PATH}' → this instance for the OAuth callback")
                _log_oauth_callback_url(creature_id)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("GITHUB_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
