#!/usr/bin/env python3
"""Store the admin-configured platform LLM keys in the on-chain secret store.

The platform's provider API keys (set in the admin panel → AgentSettingsStore) used
to be baked into the agent backbone's creature image as environment variables. This
moves them into Caspar's encrypted secret store instead: as the deploy **operator**
we `secretPut` each key (so it lives on-chain only as ciphertext) and `secretGrant`
the **agent backbone creature** time-boxed read access. At boot the backbone hydrates
them with the `secretGet` host call (see caspar/grokRunner.hydratePlatformKeys) — the
plaintext never touches the image or a signal payload.

The keys are read from this process's env as `GROK_CREATURE_LLM_KEY_<PROVIDER>` (the
same vars ci-deploy already derives from agent-settings.json); each is stored under the
secret name `LLM_KEY_<PROVIDER>`, owned by the operator, and granted to the backbone.

Environment:
    CASPAR_NODE_HOST / CASPAR_NODE_PORT / CASPAR_CA_BUNDLE
    CASPAR_MANIFEST                        the deploy manifest (davinci.agent.creatureId)
    CASPAR_DEPLOY_IDENTITY_FILE / CASPAR_OPERATOR_ID / CASPAR_OPERATOR_PRIVATE_KEY
    GROK_CREATURE_LLM_KEY_<PROVIDER>       the plaintext keys to store
    SECRET_GRANT_TTL_SECONDS               grant lifetime (default ~10 years)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from caspar_deploy_common import (  # noqa: E402
    NODE_HOST,
    NODE_PORT,
    env_any,
    info,
    load_manifest,
    ok,
    resolve_operator,
    warn,
)
from caspar_signaling import CasparSignalingClient  # noqa: E402

DEFAULT_TTL = 315_360_000  # ~10 years — a platform key is long-lived; revoke to end it.


def backbone_creature_id(manifest: dict) -> str:
    dav = manifest.get("davinci") if isinstance(manifest, dict) else None
    agent = dav.get("agent") if isinstance(dav, dict) else None
    return str(agent.get("creatureId") or "") if isinstance(agent, dict) else ""


def platform_keys_from_env() -> dict:
    """`{LLM_KEY_<PROVIDER>: value}` from the GROK_CREATURE_LLM_KEY_* env vars."""
    out = {}
    for name, value in os.environ.items():
        if name.startswith("GROK_CREATURE_LLM_KEY_") and value.strip():
            secret_name = "LLM_KEY_" + name[len("GROK_CREATURE_LLM_KEY_"):]
            out[secret_name] = value.strip()
    return out


def main() -> int:
    keys = platform_keys_from_env()
    if not keys:
        info("no GROK_CREATURE_LLM_KEY_* in the environment — no platform LLM keys to store")
        return 0
    manifest = load_manifest()
    grantee = backbone_creature_id(manifest)
    if not grantee:
        warn("no davinci.agent.creatureId in the manifest — cannot grant the backbone; "
             "deploy the agent backbone first, then re-run")
        return 0
    ttl = int(env_any("SECRET_GRANT_TTL_SECONDS", default=str(DEFAULT_TTL)) or DEFAULT_TTL)

    info(f"connecting to Caspar node {NODE_HOST}:{NODE_PORT} to store platform LLM keys")
    client = CasparSignalingClient(NODE_HOST, NODE_PORT, timeout=60).connect()
    try:
        operator_id = resolve_operator(client)
        for name, value in sorted(keys.items()):
            put = client.send("/creatures/secretPut", {"name": name, "value": value})
            if put.get("_res_code", -1) != 0 or (isinstance(put, dict) and put.get("ok") is False):
                warn(f"secretPut {name} failed: {put}")
                continue
            grant = client.send("/creatures/secretGrant",
                                {"name": name, "grantee": grantee, "ttlSeconds": ttl})
            if grant.get("_res_code", -1) != 0 or (isinstance(grant, dict) and grant.get("ok") is False):
                warn(f"secretGrant {name} → {grantee} failed: {grant}")
                continue
            ok(f"stored {name} (owner {operator_id}) and granted backbone {grantee}")
        # Tell ci-deploy which owner to bake into the backbone image so it knows
        # where to read the secrets from at boot.
        print("SECRET_OWNER=" + operator_id, flush=True)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
