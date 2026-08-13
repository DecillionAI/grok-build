#!/usr/bin/env python3
"""Deploy the browser_automation tool creature onto a running Caspar node.

The browser_automation tool gives a Decillion space a real headless Chromium
(Playwright): the space's agents and people open pages, click, type, run JS,
screenshot and export PDFs. One docker creature serves every space (browsing
state lives in in-memory sessions keyed by space), so it is deployed once and any
space adds it from its tool-management page.

The creature (`caspar/tools/browser_automation`) and the shared tool runtime
(`caspar/tools/_runtime`) live in this repository because it is the platform's
agent backbone — deploying agents and the tools they use should not need two
checkouts.

Note: the image is **multi-GB** — it bakes Chromium and its system libraries in
(`playwright install --with-deps chromium`) — so the build wait and the VM
resources are larger than the other tools'. Give the deploy a generous rebuild
timeout (BROWSER_REBUILD_TIMEOUT, default 1200s) and the VM enough RAM/disk.

Environment
-----------
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE

    Deploy operator (shared with the agent backbone + every other tool):
      CASPAR_DEPLOY_IDENTITY_FILE / CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY

    BROWSER_TOOL_ENTITY_ID     entity id (default browser_automation)
    BROWSER_RUN_ENTITY         1 (default) to start it serving after the deploy
    BROWSER_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
                               (default 2048 MB / 8 GB / 2 cpus — Chromium is heavy)
    BROWSER_REBUILD_TIMEOUT    image build wait, seconds (default 1200 — big image)

    BROWSER_NAV_TIMEOUT_MS, BROWSER_ACTION_TIMEOUT_MS, BROWSER_MAX_*,
    BROWSER_MAX_SESSIONS, BROWSER_SESSION_IDLE_S, BROWSER_VIEWPORT_*,
    BROWSER_USER_AGENT  → baked into the image

Output (stdout, machine-readable — the CI greps these):
    BROWSER_TOOL_PROGRAM_ID=<id>
    BROWSER_TOOL_CREATURE_ID=<id>
    BROWSER_TOOL_ENTITY_ID=browser_automation
    BROWSER_TOOL_FRONTEND_ENTITY_ID=frontend
    BROWSER_TOOL_VM_ID=<vmId>        (when the standalone runEntity start succeeds)
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

TOOL_ID = "browser_automation"
TOOLS_DIR = REPO / "caspar" / "tools"
MACHINE_NAME = f"m-tool-{TOOL_ID}"

FRONTEND_ENTITY_ID = "frontend"
FRONTEND_SOURCE = TOOLS_DIR / TOOL_ID / "frontend" / "browser.js"

# Tuning the tool reads from its environment. Baked into the image.
BROWSER_ENV_NAMES = (
    "BROWSER_NAV_TIMEOUT_MS", "BROWSER_ACTION_TIMEOUT_MS",
    "BROWSER_MAX_TEXT_CHARS", "BROWSER_MAX_HTML_CHARS", "BROWSER_MAX_SHOT_BYTES",
    "BROWSER_MAX_SESSIONS", "BROWSER_SESSION_IDLE_S",
    "BROWSER_VIEWPORT_W", "BROWSER_VIEWPORT_H", "BROWSER_USER_AGENT",
    "BROWSER_WORKER_TIMEOUT_S",
)


def bake_env() -> Dict[str, str]:
    return {name: os.environ[name].strip() for name in BROWSER_ENV_NAMES if os.environ.get(name, "").strip()}


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
    print("BROWSER_TOOL_FRONTEND_ENTITY_ID=" + FRONTEND_ENTITY_ID, flush=True)
    return True


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    info("building the browser_automation image (bakes Chromium + system libs — this is a large, "
         "slow build; give it a generous BROWSER_REBUILD_TIMEOUT)")
    dockerfile = dockerfile + b"\n" + bake_snippet(bake_env()).encode()
    return stamp_context(dockerfile, files)


def main() -> int:
    entity_id = env_any("BROWSER_TOOL_ENTITY_ID", default=TOOL_ID)

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT}")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=180).connect()
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
        wait_for_image(program_id, entity_id, timeout=int(env_any("BROWSER_REBUILD_TIMEOUT", default="1200")),
                       prev_image_id=prev_image_id, expect_context=digest, client=client)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("BROWSER_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("BROWSER_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("BROWSER_TOOL_ENTITY_ID=" + entity_id, flush=True)

    deploy_frontend(client, program_id)

    register_platform_tool(
        client, load_manifest(),
        key=TOOL_ID, program_id=program_id, creature_id=creature_id,
        entity_id=entity_id, metadata=descriptor(),
    )

    if truthy(env_any("BROWSER_RUN_ENTITY", default="1")):
        ram = int(env_any("BROWSER_VM_RAM_MB", default="2048"))
        disk = int(env_any("BROWSER_VM_DISK_GB", default="8"))
        cpus = int(env_any("BROWSER_VM_CPUS", default="2"))
        max_seconds = vm_max_seconds("BROWSER_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("BROWSER_TOOL_VM_ID=" + vm_id, flush=True)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("BROWSER_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
