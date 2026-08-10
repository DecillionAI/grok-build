#!/usr/bin/env python3
"""Seed the on-chain admin allow-set at deploy time (was a Nest boot service).

The admin-gated creatures (``market/approve|deny|listPending|list``, ``market/stats``,
``accounts/list|get|update|delete``, ``spaces/listAll``, ``admin/stats``) accept a
caller only when its creature id is in the on-chain admin allow-set
(``admin/setAdmins`` → read by ``requireAdmin``). The admin app signs those calls as
the signed-in admin directly, so the allow-set must hold the platform's admins.

This one-shot lets the **deploy operator** seed that set instead of the running Nest
server. ``admin/setAdmins`` has a bootstrap: when the set is empty the first caller
(this operator) may set it, and the caller is always retained so a write can never
lock the platform out of its own panel. So we:

  1. setAdmins([operator])           — bootstrap / ensure the operator is admin;
  2. accounts/list                   — now allowed (operator is admin);
  3. setAdmins([operator] + every account whose role is "admin", plus any listed in
     ADMIN_USERNAMES)                — the desired admin set, replacing the whole doc.

Roles are the on-chain source of truth (the accounts creature), so who is an admin is
stored and managed by a creature, not by Nest.

Idempotent (setAdmins replaces the whole set) and best-effort: a missing endpoint (an
older manifest) or an unreachable node logs and exits 0 — it never fails the deploy.

Environment (same as the tool deploys):
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE
    CASPAR_MANIFEST                the Decillion deploy manifest
    CASPAR_DEPLOY_IDENTITY_FILE / CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY
    ADMIN_USERNAMES               optional comma-separated usernames to also admin
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List, Set

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    NODE_HOST,
    NODE_PORT,
    env_any,
    info,
    load_manifest,
    manifest_endpoint,
    ok,
    resolve_operator,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402


def _set_admins(client, ep: Dict[str, str], admins: List[str]) -> Dict:
    return client.signal_wasm_endpoint(
        creature_id=ep["creatureId"], program_id=ep["programId"],
        action="setAdmins", payload={"admins": admins},
    )


def main() -> int:
    manifest = load_manifest()
    set_ep = manifest_endpoint(manifest, "admin/setAdmins")
    if not set_ep:
        warn("no admin/setAdmins endpoint in the manifest — cannot seed the admin allow-set")
        return 0
    list_ep = manifest_endpoint(manifest, "accounts/list")

    extra_usernames: Set[str] = {
        u.strip().lower() for u in env_any("ADMIN_USERNAMES").split(",") if u.strip()
    }

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT} to seed the admin allow-set")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=60).connect()
    try:
        operator_id = resolve_operator(client)

        # 1) Bootstrap: ensure the operator is an admin (retained on every setAdmins).
        boot = _set_admins(client, set_ep, [operator_id])
        if not boot.get("ok"):
            warn(f"bootstrap setAdmins did not confirm: {boot.get('error') or boot}")

        admins: Set[str] = {operator_id}

        # 2) Derive the desired set from the on-chain accounts (role is the source of
        #    truth), now that the operator is an admin and may list them.
        if list_ep:
            res = client.signal_wasm_endpoint(
                creature_id=list_ep["creatureId"], program_id=list_ep["programId"],
                action="list", payload={},
            )
            result = res.get("result") if isinstance(res, dict) else None
            rows = result.get("accounts") if isinstance(result, dict) else None
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                uid = str(row.get("userId") or "")
                if not uid:
                    continue
                role = str(row.get("role") or "").lower()
                uname = str(row.get("username") or "").lower()
                if role == "admin" or (uname and uname in extra_usernames):
                    admins.add(uid)
        else:
            warn("no accounts/list endpoint — seeding only the operator as admin")

        # 2b) Resolve ADMIN_USERNAMES against the node's GLOBAL creature registry,
        #     independent of the accounts directory. A fresh deploy has an empty
        #     directory (the app only upserts it on sign-in), so matching admins by
        #     the directory alone (step 2) would seed nobody but the operator, and
        #     the configured admin's own signed calls would then fail requireAdmin.
        #     Enumerate creatures and match the UNQUALIFIED local part — getByUsername
        #     can't reliably re-find a user either (the node stores the username
        #     qualified with its own source, e.g. "keyhmoham@<node-source>", which
        #     getByUsername does not match), so a raw lookup misses the very admin we
        #     are trying to seed. Matching the local part is how it's actually found.
        if extra_usernames:
            wanted = {u for u in extra_usernames}
            found: Dict[str, str] = {}
            try:
                for c in client.list_creatures():
                    uname_raw = str(c.get("username") or "")
                    local = uname_raw.split("@", 1)[0].lower()
                    cid = str(c.get("id") or "")
                    if cid and local in wanted:
                        found[local] = cid
            except Exception as exc:  # noqa: BLE001 — fall back to per-name probes
                warn(f"could not enumerate creatures to resolve admins: {exc}")
            for uname in sorted(wanted):
                uid = found.get(uname)
                if not uid:
                    # Last resort: the raw getByUsername probe (covers a node that
                    # doesn't support /creatures/list).
                    try:
                        uid = str((client.get_by_username(uname) or {}).get("id") or "")
                    except Exception:  # noqa: BLE001
                        uid = ""
                if uid:
                    admins.add(uid)
                    info(f"admin username {uname!r} → {uid}")
                else:
                    warn(f"admin username {uname!r} not found on the network yet — they must sign in once")

        # 3) Replace the whole set with the desired admins.
        final = _set_admins(client, set_ep, sorted(admins))
        if final.get("ok"):
            ok(f"seeded on-chain admin allow-set: {len(admins)} admin(s)")
        else:
            warn(f"final setAdmins did not confirm: {final.get('error') or final}")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
