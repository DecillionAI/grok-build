# Grok Build as a Caspar creature

This directory turns Grok Build into a **Caspar `docker` creature program entity**
— an autonomous agent the [Decillion](https://github.com/DecillionAI/decillionai-server)
platform can prompt over Caspar's signaling API. It speaks the exact wire contract
the davinci agent creature speaks, so it is a drop-in replacement for Decillion's
agent backbone (it is what the `davinci.agent` manifest slot points at):

* **no change to Caspar** — the node's docker-host bridge gateway, proxy entities
  and signal envelopes are used as they are;
* **no change to Decillion** — the backend still signals an agent proxy, still
  receives `davinci/step` / `davinci/result`, still bills the same `usage`.

The agent is **this repository's own `grok` binary**, compiled from `crates/` —
not a downloaded release.

---

## How a prompt flows

```
Expo app ──▶ Nest /api/agents/:id/prompt
                │  signal (pvp)
                ▼
        agent proxy entity  ──relays, attaching the agent's skill──▶  THIS creature
                ▲                                                        │
                │  davinci/result (terminal, closes the correlation)     │
                └────────────────────────────────────────────────────────┘
                   davinci/step … (streamed to the prompting user)

   inside the creature:   runtime.mjs ──▶ grok --prompt-file … \
                                │            --output-format streaming-messages-json
                                │                     │
                                │        the space's creatures, as MCP tools
                                ▼                     ▼
                          bridge.mjs  ──signalUser──▶ tool creature (sandbox, …)
```

A creature container has **one** channel to the outside world: a TCP connection to
the node's docker-host bridge gateway. Everything — receiving prompts, streaming
progress, employing sibling creatures — rides that connection.

### The contract

| Direction | Key | Packet |
|---|---|---|
| in | `creatures/signal` | `{prompt\|objective, skill, self, roster, groupChat, sessionId, spaceId, historyEndpoint, streamTo, correlationId, replyTo, attachments, config:{tools, llm, max_wall_seconds}}` |
| out (per step) | `creatures/signal` | `{kind:"davinci/step", correlationId, seq, channel, event, stream:true, final:false}` |
| out (terminal) | `creatures/signal` | `{kind:"davinci/result", correlationId, result, stream:false, final:true}` |
| out (tool call) | `creatures/signal` | `{kind:"invoke", entityId, correlationId, reply_to, tool_id, function, payload}` |
| in (tool reply) | `creatures/signal` | `{kind:"tools/result", correlationId, result}` |
| out (history fetch) | `creatures/signal` | `{action:"single", user:{id:self}, store:{id:spaceId}, data, entityId, correlationId}` → `spaces/history` |
| in (history reply) | `creatures/signal` | `{namespace:"spaces", action:"history", correlationId, history:[…]}` |

The group-chat **history is not sent in the prompt** — the client passes only
`historyEndpoint` (the `spaces/history` creature's address), and this creature
signals that endpoint for the thread itself before building the prompt
(`spaceHistory.mjs`). The reply comes back on `creatures/signal` (not
`creatures/signal/result`, which the node never delivers to a docker creature).

**Multimodal attachments.** `attachments` on the task carries files the person
sent with the message (`[{name, mime_type, data|path|url, description}]`, `data`
base64; the Decillion client sends a small `url` reference and the backbone
fetches the bytes, keeping the prompt signal under the node's frame limit). Every
attachment is materialised into the session workspace so the agent can open, run
or edit it.

The model's message content is **text + image only**, so how an attachment
reaches the model depends on its type:

* **Images** are handed to the model *inline* as ACP image content blocks
  (`{type:"image", data, mimeType}`, `mediaContentBlocks`); the turn is written to
  `grok`'s `--prompt-file` as a `.json` array (`[{type:"text",text}, …images]`)
  instead of `prompt.txt`, so the model actually sees the picture — not just a
  path. Oversized images (`MAX_INLINE_MEDIA_BYTES`, default 16 MiB) stay file-only.
* **PDFs and text documents** (`text/*`, json/xml/csv/yaml, source code, …) are
  **extracted to text** and inlined (`extract.mjs` — a pure-Node PDF text
  extractor + UTF-8 read; `=== CONTENT OF <name> ===` block). This is what lets
  the agent answer about a PDF it cannot open with its own (in-space disabled)
  file tools.
* **Audio** is **transcribed to text** via a Whisper-compatible endpoint when one
  is configured (`GROK_CREATURE_STT_API_KEY` [+ `_STT_BASE_URL`/`_STT_MODEL`], or
  the agent's own OpenAI-compatible provider key), inlined as a
  `=== TRANSCRIPT OF <name> ===` block. Without an STT endpoint the clip stays
  file-only (the model has no audio input).
* Everything else (video, archives, binaries) stays file-only.

**Agent-produced media uses the same space attachment path.** Every run exposes
`caspar__generate_media` (create an image, spoken-audio clip, or video) and
`caspar__share_media` (attach an existing public URL or shared-sandbox file).
Generated/fetched bytes are bounded, placed on the terminal `davinci/result` as
an ephemeral `attachments` array, uploaded by the signed-in Decillion client to
Caspar blob storage, and only the durable storage reference is written to chat
history. Provider credentials and temporary provider URLs never enter history.

Generation is not tied to xAI Imagine. Routing prefers the agent's own selected
LLM provider and key, then configured platform providers only when the selected
provider has no route or credential:

* **OpenAI** — a selected GPT-5-family model uses the Responses API's
  `image_generation` tool; otherwise the image endpoint uses `gpt-image-2`.
  Spoken audio uses `gpt-4o-mini-tts`.
* **Gemini** — native `generateContent` produces inline image/audio bytes (raw
  PCM speech is wrapped as WAV); the Interactions API produces inline video.
* **OpenRouter** — its unified image/audio endpoints and asynchronous video job
  API are supported.
* **xAI and other OpenAI-compatible providers** remain optional routes. xAI has
  an image default; another compatible provider is enabled by configuring a
  per-modality model.

Once a provider request has been sent, a failure is returned to the agent and is
**not** silently retried against another provider: a failed request may already
have generated/billed output. Existing Grok built-in image/video results are also
auto-collected, so older/native tool paths continue to attach correctly.

`channel` is one of `status · plan · thought · action · observation · final · trace`
— what the Expo client renders as the live trajectory. The `result` carries
`answer`, `usage.promptTokens` / `usage.completionTokens` (what the platform bills),
`durationMs`, and a non-array `plan`.

Steps go to `streamTo` (the prompting user's own creature) when the backend names
one, so the proxy correlation carries exactly one message — the terminal result.
With no `streamTo` they ride the proxy as non-terminal chunks (`stream: true`),
which the node relays while keeping the correlation open.

---

## Files

| File | Role |
|---|---|
| `runtime.mjs` | The entrypoint. Connects to the gateway, then serves every prompt signal for as long as the VM lives. Also runs one task from `/app/input` when there is no gateway (offline self-test). |
| `bridge.mjs` | The docker-host bridge gateway client: chunked framing, HELLO/WELCOME, host calls (`signalUser`, `dbOp`, `httpRequest`), pushed signals. |
| `taskSignal.mjs` | Peels the StoresSend / `payload` / proxy envelopes into a task; derives the conversation thread key. |
| `prompt.mjs` | Composes what Grok is given: the agent's skill as persona, the group-chat preamble and roster, the thread's history with `[From → To]` annotations. |
| `spaceHistory.mjs` | Fetches the space's group-chat transcript and turns the persisted records into the annotated history turns `prompt.mjs` renders. Reads the store **directly** (`getByPrefix` on `Json::StoreHistory::<space>::` + a `getJson` per record — the primary path, so an agent always sees the conversation regardless of signal delivery quirks); falls back to the creature→creature `spaces/history` signal only when a direct read comes back empty. |
| `orchestrate.mjs` | **Server-side agent orchestration.** After a run marked `serverOrchestrate` persists its answer, the backbone resolves the teammates it @mentioned (roster + program index), mints a **delegated** billing quote for each against the payer's pool (`billing/quote` with an explicit `payerUserId`, honoured because this backbone IS the settlement meter; bounded by the project's autonomous budget), and signals each teammate's proxy to run — so the @mention chain (and routine-fired runs) complete with **no client present**. `visited`/`maxHops` carry on the task, so the chain can't loop or double-launch; only backbone-minted (`autonomousQuote`) runs settle against the autonomous budget. Wired into `runtime.mjs`'s `startDelivery` (ensure-auth → serve → settle → fan out). |
| `catalog.mjs` | Turns the space's `config.tools` into MCP tool definitions; applies the platform's pinned `defaults` after the model's arguments; `mergeCatalogs` unions the backend catalog with live discovery. |
| `discovery.mjs` | Fetches the space's employable creatures (tools, apps, sub-agents) straight from the node at prompt time — the **program index** (`getJson` on `Json::StoreProgramIndex::<space>`) — and builds catalog entries, so the agent sees the space's live roster even when `config.tools` is thin. |
| `toolInvoker.mjs` | Employs a tool creature over the gateway and awaits its correlated `tools/result`. |
| `toolSocket.mjs` / `mcpStdioServer.mjs` | The `caspar` MCP server Grok talks to, and its unix-socket link back to this process (which owns the single gateway connection). |
| `grokRunner.mjs` | Runs the CLI headless: flags, per-agent LLM override, privilege drop, wall-clock kill. |
| `grokConfig.mjs` | Writes the run's `$GROK_HOME/config.toml` — the MCP server entry and the agent's provider endpoint (Grok has no `--mcp-config` flag). |
| `llm/providers.mjs` | Provider → endpoint/protocol table (xAI, OpenAI, Anthropic, Gemini, OpenRouter, …). |
| `env.mjs` | The `GROK_CREATURE_*` knobs (legacy `CLAUDE_CREATURE_*` names still read). |
| `events.mjs` | Maps `streaming-messages-json` lines onto the platform's step channels; masks credentials. |
| `result.mjs` | Builds the terminal reply (answer, billable usage, plan, budget, outbound attachments). |
| `attachments.mjs` | Materialises prompt attachments into the session workspace, and turns image ones into inline ACP image blocks for the model. |
| `extract.mjs` | Extracts non-image attachments to text: PDF/document text, and audio transcription (Whisper-compatible), so the model can read them. |
| `mediaGeneration.mjs` | Provider-neutral `generate_media` adapters for OpenAI, Gemini, OpenRouter, xAI and configured OpenAI-compatible endpoints. |
| `outboundMedia.mjs` | Bounded outbound attachment collector for generated bytes, public URLs, shared-sandbox files, and native generation-tool outputs. |
| `build/imageBuild.sh` | Builds/verifies the binary inside the image. |
| `Dockerfile.fetch` | The creature image the deploy uses: the build downloads the published bundle. |
| `Dockerfile` / `Dockerfile.prebuilt` | The other two image shapes: in-image compile (or published-CLI download), and a bundle already in the build context (what the GHCR image is built from). |
| `tools/` | The platform's docker tool creatures: the per-space `sandbox` (Modal or Vercel backbone), the `github` tool, the `web_search` tool (internet search + page reading), the `browser_automation` tool (a real headless Chromium via Playwright), plus their shared runtime. Each tool is one program with a docker back-end + a downloadable Victor front-end, driven over the Caspar signalling API by both agents and the tool's mini-app; see each tool's `README.md`. |
| `tests/` | Checks — see *Testing*. |

Session state: each conversation thread (`space:<spaceId>:<agentId>`) gets its own
workspace under `/data/workspaces/…` **and** its own `GROK_HOME` under
`/data/grok-config/…`, on the VM's persistent mount, so a project's files and the
CLI's session state survive container restarts.

---

## Seeing the space: tools, apps, creatures and other agents

On every prompt the agent is given the space's employable creatures — the project
sandbox, published tools and apps, and the **other agents** — as real, callable
MCP tools, and its system prompt enumerates them so it *plans with* them instead
of only answering from its own knowledge or the generic editor/shell built-ins of
the harness it runs on (asked "what tools do you have?", it answers with the
space's tools, not `read_file`/`run_terminal_cmd`). Sub-agents are offered for
delegation: the agent can hand a sub-task to another agent by calling it with a
prose prompt.

**How Grok calls them.** Grok exposes MCP servers through two always-on
meta-tools rather than one function per tool: `search_tool` discovers them and
`use_tool` dispatches, addressing each as `<server>__<tool>` — so a space creature
is `caspar__project_sandbox`. That qualified name is what the system prompt lists
(`runtime.mjs` qualifies every catalog entry), and it is what the trajectory
reports: `events.mjs` unwraps a `use_tool` call so a step reads as the creature
that was employed, not as the meta-tool it went through. The meta-tools are never
put in a deny list — they are the agent's only route to the space.

When the space has a **shared cloud sandbox** (the per-space machine Decillion
publishes as a `category: "execution"` tool), the prompt names it as the space's
shared filesystem + shell and tells the agent to collaborate THERE — so teammates
see the same files and command output — rather than in its own private, ephemeral
local working directory. Detection is by the published descriptor, not a hardcoded
program id, so any execution-tool the space carries is framed this way.

And it is not just advice: the CLI's **own built-in shell and filesystem tools are
turned off** for the run (`--disallowed-tools run_terminal_cmd,read_file,write,
search_replace,apply_patch,list_dir,glob,grep,…`), so the agent has no way to do
throwaway work on its private container — bash and files *must* go through the
shared sandbox, where the team sees them. Planning, web and delegation tools stay
on. Knobs: `GROK_CREATURE_FORCE_SANDBOX_FS=0` disables the enforcement,
`GROK_CREATURE_DISALLOWED_TOOLS` overrides the denied list.

**Which space is authoritative.** The space a run is scoped to is decided by the
**store the signal came from**, not by a client-supplied field. The backend signals
an agent *within* its space store, the node stamps that store onto the signal
envelope (`store.id`) and the proxy relay carries it through untouched, so
`decodeTaskSignal` (`taskSignal.mjs`, `spaceIdFromEnvelope`) reads it and sets the
task's `spaceId` from it — overriding any `spaceId` a caller embedded in the
payload. So an agent can neither be handed the wrong space nor reach another
space's creatures by naming a different id.

Two sources feed that catalog, unioned by `mergeCatalogs`:

1. **`config.tools`** — the catalog the backend's `DiscoveryService` sends with the
   prompt. It is **authoritative**: it carries the platform-pinned `defaults`
   (e.g. the bound `space_id`) that keep a shared tool working on *this* space.
2. **Live discovery** (`discovery.mjs`) — the creature also fetches the space's
   roster itself, over the gateway, reading the program index first and
   supplementing with `readMembers` + `getCreature`. **Best-effort**: an
   unresolved space id or an unexpected shape yields nothing rather than an error,
   and a discovered entry only *adds* a creature the backend did not send — it
   never displaces a backend entry or its pinned binding.

Knobs (env): `GROK_CREATURE_DISCOVER_TOOLS` (default on), `_DISCOVER_TIMEOUT_MS`
(default 8000), `_DISCOVER_MAX` (default 50 members). `node caspar/tests/discovery-checks.mjs`
drives the fetch, merge and prompt end to end against the real gateway wire.

---

## Building the agent from this repo's source

The agent binary is `xai-grok-pager` (shipped as `grok`), built from this
repository's `crates/`:

```bash
cargo build --release -p xai-grok-pager-bin      # → target/release/xai-grok-pager
scripts/package-creature.sh                      # → out/bundle.tar.gz (+ bin/grok)
```

`scripts/package-creature.sh` is the packaging step: it builds the binary, proves
it runs, and tars `bin/grok` + `caspar/` into a ready-to-use Docker build context.
That is what the deployer ships in the default **prebuilt** mode — so the node's
image build is a copy, not a 60-crate cargo build inside a gVisor sandbox.

### The published bundle is what Decillion deploys

`.github/workflows/build-grok-creature.yml` runs that packaging step on every push
(and on `v*` tags) and publishes `bundle.tar.gz` three ways: a workflow artifact, a
**rolling per-branch release** (`creature-main`, `creature-<branch-with-dashes>`),
and a `ghcr.io/<owner>/grok-build-creature` image.

The rolling release is the one that matters for the platform: the deploy stamps its
URL into the creature image, and **the node's image build downloads it**.

```
https://github.com/<owner>/grok-build/releases/download/creature-<branch>/bundle.tar.gz
```

**Why the image fetches it instead of the deploy shipping it.** A Caspar deploy is
one length-prefixed frame, and the node caps a frame at 20 MB (`network/framing.rs`
`MAX_FRAME_LEN`; the TCP client path allows 32 MB). The release build of `grok` is
~170 MB — ~63 MB gzipped, ~84 MB once base64-encoded into the signal. Sending it
made the node close the socket mid-write, which the deployer reported as the
unhelpful `[Errno 32] Broken pipe`. No compression setting fixes that; the binary
simply cannot travel in a signal. So `caspar/Dockerfile.fetch` `curl`s it during the
build (the node's builder already has egress — it installs apt packages in the same
build), and the deploy payload is just the ~200 KB bridge. `deploy_grok_creature.py`
also refuses a payload over `GROK_MAX_DEPLOY_MB`, so an oversized context fails with
that explanation instead of a broken pipe.

It has to be a *release* asset rather than the workflow artifact because neither the
deploy host nor the node has credentials for this repo (the host's token belongs to
another org, and GitHub's artifacts API needs auth even for public repos). Release
assets download anonymously.

The bundle job pins `runs-on: ubuntu-22.04` deliberately: the binary is dynamically
linked, so the glibc it is built against is a floor on every machine that later runs
it — building on the oldest supported runner keeps that floor low.

**A branch is deployable before it merges:** push it, let the workflow publish
`creature-<branch>`, and point the deploy's `AGENT_BRANCH` at it. Until that
workflow run finishes there is no bundle for the branch, and the Decillion deploy
skips the agent step (leaving the running backbone live) rather than falling back to
a compile.

Build requirements are the repo's own (see the root README): the pinned Rust
toolchain, plus a `protoc` — either DotSlash (`bin/protoc`) or a system
`protobuf-compiler` (`$PROTOC`); `package-creature.sh` points the build at the
system one when DotSlash is absent.

**glibc.** The binary is dynamically linked, so the image it lands in must carry a
glibc at least as new as the build host's. `caspar/Dockerfile.prebuilt` therefore
defaults to a Debian **trixie** node base (glibc 2.41), newer than every current
LTS CI image, and the image build runs `grok --version` so a mismatch fails the
build instead of an agent's first prompt. Override with `GROK_RUNTIME_BASE`.

---

## Deploying

```bash
# on the Caspar node's host, with the node running
XAI_API_KEY=xai-…  python3 scripts/deploy_grok_creature.py
```

It logs in as the deploy operator, gzip-tars the build context, composes the
Dockerfile (host CA bundle + the backbone credentials baked in, never written to
disk), deploys the entity, waits for the node to build the image, and starts it
with `runEntity --forceRestart`. It prints:

```
DAVINCI_PROGRAM_ID=<id>   GROK_PROGRAM_ID=<id>
DAVINCI_ENTITY_ID=davinci GROK_ENTITY_ID=davinci
DAVINCI_VM_ID=<vmId>      GROK_VM_ID=<vmId>
```

Key knobs (all documented in the script's header):

| Env | Meaning |
|---|---|
| `GROK_REUSE_PROGRAM_ID` | Redeploy onto an existing program id — **use this**, so already-deployed agent proxies keep pointing at a valid backbone |
| `GROK_ENTITY_ID` | Entity id, default `davinci` (existing proxies target that entity) |
| `CASPAR_DEPLOY_IDENTITY_FILE` | Where the durable deploy-operator identity is persisted (default: next to `CASPAR_MANIFEST`). The backbone **and** every tool authenticate as this one account, so a redeploy always owns the program being reused and never mints a new one. |
| `CASPAR_OPERATOR_ID` + `CASPAR_OPERATOR_PRIVATE_KEY` | Inject the operator identity explicitly (highest precedence) |
| `XAI_API_KEY` | The default backbone, baked into the image |
| `GROK_CLI_SOURCE` | `prebuilt` (default — the image downloads the workflow-published bundle), `source` (compile `crates/` in the image; its context is over the deploy frame limit on this repo), or `release` (the image downloads the published x.ai binary) |
| `GROK_BUNDLE_URL` | Which published bundle the image fetches. Derived from the checkout's remote + branch when unset |
| `GROK_MAX_DEPLOY_MB` | Refuse a deploy payload over this (default 16), instead of letting the node close the socket on an oversized frame |
| `GROK_VM_RAM_MB` / `_DISK_GB` / `_CPUS` / `_MAX_SECONDS` | VM resources (defaults 2048 MB / 8 GB / 2 cpu / unlimited) |
| `GROK_READY_TIMEOUT` | How long to wait for the creature's `GROK_READY` line (default 180s, or 600s when the image build cannot be observed from the deploy host) |
| `GROK_RESTART_ON_NOT_READY` | `1` (default) — restart the entity once when it never reports ready, which is what picks up an image that finished building after the first start |

### Watching the node build the image

`buildOnDeploy` is true for the docker runtime, so the node starts building the
image as soon as the deploy lands — asynchronously, on its own. The deploy script
only *watches*, and for a long time it watched the wrong thing: it polled `docker
images` for the tag to appear and said nothing else, so a build that was failing
and a build that was slow looked identical, for the full 900s timeout.

The build's own output is available, though. The runtime emits it before any VM
exists, onto a node-wide stream — vm id `main`, log type `build` — which
`/machines/readVmLogs` deliberately leaves readable by any authenticated user
(there is no VM to anchor ownership to). So the wait now streams that log:

```
[deploy] waiting for the node to build image 7_global/davinci (≤900s)…
    build | Step 2/9 : RUN apt-get update && apt-get install -y git ripgrep curl
    build | Step 6/9 : RUN curl -fsSL … && tar -xzf …
    build | curl: (28) Failed to connect to github.com port 443 after 20000 ms
    build | docker build failed: … returned a non-zero code: 28
[fail] the node's image build FAILED: …
```

A failure ends the wait immediately instead of after the timeout, and a healthy
build is visible step by step. The image itself is matched by the context-digest
**label** every deployed Dockerfile carries (`images_with_context`) rather than by
a guessed tag — the node derives the tag from ids the deployer does not always
know, and an `imageRef` can be overridden per packet, so the label is the one
identifier that is always ours.

### Why a deploy can "succeed" with the old creature still serving

The node builds the image **asynchronously** and `runEntity` starts whatever image
the tag currently points at. So on a host where the deploy cannot query docker (the
deploy user is not in the docker group), three things used to compound:

1. the image wait polled a docker it could not talk to, got nothing, and burned its
   whole timeout before warning about an image it never had a way to see;
2. `runEntity` then started the container — possibly from the **previous** image,
   because the build was still running;
3. the readiness check reported only "no GROK_READY", which looks the same whether
   the build failed, is still going, or an old container is happily serving.

Now: the deploy probes docker once (plain, then `sudo -n`) and skips the pointless
wait outright when it cannot observe builds; the readiness wait becomes the real
signal and is given longer in that case; a creature that does not report ready is
**restarted once**, which is exactly what picks up a just-finished image; and if it
still does not come up, the VM log tail is printed with the case named — previous
backbone (`CLAUDE_*` sentinels), this build failing to reach the gateway
(`GROK_BOOT`), or no output at all (the build produced nothing runnable).

### Being the platform's agent backbone, with zero Decillion changes

`decillionai-server/scripts/ci-deploy.sh` deploys the agent backbone by running
the backbone repo's `scripts/deploy_davinci_agent.py` and grepping
`DAVINCI_PROGRAM_ID` out of its output. This repo provides that entrypoint (a thin
alias for `deploy_grok_creature.py`), honours the same environment contract
(`DAVINCI_REUSE_PROGRAM_ID`, `DAVINCI_ENTITY_ID`, `DAVINCI_STOP_PROGRAM_ID`,
`CASPAR_NODE_HOST/PORT`, `CASPAR_CA_BUNDLE`) and prints the same markers. So:

```bash
AGENT_REPO=https://github.com/cosmopole-org/grok-build \
AGENT_DIR=/path/to/grok-build \
bash scripts/ci-deploy.sh
```

That run does **not** compile anything and does not download the binary either: it
picks this repo's published `creature-<branch>` bundle (above), checks the asset
exists, and stamps its URL into the image the node builds. If no bundle has been
published for the branch it deploys nothing and says so, leaving the running
backbone in place.

The deployer records the program id in `.caspar-deploy.json` under `davinci.agent`,
which is what `CasparService.agentBackbone()` reads and what every new agent proxy
targets. Reusing the recorded program id keeps existing agents working — a
redeploy that minted a new id would strand every deployed proxy.

Runtime knobs (baked at deploy time or set on the entity). Each also accepts its
legacy `CLAUDE_CREATURE_*` spelling, so a host with the previous backbone's env
baked in keeps working:

| Env | Default | Meaning |
|---|---|---|
| `GROK_CREATURE_MODEL` | CLI default | Model for every run (a per-agent `config.llm` override wins) |
| `GROK_CREATURE_MAX_WALL_SECONDS` | `900` | Hard ceiling per prompt (a task's `config.max_wall_seconds` wins) |
| `GROK_CREATURE_MAX_TURNS` | unset | `--max-turns` ceiling on agentic rounds |
| `GROK_CREATURE_PERMISSION_MODE` | `bypassPermissions` | Autonomous agent: no human to approve a tool call |
| `GROK_CREATURE_TOOL_TIMEOUT` | `240` | Seconds to wait for a tool creature (cold spawns are slow) |
| `GROK_CREATURE_STREAM_STEPS` | `1` | Stream the trajectory |
| `GROK_CREATURE_TRACE_ALL` | `0` | Also emit unmapped CLI events on the `trace` channel |
| `GROK_CREATURE_HISTORY_TURNS` | `30` | Prior turns rendered into the prompt |
| `GROK_CREATURE_SERVE_FOREVER` | `1` | Keep serving prompts instead of exiting after one |
| `GROK_CREATURE_USER` | `grok` | Unprivileged user for the CLI; empty means "do not drop privileges" |
| `GROK_CREATURE_CONFIG_DIR` | `/data/grok-config` | Root of the per-thread `GROK_HOME` |
| `GROK_CREATURE_AUTH_FILE` | unset | A persisted `grok login` (`auth.json`) to seed each thread's home with, instead of an API key |

---

## LLM providers (per agent)

Decillion stores an optional `{provider, model, apiKey}` per agent and sends it as
`config.llm` with every prompt — the same block davinci consumed. Every part is
honoured, and **natively**: Grok speaks OpenAI Chat Completions, OpenAI Responses
and the Anthropic Messages API itself, so a provider override is a generated
`[model.<id>]` entry in the run's config — there is no translation proxy.

| Provider (`llm_provider`) | Endpoint | API | `llm_model` example |
|---|---|---|---|
| `xai` (or unset) | `api.x.ai/v1` | chat completions | `grok-4.5` |
| `openai` | `api.openai.com/v1` | Responses | `gpt-5.4` |
| `anthropic` | `api.anthropic.com/v1` | messages (`x-api-key`) | `claude-opus-5` |
| `gemini` (`google`) | Gemini's OpenAI-compatible endpoint | chat completions | `gemini-2.5-pro` |
| `openrouter` | `openrouter.ai/api/v1` | chat completions | `openai/gpt-4o` |
| `groq` · `deepseek` · `mistral` · `together` | each provider's OpenAI-compatible endpoint | chat completions | provider model id |
| anything else **with** `llm.base_url` | that URL | chat completions (or `llm.api_backend`) | provider model id |

- **The agent's key takes over the run.** When `config.llm` carries an `api_key`,
  every credential the image baked in is removed for that run — the agent's
  provider is billed, never the platform's.
- **The agent's key never enters the child's environment.** It is written only
  into the run's `config.toml` (mode 0600, in the thread's own config dir), so a
  subprocess or a crash dump cannot carry it further.
- **Base URL overrides.** An agent may set `llm.base_url` (e.g. an Azure/OpenAI
  gateway); an operator may repoint a provider with `GROK_CREATURE_LLM_BASE_<PROVIDER>`.
- **A default non-xAI backbone.** `GROK_CREATURE_LLM_PROVIDER` + `_API_KEY`
  (+ `_MODEL`, `_BASE_URL`) baked at deploy time serve every agent that brings no
  provider of its own, through the same code path. A per-agent override always
  wins.
- **Unusable override.** No `api_key`, or an unknown provider with no `base_url`:
  the run falls back to the image's default backbone and says so in the reply's
  `warnings` — never a silent wrong answer.

### Media-generation configuration

Media generation reuses `config.llm.api_key` for the selected provider, the
platform's `GROK_CREATURE_LLM_KEY_<PROVIDER>` secrets, or the conventional
`OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`,
provider-standard keys for Groq/DeepSeek/Mistral/Together, and xAI variables. It never copies these keys into the Grok child environment or a
result attachment.

| Env | Meaning |
|---|---|
| `GROK_CREATURE_MEDIA_PROVIDER` | Preferred fallback after the selected agent provider |
| `GROK_CREATURE_MEDIA_PROVIDERS` | Comma-separated fallback order before the built-in OpenAI/Gemini/OpenRouter/xAI order |
| `GROK_CREATURE_MEDIA_MODEL_<PROVIDER>_<MODALITY>` | Override/enable a route, e.g. `GROK_CREATURE_MEDIA_MODEL_OPENAI_IMAGE`, `GROK_CREATURE_MEDIA_MODEL_GEMINI_VIDEO`, or `GROK_CREATURE_MEDIA_MODEL_TOGETHER_IMAGE` |
| `GROK_CREATURE_MEDIA_MAX_FILE_BYTES` | Maximum bytes for one provider output (default 10 MiB) |
| `GROK_CREATURE_MEDIA_REQUEST_TIMEOUT_MS` | Per provider HTTP request timeout (default 120000) |
| `GROK_CREATURE_MEDIA_VIDEO_WAIT_SECONDS` | Maximum asynchronous video wait (default 240) |

A call-level `provider` or `model` can choose a configured route explicitly.
`provider: auto` (the default) preserves the selected-provider-first behavior.
OpenAI-compatible providers outside the built-in table require an explicit
per-modality model, preventing a Messages-only endpoint such as Anthropic from
receiving an incompatible media request.

---

## Testing

```bash
node caspar/tests/checks.mjs            # 45 checks, no node/container/LLM needed
node caspar/tests/discovery-checks.mjs  # in-space discovery, merge and prompt
node caspar/tests/live-cli.mjs          # against a REAL grok CLI (needs credentials)
node caspar/tests/container-check.mjs   # against the built image (needs docker)
```

`checks.mjs` drives the real modules against a fake gateway that speaks the real
wire protocol and a fake CLI that speaks the real Messages `stream-json` lines. It
asserts the invariants the platform depends on: the handshake and chunked framing,
prompt decoding (skill, history, roster, correlation), the skill and history
reaching the CLI, the MCP server landing in the run's config, one step per
trajectory event on the right channel, exactly one terminal result through the
proxy, billable usage, platform-pinned tool arguments winning over the model's,
per-provider endpoint selection and the agent's key displacing the platform's,
that a prompt arriving mid-run is queued rather than dropped, and that a failed
run / a timed-out run / a crashed CLI all still reply.

`container-check.mjs` runs the image the way the node does — gateway env only —
and asserts a proxy-relayed prompt comes back streamed and answered.
