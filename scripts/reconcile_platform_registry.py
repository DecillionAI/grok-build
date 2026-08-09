#!/usr/bin/env python3
"""Reconcile the on-chain platform-tool registry after a deploy.

Each platform tool registers ITSELF into the market creature's ``platform`` bucket
when it deploys (see ``deploy_sandbox_tool.py`` / ``deploy_github_tool.py`` →
``caspar_deploy_common.register_platform_tool``). This one-shot does the other half
the running Nest server used to do at boot: it removes any **stale** entry whose
program id is not among the tools the manifest currently records — a churned id, or
the old Nest backend creature that used to be registered here — so the addable-tools
list and ``spaces/create``'s auto-attach see exactly the live set.

The "current" set is the manifest's ``davinci.tools`` program ids (every recorded
tool, not only the ones (re)deployed this run), so a tool whose deploy was skipped
this run — e.g. no Vercel token that run — is NOT wrongly unregistered. Guarded on a
non-empty current set so a manifest read that lost ``davinci.tools`` can never wipe
the registry.

Environment (same as the tool deploys):
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE
    CASPAR_MANIFEST                the Decillion deploy manifest
    CASPAR_DEPLOY_IDENTITY_FILE / CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY
                                  the one durable deploy operator
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    NODE_HOST,
    NODE_PORT,
    info,
    load_manifest,
    reconcile_platform_registry,
    resolve_operator,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402


def current_tool_program_ids(manifest: dict) -> List[str]:
    """Every platform-tool program id the manifest records (``davinci.tools``)."""
    dav = manifest.get("davinci") if isinstance(manifest, dict) else None
    tools = dav.get("tools") if isinstance(dav, dict) else None
    if not isinstance(tools, dict):
        return []
    ids: List[str] = []
    for rec in tools.values():
        pid = rec.get("programId") if isinstance(rec, dict) else None
        if pid:
            ids.append(str(pid))
    return ids


def main() -> int:
    manifest = load_manifest()
    current = current_tool_program_ids(manifest)
    if not current:
        warn("no davinci.tools in the manifest — nothing to reconcile against; leaving the registry as-is")
        return 0
    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT} to reconcile the platform registry")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=60).connect()
    try:
        resolve_operator(client)
        reconcile_platform_registry(client, manifest, current)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
