# Grok Build and Decillion

Grok Build is no longer part of the Decillion platform.

This repository used to carry a `caspar/` directory that ran Grok Build as a
Caspar `docker` creature — Decillion's **agent backbone**, the thing every
listed agent proxied to — plus the deploy scripts and the platform tools that
went with it.

All of that is gone, and nothing here replaces it. Decillion's agents now run
as a **CrewAI crew inside each project's own Modal sandbox**, reached through
the `crew/*` creatures and the bridge in
[`crewAI/lib/caspar-bridge`](https://github.com/DecillionAI/crewAI). The
platform's tools moved to
[`decillionai-server/tools/`](https://github.com/DecillionAI/decillionai-server),
and `github` and `zapier` were rewritten as WASM creatures there.

What is left in this repository is Grok Build itself: the terminal coding agent
described in the README. It has no Decillion dependency and Decillion has none
on it.
