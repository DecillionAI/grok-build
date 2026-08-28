#!/usr/bin/env python3
"""Deploy the zapier tool creature onto a running Caspar node.

The zapier tool gives a Decillion space every app its people connected to Zapier:
a member authorizes their accounts once from the tool's Connect screen, and after
that the space's agents can send the email, post the message, create the calendar
event or the CRM row on their behalf. One docker creature serves every space —
the connections are per-space state keyed by the space id — so it is deployed
once and any space adds it from its tool-management page.

The creature (``caspar/tools/zapier``) and the shared tool runtime
(``caspar/tools/_runtime``) live in this repository because it is the platform's
agent backbone — deploying agents and the tools they use should not need two
checkouts.

The Zapier MCP **connection token** is read from this process's environment and
**baked into the creature image**, so it never travels in a signal payload an
agent's prompt could influence and is never written to the repo. In CI it comes
from the repository's GitHub secret (``ZAPIER_MCP_TOKEN`` / ``ZAPIER_AUTH_TOKEN``
— see decillionai-server's ``deploy-zapier-tool.yml``). With no token the tool
still deploys: spaces then bring their own Zapier account through the front-end.

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

    ZAPIER_TOOL_ENTITY_ID   entity id (default zapier)
    ZAPIER_RUN_ENTITY       1 (default) to start it serving after the deploy
    ZAPIER_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
    ZAPIER_REBUILD_TIMEOUT  image build wait, seconds (default 480)
    ZAPIER_GATEWAY_PATH     the fixed VM-gateway path the embed page is served on
                            (default "zapier")

    Baked into the image:
      ZAPIER_MCP_TOKEN       the platform's Zapier MCP connection token (secret)
                             — aliases: ZAPIER_AUTH_TOKEN, ZAPIER_TOKEN,
                               ZAPIER_MCP_AUTH_TOKEN, ZAPIER_API_KEY
      ZAPIER_MCP_URL         the MCP endpoint
                             (default https://mcp.zapier.com/api/v1/connect)
      ZAPIER_MCP_EMBED_ID / ZAPIER_MCP_EMBED_SECRET   optional Zapier MCP Embed,
                             which lets a person authorize their app accounts in
                             an in-app panel instead of pasting a token
      ZAPIER_*               the tuning knobs listed in the tool's README

Output (stdout, machine-readable — the CI greps these):
    ZAPIER_TOOL_PROGRAM_ID=<id>
    ZAPIER_TOOL_CREATURE_ID=<id>
    ZAPIER_TOOL_ENTITY_ID=zapier
    ZAPIER_TOOL_FRONTEND_ENTITY_ID=frontend
    ZAPIER_TOOL_VM_ID=<vmId>            (when the standalone runEntity start succeeds)
    ZAPIER_EMBED_INGRESS=<url>          (the connect panel's fixed ingress URL)
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
    register_tool_commands,
    resolve_operator,
    stamp_context,
    truthy,
    vm_label,
    vm_max_seconds,
    wait_for_image,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402

TOOL_ID = "zapier"
TOOLS_DIR = REPO / "caspar" / "tools"

# The tool's machine-creature name = the bare local part of its username. The node
# aliases this to the creature id at gateway-route registration, so it is what the
# fixed embed URL uses (`/{MACHINE_NAME}/{GATEWAY_PATH}/embed`).
MACHINE_NAME = f"m-tool-{TOOL_ID}"

# The deterministic custom VM-gateway path the "connect your apps" page is served
# under. Combined with the machine name it yields a FIXED node ingress URL that is
# stable across redeploys (the node re-points the route at each fresh serving
# instance) — which is what Zapier MCP Embed's allowed-domains list is configured
# against, once, for good.
GATEWAY_PATH = (os.environ.get("ZAPIER_GATEWAY_PATH", "").strip() or "zapier").strip("/")

FRONTEND_ENTITY_ID = "frontend"
FRONTEND_SOURCE = TOOLS_DIR / TOOL_ID / "frontend" / "zapier.js"

# Every name the tool reads from its environment. Baked into the image so an
# agent's prompt can never redirect the MCP server or read the token back out.
ZAPIER_ENV_NAMES = (
    "ZAPIER_MCP_TOKEN", "ZAPIER_MCP_URL", "ZAPIER_MCP_SERVER_URL", "ZAPIER_MCP_SERVER_PREFIX",
    "ZAPIER_MCP_PROTOCOL_VERSION", "ZAPIER_PLATFORM_LABEL",
    "ZAPIER_MCP_EMBED_ID", "ZAPIER_MCP_EMBED_SECRET", "ZAPIER_MCP_EMBED_SCRIPT",
    "ZAPIER_MCP_HOME_URL", "ZAPIER_CONNECTIONS_URL",
    "ZAPIER_HTTP_TIMEOUT", "ZAPIER_CALL_TIMEOUT", "ZAPIER_TOOLS_TTL_S",
    "ZAPIER_LIST_LIMIT", "ZAPIER_LIST_CAP", "ZAPIER_MAX_OUTPUT", "ZAPIER_HANDSHAKE_TTL_S",
    # Computed below, not operator-supplied: where this creature's own HTTP
    # surface (the embed page) is reachable from a browser.
    "ZAPIER_VM_HTTP_INGRESS_BASE", "ZAPIER_INGRESS_PATH",
)

# The token may arrive under any of the names an operator would plausibly pick for
# the GitHub secret. Map each alias onto the name the image expects; an explicitly
# set ZAPIER_MCP_TOKEN always wins.
_ALIASES = {
    "ZAPIER_AUTH_TOKEN": "ZAPIER_MCP_TOKEN",
    "ZAPIER_TOKEN": "ZAPIER_MCP_TOKEN",
    "ZAPIER_MCP_AUTH_TOKEN": "ZAPIER_MCP_TOKEN",
    "ZAPIER_API_KEY": "ZAPIER_MCP_TOKEN",
    "ZAPIER_MCP_API_KEY": "ZAPIER_MCP_TOKEN",
    "ZAPIER_EMBED_ID": "ZAPIER_MCP_EMBED_ID",
    "ZAPIER_EMBED_SECRET": "ZAPIER_MCP_EMBED_SECRET",
}


def _resolve_aliases() -> None:
    for alias, target in _ALIASES.items():
        if not os.environ.get(target, "").strip() and os.environ.get(alias, "").strip():
            os.environ[target] = os.environ[alias].strip()


def _resolve_ingress() -> str:
    """Pin where the creature's own embed page is reachable, and return that URL.

    The page is served INSIDE the container by the tool's ``http_handler`` and
    reached through the node's VM HTTP ingress at the deterministic
    ``/{machineName}/{gatewayPath}/embed`` path. The base must be the node's
    PUBLIC VM-ingress origin (ZAPIER_VM_HTTP_INGRESS_BASE /
    CASPAR_VM_HTTP_INGRESS_BASE, e.g. https://api.decillionai.com), and that
    origin must reverse-proxy to the node's VM HTTP ingress port."""
    base = env_any("ZAPIER_VM_HTTP_INGRESS_BASE", "CASPAR_VM_HTTP_INGRESS_BASE", default="").rstrip("/")
    os.environ["ZAPIER_INGRESS_PATH"] = f"{MACHINE_NAME}/{GATEWAY_PATH}"
    if base:
        os.environ["ZAPIER_VM_HTTP_INGRESS_BASE"] = base
    return (base + f"/{MACHINE_NAME}/{GATEWAY_PATH}/embed") if base else \
        f"/{MACHINE_NAME}/{GATEWAY_PATH}/embed"


def bake_env() -> Dict[str, str]:
    _resolve_aliases()
    _resolve_ingress()
    return {name: os.environ[name].strip() for name in ZAPIER_ENV_NAMES if os.environ.get(name, "").strip()}


def build_context() -> Dict[str, str]:
    """The tool's docker build context: the shared runtime + this tool's code."""
    runtime = TOOLS_DIR / "_runtime"
    tool_dir = TOOLS_DIR / TOOL_ID
    return {
        "tool_runtime.py": b64_file(runtime / "tool_runtime.py"),
        # The docker-host bridge client — how the tool persists its per-space
        # Zapier connections in the node's key/value store.
        "caspar_bridge.py": b64_file(runtime / "caspar_bridge.py"),
        "tool.py": b64_file(tool_dir / "tool.py"),
        "requirements.txt": b64_file(tool_dir / "requirements.txt"),
        "point.metadata.json": b64_file(tool_dir / "point.metadata.json"),
    }


def descriptor() -> Dict[str, object]:
    """The tool's own metadata — deployed with it so the node, the market registry
    and the agents can read what it does and how to talk to it."""
    try:
        return json.loads((TOOLS_DIR / TOOL_ID / "point.metadata.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def deploy_frontend(client: "CasparSignalingClient", program_id: str) -> bool:
    """Deploy the tool's downloadable Victor front-end onto the same program.

    Non-fatal: a node that predates downloadable entities (or a missing source)
    only warns — but without it there is no in-app place to connect an account,
    so the warning says so."""
    if not FRONTEND_SOURCE.exists():
        warn(f"no front-end source at {FRONTEND_SOURCE} — skipping the desktop UI "
             "(people would then have no in-app way to connect a Zapier account)")
        return False
    try:
        client.deploy(
            program_id, FRONTEND_ENTITY_ID, "javascript", b64_file(FRONTEND_SOURCE),
            metadata={"decillion": {"tool_id": TOOL_ID, "kind": "frontend",
                                    "host": "victor", "entry": "module.js"}},
            downloadable=True,
        )
    except Exception as exc:  # noqa: BLE001 — the back-end deploy already succeeded
        warn(f"front-end deploy failed ({exc}); agents can still use a connected account, "
             "but nobody can connect one from the app")
        return False
    ok(f"{TOOL_ID} front-end deployed: program={program_id} entity={FRONTEND_ENTITY_ID} (downloadable)")
    print("ZAPIER_TOOL_FRONTEND_ENTITY_ID=" + FRONTEND_ENTITY_ID, flush=True)
    return True


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    token = baked.get("ZAPIER_MCP_TOKEN", "")
    if token:
        info(f"baking the platform Zapier MCP token into the image ({token[:4]}…{len(token)} chars, "
             f"endpoint {baked.get('ZAPIER_MCP_URL') or 'https://mcp.zapier.com/api/v1/connect'})")
    else:
        warn("no ZAPIER_MCP_TOKEN in the environment — the tool will deploy without a platform "
             "Zapier workspace; every space must then connect its own account from the tool's "
             "Connect screen. Set the ZAPIER_MCP_TOKEN repository secret to ship one.")
    if baked.get("ZAPIER_MCP_EMBED_ID"):
        info("Zapier MCP Embed is configured — people can authorize their app accounts in-app")
    else:
        info("no ZAPIER_MCP_EMBED_ID — the connect flow uses the connection-token path "
             "(open Zapier, authorize apps, paste the token)")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def _log_embed_url() -> None:
    """Record the FIXED ingress URL the connect panel is served on, so the operator
    registers that origin once in Zapier MCP Embed's allowed-domains config."""
    full = _resolve_ingress()
    if not full.startswith("http"):
        warn("ZAPIER_VM_HTTP_INGRESS_BASE / CASPAR_VM_HTTP_INGRESS_BASE is unset — the embed URL "
             "below is only the ingress path suffix; prefix it with the node's public VM-ingress "
             "origin, and set that variable so the front-end can open the panel")
    print("ZAPIER_EMBED_INGRESS=" + full, flush=True)
    info(f"the Zapier connect panel is served in-container at a FIXED url: {full}")


def main() -> int:
    entity_id = env_any("ZAPIER_TOOL_ENTITY_ID", default=TOOL_ID)

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
    # Authenticate as the ONE deploy operator and resolve this tool's program
    # deterministically: re-find the machine by its stable username (reuse its
    # program), or create it on the first deploy. No recorded-id reuse, no re-mint.
    operator_id = resolve_operator(client)
    creature_id, program_id = ensure_docker_program(
        client, operator_id,
        machine_name=MACHINE_NAME,
        program_path=f"/tools/{TOOL_ID}",
        comment=f"tool {TOOL_ID}",
    )
    prev_image_id = docker_image_id(program_id, entity_id)

    files = build_context()
    dockerfile, digest = compose_dockerfile(files)
    # Does an image built from exactly this context already exist? Asked by LABEL,
    # because the node names images by machine id, not program id.
    already_current = image_built_for_context(digest)

    try:
        # `gatewayPath` binds the deterministic embed route at deploy time
        # (targeting the entity's default container); the runEntity start below
        # re-points it at the warm serving instance. Either way the external URL
        # is the same fixed `/{machineName}/{GATEWAY_PATH}/…`.
        client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files,
                      metadata={"decillion": descriptor(), "gatewayPath": GATEWAY_PATH})
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        wait_for_image(program_id, entity_id, timeout=int(env_any("ZAPIER_REBUILD_TIMEOUT", default="480")),
                       prev_image_id=prev_image_id, expect_context=digest, client=client)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("ZAPIER_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("ZAPIER_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("ZAPIER_TOOL_ENTITY_ID=" + entity_id, flush=True)

    # Ship the downloadable Victor front-end onto the same program — the screen
    # where a person connects their Zapier account and authorizes each app.
    deploy_frontend(client, program_id)

    # Announce the tool into the on-chain platform registry (the market creature),
    # as the deploying operator — no running server involved. The client's
    # addable-tools list reads this bucket via market/listPlatform. Verifies the
    # write landed so a wire failure surfaces here rather than as a missing tool.
    register_platform_tool(
        client, load_manifest(),
        key=TOOL_ID, program_id=program_id, creature_id=creature_id,
        entity_id=entity_id, metadata=descriptor(),
    )

    # Register the tool's chat commands so the client can offer them as @tool
    # command suggestions in a space's chat (the tools/registerCommands registry).
    register_tool_commands(
        client, load_manifest(),
        key=TOOL_ID, program_id=program_id, creature_id=creature_id,
        entity_id=entity_id, metadata=descriptor(),
    )

    # Start it as a long-lived serving creature so signals hit a warm container
    # (and so the embed route points at a live instance).
    if truthy(env_any("ZAPIER_RUN_ENTITY", default="1")):
        ram = int(env_any("ZAPIER_VM_RAM_MB", default="512"))
        disk = int(env_any("ZAPIER_VM_DISK_GB", default="2"))
        cpus = int(env_any("ZAPIER_VM_CPUS", default="1"))
        max_seconds = vm_max_seconds("ZAPIER_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True,
                                      gateway_path=GATEWAY_PATH)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("ZAPIER_TOOL_VM_ID=" + vm_id, flush=True)
                info(f"bound fixed VM-gateway route '{GATEWAY_PATH}' → this instance for the connect panel")
                _log_embed_url()
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("ZAPIER_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
