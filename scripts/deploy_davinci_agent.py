#!/usr/bin/env python3
"""Drop-in deploy entrypoint for the Decillion CI.

`decillionai-server/scripts/ci-deploy.sh` deploys the platform's agent backbone by
running the backbone repo's deploy entrypoint with a fixed environment contract
(`DAVINCI_REUSE_PROGRAM_ID`, `DAVINCI_ENTITY_ID`, `DAVINCI_STOP_PROGRAM_ID`,
`CASPAR_NODE_HOST/PORT`, `CASPAR_CA_BUNDLE`) and greps `DAVINCI_PROGRAM_ID` /
`DAVINCI_ENTITY_ID` / `DAVINCI_VM_ID` out of the output.

Pointing `AGENT_DIR`/`DAVINCI_DIR` (and the repo) at *this* repository therefore
swaps the platform's agent backbone to Grok Build with no change to Decillion and
no change to Caspar: this file is that entrypoint, and it simply runs
`deploy_grok_creature.py`, which honours the same environment contract and prints
the same markers.

Run `scripts/deploy_grok_creature.py` directly for a manual deploy — it is the
canonical name and documents every knob.
"""

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    sys.argv[0] = str(HERE / "deploy_grok_creature.py")
    runpy.run_path(str(HERE / "deploy_grok_creature.py"), run_name="__main__")
