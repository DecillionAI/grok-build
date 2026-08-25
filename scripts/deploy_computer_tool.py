#!/usr/bin/env python3
"""Deploy the computer tool creature onto a running Caspar node.

The computer tool gives a Decillion space a **real graphical browser desktop**
streamed over VNC: the space's people watch and drive it with mouse/touch/
keyboard (in Victor's in-app webview), and the space's agents drive the same
desktop with screenshots + click/type/key/scroll/navigate. One docker creature
serves every space (each space gets its own desktop inside the container, keyed
by space id), so it is deployed once and any space adds it from its tool-manager.

The creature (`caspar/tools/computer`) and the shared tool runtime
(`caspar/tools/_runtime`) live in this repository because it is the platform's
agent backbone — deploying agents and the tools they use should not need two
checkouts.

Note: the image is a **thin orchestrator** — the graphical desktop (Xvfb, a
window manager, the browser, x11vnc, noVNC/websockify, cloudflared) is installed
and run on the space's own Modal/Vercel sandbox, driven through the ``sandbox``
tool. So the image is small and the VM stays modest. The sandbox tool MUST be
deployed before this one, so its program id can be baked in (from the manifest's
``davinci.tools["sandbox"]``, or an explicit COMPUTER_SANDBOX_PROGRAM_ID).

Environment
-----------
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE

    Deploy operator (shared with the agent backbone + every other tool):
      CASPAR_DEPLOY_IDENTITY_FILE / CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY

    COMPUTER_TOOL_ENTITY_ID    entity id (default computer)
    COMPUTER_RUN_ENTITY        1 (default) to start it serving after the deploy
    COMPUTER_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
                               (default 1024 MB / 4 GB / 1 cpu — a thin orchestrator)
    COMPUTER_REBUILD_TIMEOUT   image build wait, seconds (default 1200)

    COMPUTER_SANDBOX_PROGRAM_ID  the sandbox tool's program id to drive (defaults
                               to the manifest's davinci.tools["sandbox"])
    COMPUTER_SANDBOX_ENTITY_ID   the sandbox tool's entity id (default sandbox)

    COMPUTER_SCREEN_W, COMPUTER_SCREEN_H, COMPUTER_BROWSER_PACKAGE,
    COMPUTER_BROWSER_BIN, COMPUTER_HOME_URL, COMPUTER_VNC_PASSWORD,
    COMPUTER_TUNNEL_TIMEOUT_S, COMPUTER_MAX_SHOT_BYTES,
    COMPUTER_DISPLAY, COMPUTER_VNC_PORT, COMPUTER_WEB_PORT
                               → baked into the image

Output (stdout, machine-readable — the CI greps these):
    COMPUTER_TOOL_PROGRAM_ID=<id>
    COMPUTER_TOOL_CREATURE_ID=<id>
    COMPUTER_TOOL_ENTITY_ID=computer
    COMPUTER_TOOL_FRONTEND_ENTITY_ID=frontend
    COMPUTER_TOOL_VM_ID=<vmId>        (when the standalone runEntity start succeeds)
"""

from __future__ import annotations

import json
import os
import sys
import time
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

TOOL_ID = "computer"
TOOLS_DIR = REPO / "caspar" / "tools"
MACHINE_NAME = f"m-tool-{TOOL_ID}"

FRONTEND_ENTITY_ID = "frontend"
FRONTEND_SOURCE = TOOLS_DIR / TOOL_ID / "frontend" / "computer.js"

# Tuning the tool reads from its environment. Baked into the image.
COMPUTER_ENV_NAMES = (
    "COMPUTER_SCREEN_W", "COMPUTER_SCREEN_H",
    "COMPUTER_BROWSER_PACKAGE", "COMPUTER_BROWSER_BIN", "COMPUTER_HOME_URL",
    "COMPUTER_VNC_PASSWORD", "COMPUTER_TUNNEL_TIMEOUT_S", "COMPUTER_MAX_SHOT_BYTES",
    "COMPUTER_DISPLAY", "COMPUTER_VNC_PORT", "COMPUTER_WEB_PORT",
    "COMPUTER_SANDBOX_TOOL_ID", "COMPUTER_PROVISION_TIMEOUT_S", "COMPUTER_EXEC_TIMEOUT_S",
    "COMPUTER_SANDBOX_BOOT_TIMEOUT_S",
)


def _sandbox_ids() -> Dict[str, str]:
    """Resolve the sandbox tool's program/entity ids from the deploy manifest, so
    they can be baked into the computer image — this creature drives the sandbox
    tool over the gateway to run the desktop on the space's Modal/Vercel microVM.

    An explicit ``COMPUTER_SANDBOX_PROGRAM_ID`` env wins; otherwise we read
    ``davinci.tools["sandbox"]`` from the manifest (recorded when the sandbox tool
    was deployed). The sandbox tool MUST be deployed before this one."""
    pid = os.environ.get("COMPUTER_SANDBOX_PROGRAM_ID", "").strip()
    entity = os.environ.get("COMPUTER_SANDBOX_ENTITY_ID", "").strip()
    if not pid:
        try:
            tools = (load_manifest().get("davinci") or {}).get("tools") or {}
            entry = tools.get("sandbox") or {}
            pid = str(entry.get("programId") or "").strip()
            if not entity:
                entity = str(entry.get("entityId") or "").strip()
        except Exception:  # noqa: BLE001
            pid = ""
    out: Dict[str, str] = {}
    if pid:
        out["COMPUTER_SANDBOX_PROGRAM_ID"] = pid
    if entity:
        out["COMPUTER_SANDBOX_ENTITY_ID"] = entity
    return out


def bake_env() -> Dict[str, str]:
    env = {name: os.environ[name].strip() for name in COMPUTER_ENV_NAMES if os.environ.get(name, "").strip()}
    sandbox = _sandbox_ids()
    if not sandbox.get("COMPUTER_SANDBOX_PROGRAM_ID"):
        warn("could not resolve the sandbox tool's program id (deploy the sandbox tool first, or set "
             "COMPUTER_SANDBOX_PROGRAM_ID) — the computer tool will have no sandbox to drive until this is fixed")
    else:
        ok(f"the computer tool will drive sandbox program {sandbox['COMPUTER_SANDBOX_PROGRAM_ID']}")
    env.update(sandbox)
    return env


def build_context() -> Dict[str, str]:
    runtime = TOOLS_DIR / "_runtime"
    tool_dir = TOOLS_DIR / TOOL_ID
    return {
        "tool_runtime.py": b64_file(runtime / "tool_runtime.py"),
        "caspar_bridge.py": b64_file(runtime / "caspar_bridge.py"),
        "tool.py": b64_file(tool_dir / "tool.py"),
        "requirements.txt": b64_file(tool_dir / "requirements.txt"),
        "point.metadata.json": b64_file(tool_dir / "point.metadata.json"),
    }


def descriptor() -> Dict[str, object]:
    try:
        return json.loads((TOOLS_DIR / TOOL_ID / "point.metadata.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def deploy_frontend(client: "CasparSignalingClient", program_id: str) -> bool:
    if not FRONTEND_SOURCE.exists():
        warn(f"no front-end source at {FRONTEND_SOURCE} — skipping the desktop UI")
        return False
    try:
        client.deploy(
            program_id, FRONTEND_ENTITY_ID, "javascript", b64_file(FRONTEND_SOURCE),
            metadata={"decillion": {"tool_id": TOOL_ID, "kind": "frontend",
                                    "host": "victor", "entry": "module.js"}},
            downloadable=True,
        )
    except Exception as exc:  # noqa: BLE001 — the back-end deploy already succeeded
        warn(f"front-end deploy failed ({exc}); the tool works, but its desktop UI won't load")
        return False
    ok(f"{TOOL_ID} front-end deployed: program={program_id} entity={FRONTEND_ENTITY_ID} (downloadable)")
    print("COMPUTER_TOOL_FRONTEND_ENTITY_ID=" + FRONTEND_ENTITY_ID, flush=True)
    return True


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    info("building the computer image (a thin orchestrator — the graphical desktop runs on the "
         "space's sandbox, not in this image)")
    dockerfile = dockerfile + b"\n" + bake_snippet(bake_env()).encode()
    return stamp_context(dockerfile, files)


def _connect_and_resolve(entity_id: str):
    """Connect, authenticate, and resolve/create this tool's docker program —
    retrying on a transient node timeout (the node may still be booting the other
    tools' serving VMs when this deploy runs)."""
    timeout = int(env_any("COMPUTER_DEPLOY_TIMEOUT_S", default="300"))
    attempts = int(env_any("COMPUTER_DEPLOY_CONNECT_ATTEMPTS", default="4"))
    backoffs = [20, 40, 60, 90]
    last_exc: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        client = None
        try:
            info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT} (attempt {attempt}/{attempts})")
            client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=timeout).connect()
            operator_id = resolve_operator(client)
            creature_id, program_id = ensure_docker_program(
                client, operator_id,
                machine_name=MACHINE_NAME,
                program_path=f"/tools/{TOOL_ID}",
                comment=f"tool {TOOL_ID}",
            )
            return client, creature_id, program_id
        except Exception as exc:  # noqa: BLE001 — retry transient node stalls
            last_exc = exc
            if client is not None:
                try:
                    client.close()
                except Exception:  # noqa: BLE001
                    pass
            if attempt < attempts:
                delay = backoffs[min(attempt - 1, len(backoffs) - 1)]
                warn(f"node handshake failed ({type(exc).__name__}: {exc}); the node is likely still "
                     f"booting the other tools' VMs — retrying in {delay}s")
                time.sleep(delay)
    raise RuntimeError(f"could not reach the Caspar node to create the {TOOL_ID} program after "
                       f"{attempts} attempts: {last_exc}")


def main() -> int:
    entity_id = env_any("COMPUTER_TOOL_ENTITY_ID", default=TOOL_ID)

    client, creature_id, program_id = _connect_and_resolve(entity_id)
    prev_image_id = docker_image_id(program_id, entity_id)

    files = build_context()
    dockerfile, digest = compose_dockerfile(files)
    already_current = image_built_for_context(digest)

    try:
        client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files,
                      metadata={"decillion": descriptor()})
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        wait_for_image(program_id, entity_id, timeout=int(env_any("COMPUTER_REBUILD_TIMEOUT", default="1200")),
                       prev_image_id=prev_image_id, expect_context=digest, client=client)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("COMPUTER_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("COMPUTER_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("COMPUTER_TOOL_ENTITY_ID=" + entity_id, flush=True)

    deploy_frontend(client, program_id)

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

    if truthy(env_any("COMPUTER_RUN_ENTITY", default="1")):
        # A thin orchestrator: the heavy desktop runs on the space's sandbox, so
        # this VM stays small.
        ram = int(env_any("COMPUTER_VM_RAM_MB", default="1024"))
        disk = int(env_any("COMPUTER_VM_DISK_GB", default="4"))
        cpus = int(env_any("COMPUTER_VM_CPUS", default="1"))
        max_seconds = vm_max_seconds("COMPUTER_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("COMPUTER_TOOL_VM_ID=" + vm_id, flush=True)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("COMPUTER_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
