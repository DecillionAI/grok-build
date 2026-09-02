# sandbox — the per-space cloud sandbox creature

A Davinci tool creature (Caspar `docker` entity) that gives **every Decillion
space a real machine**: a cloud microVM the space's agents drive over the Caspar
signalling API. The microVM is backed by **Modal** or **Vercel**, chosen at
runtime from the credentials baked into the creature image.

```
Nest  ──signal(create)──▶ sandbox creature ──▶ Modal Sandbox   (SDK / gRPC)
  ▲                            ▲            └──▶ Vercel Sandbox  (REST)
  │                            │                 (named microVM per space)
space created/deleted     davinci agent signals
                          exec / write / read
```

## Dual backbone (Modal or Vercel)

The tool speaks to one of two providers, selected once from the environment:

| Backend | Selected when | How it talks to the provider |
|---|---|---|
| **Modal** | a Modal API key is set (`MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`, or a combined `MODAL_API_KEY` = `id:secret`) | the official **Modal Python SDK** (gRPC). Modal exposes **no public REST API** for sandboxes. |
| **Vercel** | only a Vercel token is set (`VERCEL_TOKEN` / `VERCEL_API_TOKEN` / `VERCEL_ACCESS_TOKEN`) | Vercel's **REST API** (v2 named sandboxes + sessions). |

**Modal wins when both are configured.** Everything above the provider — the
background-task API, the directory listing, the signalling contract — is written
against a small `Backend` interface (`exec` / `write` / `read` / `mkdir` +
lifecycle), so the two providers behave identically to callers.

### Why this is still a docker creature (not WASM)

A Caspar TinyGo **WASM** creature can only reach the network through the node's
HTTP host bridge — no raw sockets, no gRPC. The Vercel backend is pure REST and
*could* run that way, but the Modal backend must use the SDK (gRPC), which a
WASM creature cannot. Supporting Modal therefore requires the Python runtime, so
the tool ships as a **docker** creature. If Modal ever publishes a REST sandbox
API, both backends become HTTP-only and a WASM rewrite becomes possible.

## The space ↔ sandbox binding

There is **one creature** and **one sandbox per space**. The binding is the
sandbox *name*, derived deterministically from the space id:

```
decillion-<sanitised space id>-<sha1(space id)[:10]>
```

so no creature has to store a mapping — Nest, the tool and any agent all derive
the same name from the same `space_id`.

- **Vercel:** the derived name *is* the named sandbox; the space id is also
  written into the sandbox's Vercel `tags`. Named sandboxes are created with
  `persistent: true`, so the filesystem is snapshotted when the VM stops and
  restored on the next call.
- **Modal:** the derived name is a **tag** (`decillion-space`) on the sandbox
  and the name of a **`modal.Volume`** mounted at `/workspace`. The sandbox is
  discovered by that tag; the Volume is what makes a stopped-and-recreated
  sandbox come back with the space's files. `stop` terminates the sandbox (the
  Volume persists); the next command recreates one mounting the same Volume.

Only `delete` destroys a space's storage.

## Actions

| function | what it does |
|---|---|
| `create` | provision the space's sandbox (idempotent — adopts an existing one) |
| `start` / `resume` | boot or resume, creating it if absent |
| `exec` / `run` | run a shell line, return `stdout`, `stderr`, `exit_code` |
| `write` | upload files (`path`+`content`, or a `files` list) |
| `read` | download a file (`text`, or base64 when it isn't UTF-8) |
| `mkdir` | create a directory |
| `info` / `status` | status, runtime, cwd, and the public URLs of exposed ports |
| `stop` | stop the VM, keep the files |
| `delete` | destroy the sandbox and its storage (space deletion) |
| `list` | every sandbox in the account/project, with its space id |

There is also a background-exec surface (`exec_background`, `get_output`,
`kill_exec`, `wait_exec`, `list_tasks`) used by the grok terminal backend; it is
built entirely on top of `exec`, so it works identically on both providers.

Every action except `list` requires `space_id`. Agents never pass it themselves:
Nest pins it as a catalog `defaults` entry on the tool, and Davinci's bridge
executor merges those defaults into each call **after** the model's arguments,
so an agent cannot reach another space's sandbox.

`exec` runs the command line through `sh -c` (so `&&`, pipes and redirects
work) unless an explicit `args` array is passed.

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`sandbox`) and a downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/explorer.js`). The front-end is an Elpian-based JS file explorer that
runs in the Decillion client's Victor host — the space "desktop" — not on the
node. `deploy_sandbox_tool.py` deploys it as a `downloadable` `javascript`
entity right after the back-end, so any space with the sandbox tool gets its UI
for free; the node serves it on demand via `/programs/downloadEntity`.

It reaches this back-end over the client's **host bridge**: the explorer calls
`hostCall("list_dir" | "read", …)`, the client signs the matching Caspar signal
with the **human user's** identity and returns the reply. The guest never holds a
key or a socket. The explorer is read-only — it lists directories (`list_dir`)
and previews files (`read`) — so every member of a space can browse the shared
machine safely.

## Configuration

Credentials are read from the **container environment only** — never from the
signal payload, so a prompt-injected agent cannot redirect the tool at another
account.

### Backend selection

| env | meaning |
|---|---|
| `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Modal API key → selects the **Modal** backend |
| `MODAL_API_KEY` | combined `id:secret` form, split into the two vars above |
| `VERCEL_TOKEN` | Vercel API token (also `VERCEL_API_TOKEN` / `VERCEL_ACCESS_TOKEN`) → selects the **Vercel** backend when no Modal key is set |

### Modal tuning

| env | meaning |
|---|---|
| `MODAL_SANDBOX_APP` | Modal App the sandboxes group under (`decillion-sandbox`) |
| `MODAL_SANDBOX_WORKDIR` | persistent workspace / default cwd (`/workspace`) |
| `MODAL_SANDBOX_IMAGE` | base image, a registry ref; default is a Debian slim |

### Vercel tuning

| env | meaning |
|---|---|
| `VERCEL_TEAM_ID` | team the sandboxes are billed to |
| `VERCEL_PROJECT_ID` | project that owns the named sandboxes |
| `VERCEL_SANDBOX_RUNTIME` | default runtime (`node24`) |

### Shared tuning

| env | meaning |
|---|---|
| `SANDBOX_TIMEOUT_MS` | max sandbox lifetime before hard stop (45 min) |
| `SANDBOX_IDLE_TIMEOUT_MS` | Modal: stop the VM after this idle (no exec, no open tunnel). Default 5 min. Files stay on the Volume. |
| `SANDBOX_VCPUS` | vCPUs, memory defaults to `vcpus * 2048` MB (2) |
| `SANDBOX_PREFIX` | sandbox name prefix (`decillion`) |
| `SANDBOX_MAX_OUTPUT` | chars of command output returned (60000) |
| `SANDBOX_EXEC_TIMEOUT_MS` | wall-clock cap for one `exec` (300000) |

(The legacy `VERCEL_SANDBOX_*` spellings of the shared knobs are still read as a
fallback.)

Deploy it with `scripts/deploy_sandbox_tool.py`, which bakes those values into
the creature image and prints the ids Nest needs.
