#!/usr/bin/env python3
"""Deploy the per-space sandbox tool creature onto a running Caspar node.

Every Decillion space owns one cloud sandbox — the machine its agents work on —
and one docker creature owns them all: Nest signals it to create a sandbox when a
space is created and to destroy it when the space is deleted, and publishes it into
the space so every agent there discovers it as a tool. The binding is the sandbox's
*name*, derived from the space id, so no party has to store a mapping.

The creature (`caspar/tools/vercel_sandbox`) and the shared tool runtime
(`caspar/tools/_runtime`) live in this repository because this repository is the
platform's agent backbone: deploying agents and deploying the machine they work on
should not need two checkouts.

The Vercel credentials are read from this process's environment and **baked into
the creature image**, so they never travel in a signal payload an agent's prompt
could influence, and are never written to the repo.

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
    SANDBOX_TOOL_ENTITY_ID    entity id (default vercel_sandbox)
    SANDBOX_RUN_ENTITY        1 (default) to start it serving after the deploy
    SANDBOX_VM_RAM_MB / _DISK_GB / _CPUS / _MAX_SECONDS   VM resources
    SANDBOX_REBUILD_TIMEOUT   image build wait, seconds (default 480)

    VERCEL_TOKEN (or VERCEL_API_TOKEN / VERCEL_ACCESS_TOKEN), VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID, VERCEL_API_BASE, VERCEL_SANDBOX_*  → baked into the image

Output (stdout, machine-readable — the CI greps these):
    SANDBOX_TOOL_PROGRAM_ID=<id>
    SANDBOX_TOOL_CREATURE_ID=<id>
    SANDBOX_TOOL_ENTITY_ID=vercel_sandbox
    SANDBOX_TOOL_VM_ID=<vmId>         (when the standalone runEntity start succeeds)
"""

from __future__ import annotations

import json
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

TOOL_ID = "vercel_sandbox"
TOOLS_DIR = REPO / "caspar" / "tools"

# The tool's Victor mini-app front-end: an Elpian-based JS file explorer that
# runs in the Decillion client (not on the node) and reaches this back-end over
# the host bridge. It ships as a *downloadable* `frontend` entity on the SAME
# program as the docker back-end, so a space that has the sandbox tool also has
# its UI with nothing extra to wire.
FRONTEND_ENTITY_ID = "frontend"
FRONTEND_SOURCE = TOOLS_DIR / TOOL_ID / "frontend" / "explorer.js"

# Every name the tool reads. All three token spellings are here on purpose: the
# tool accepts any of them, so baking only VERCEL_TOKEN would let an operator who
# set VERCEL_API_TOKEN deploy a creature that looks fine and refuses every call.
SANDBOX_ENV_NAMES = (
    "VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN",
    "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_API_BASE",
    "VERCEL_SANDBOX_RUNTIME", "VERCEL_SANDBOX_TIMEOUT_MS", "VERCEL_SANDBOX_VCPUS",
    "VERCEL_SANDBOX_PREFIX", "VERCEL_SANDBOX_MAX_OUTPUT", "VERCEL_SANDBOX_MAX_READ_BYTES",
    "VERCEL_SANDBOX_EXEC_TIMEOUT_MS", "VERCEL_SANDBOX_HTTP_TIMEOUT",
    "VERCEL_SANDBOX_SESSION_TTL",
)


def bake_env() -> Dict[str, str]:
    """The Vercel credentials + tuning to bake into the creature image."""
    import os

    return {name: os.environ[name].strip() for name in SANDBOX_ENV_NAMES if os.environ.get(name, "").strip()}


def build_context() -> Dict[str, str]:
    """The tool's docker build context: the shared runtime + this tool's code."""
    runtime = TOOLS_DIR / "_runtime"
    tool_dir = TOOLS_DIR / TOOL_ID
    files = {
        "tool_runtime.py": b64_file(runtime / "tool_runtime.py"),
        # The docker-host bridge client, the tool's only route to the node's host
        # functions (HTTP for the Vercel API) and to signalling its result back.
        "caspar_bridge.py": b64_file(runtime / "caspar_bridge.py"),
        "tool.py": b64_file(tool_dir / "tool.py"),
        "requirements.txt": b64_file(tool_dir / "requirements.txt"),
        "point.metadata.json": b64_file(tool_dir / "point.metadata.json"),
    }
    return files


def descriptor() -> Dict[str, object]:
    """The tool's own metadata — deployed with it so the node/Nest can read it."""
    try:
        return json.loads((TOOLS_DIR / TOOL_ID / "point.metadata.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def deploy_frontend(client: "CasparSignalingClient", program_id: str) -> bool:
    """Deploy the tool's downloadable Victor front-end onto the same program.

    Non-fatal: a node that predates downloadable entities (or a missing source)
    only warns — the back-end is fully functional without the UI, and the client
    simply shows no desktop tile for a program that has no `frontend` entity.
    """
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
        warn(f"front-end deploy failed ({exc}); the sandbox works, but its desktop UI won't load")
        return False
    ok(f"{TOOL_ID} front-end deployed: program={program_id} entity={FRONTEND_ENTITY_ID} (downloadable)")
    print("SANDBOX_TOOL_FRONTEND_ENTITY_ID=" + FRONTEND_ENTITY_ID, flush=True)
    return True


def compose_dockerfile(files: Dict[str, str]):
    dockerfile = (TOOLS_DIR / TOOL_ID / "Dockerfile").read_bytes()
    dockerfile = apply_ca(dockerfile, files)
    baked = bake_env()
    if any(baked.get(k) for k in ("VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN")):
        info(f"baking Vercel credentials into the image (scope={baked.get('VERCEL_TEAM_ID') or 'personal account'})")
    else:
        warn("no VERCEL_TOKEN in the environment — the creature will deploy but every call will fail "
             "until the token is baked in")
    dockerfile = dockerfile + b"\n" + bake_snippet(baked).encode()
    return stamp_context(dockerfile, files)


def main() -> int:
    entity_id = env_any("SANDBOX_TOOL_ENTITY_ID", default=TOOL_ID)

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
        client.deploy(program_id, entity_id, "docker", b64_bytes(dockerfile), files_b64=files,
                      metadata={"decillion": descriptor()})
    except Exception as exc:  # noqa: BLE001
        bad(f"deploy failed: {exc}")
        client.close()
        return 1

    if already_current:
        ok("image already built from this exact context — no rebuild to wait for")
    else:
        wait_for_image(program_id, entity_id, timeout=int(env_any("SANDBOX_REBUILD_TIMEOUT", default="480")),
                       prev_image_id=prev_image_id, expect_context=digest, client=client)
    ok(f"{TOOL_ID} creature deployed: program={program_id} entity={entity_id}")

    print("SANDBOX_TOOL_PROGRAM_ID=" + program_id, flush=True)
    print("SANDBOX_TOOL_CREATURE_ID=" + creature_id, flush=True)
    print("SANDBOX_TOOL_ENTITY_ID=" + entity_id, flush=True)

    # Ship the downloadable Victor front-end onto the same program (best-effort).
    deploy_frontend(client, program_id)

    # Announce the tool into the on-chain platform registry (the market creature),
    # as the deploying operator — no running Nest server involved. `spaces/create`
    # reads this bucket to attach the sandbox to every new space. Verifies the write
    # landed so a wire failure is visible here, not as spaces silently missing it.
    register_platform_tool(
        client, load_manifest(),
        key=TOOL_ID, program_id=program_id, creature_id=creature_id,
        entity_id=entity_id, metadata=descriptor(),
    )

    # Start it as a long-lived serving creature: the tool runtime stays in its serve
    # loop and answers every signal over the gateway, so Nest's create/delete calls
    # and the agents' exec calls hit a warm container instead of cold-spawning one.
    if truthy(env_any("SANDBOX_RUN_ENTITY", default="1")):
        ram = int(env_any("SANDBOX_VM_RAM_MB", default="512"))
        disk = int(env_any("SANDBOX_VM_DISK_GB", default="2"))
        cpus = int(env_any("SANDBOX_VM_CPUS", default="1"))
        max_seconds = vm_max_seconds("SANDBOX_VM_MAX_SECONDS")
        info(f"starting {TOOL_ID} as a standalone serving VM (ram={ram}MB disk={disk}GB cpu={cpus} "
             f"maxExec={vm_label(max_seconds)})")
        try:
            # forceRestart: this always follows a (re)deploy, so the old container
            # must be replaced or the node resumes the pre-rebuild image.
            vm_id = client.run_entity(program_id, entity_id, ram_mb=ram, disk_gb=disk, cpu_cores=cpus,
                                      max_exec_seconds=max_seconds, force_restart=True)
            if vm_id:
                ok(f"{TOOL_ID} VM entity running: {vm_id}")
                print("SANDBOX_TOOL_VM_ID=" + vm_id, flush=True)
            else:
                warn("runEntity returned no vmId")
        except Exception as exc:  # noqa: BLE001 — the program is deployed regardless
            warn(f"runEntity failed ({exc}); the node will cold-spawn the tool per signal")
    else:
        info("SANDBOX_RUN_ENTITY=0 — skipping the standalone runEntity start")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
