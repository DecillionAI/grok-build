# vercel_sandbox — the per-space cloud sandbox creature

A Davinci tool creature (Caspar `docker` entity) that gives **every Decillion
space a real machine**: a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
microVM the space's agents drive over the Caspar signalling API.

```
Nest  ──signal(create)──▶ vercel_sandbox creature ──REST──▶ Vercel Sandbox
  ▲                              ▲                            (named sandbox
  │                              │                             per space)
space created/deleted     davinci agent signals
                          exec / write / read
```

## The space ↔ sandbox binding

There is **one creature** and **one sandbox per space**. The binding is the
sandbox *name*, derived deterministically from the space id:

```
decillion-<sanitised space id>-<sha1(space id)[:10]>
```

so no creature has to store a mapping — Nest, the tool and any agent all derive
the same name from the same `space_id`. The space id is also written into the
sandbox's Vercel `tags` so an operator can find it in the dashboard.

Named sandboxes are created with `persistent: true`, so the filesystem is
snapshotted when the VM stops and restored on the next call. A space's work
survives idle periods; only `delete` destroys it.

## Actions

| function | what it does |
|---|---|
| `create` | provision the space's sandbox (idempotent — adopts an existing one) |
| `start` / `resume` | boot or resume from the snapshot, creating it if absent |
| `exec` / `run` | run a shell line, return `stdout`, `stderr`, `exit_code` |
| `write` | upload files (`path`+`content`, or a `files` list) |
| `read` | download a file (`text`, or base64 when it isn't UTF-8) |
| `mkdir` | create a directory |
| `info` / `status` | status, runtime, cwd, and the public URLs of exposed ports |
| `stop` | stop the VM, keep the snapshot |
| `delete` | destroy the sandbox and its snapshots (space deletion) |
| `list` | every sandbox in the project, with its space id |

Every action except `list` requires `space_id`. Agents never pass it themselves:
Nest pins it as a catalog `defaults` entry on the tool, and Davinci's bridge
executor merges those defaults into each call **after** the model's arguments,
so an agent cannot reach another space's sandbox.

`exec` runs the command line through `sh -c` (so `&&`, pipes and redirects
work) unless an explicit `args` array is passed.

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`vercel_sandbox`) and a downloadable Victor mini-app **front-end** (entity
`frontend`, `frontend/explorer.js`). The front-end is an Elpian-based JS file
explorer that runs in the Decillion client's Victor host — the space "desktop" —
not on the node. `deploy_sandbox_tool.py` deploys it as a `downloadable`
`javascript` entity right after the back-end, so any space with the sandbox tool
gets its UI for free; the node serves it on demand via `/programs/downloadEntity`.

It reaches this back-end over the client's **host bridge**: the explorer calls
`hostCall("list_dir" | "read", …)`, the client signs the matching Caspar signal
with the **human user's** identity and returns the reply. The guest never holds a
key or a socket. The explorer is read-only — it lists directories
(`list_dir`, added for structured `{name, type, size}` rows) and previews files
(`read`) — so every member of a space can browse the shared machine safely.

## Configuration

Credentials are read from the **container environment only** — never from the
signal payload, so a prompt-injected agent cannot redirect the tool at another
Vercel account.

| env | meaning |
|---|---|
| `VERCEL_TOKEN` | API token (also accepts `VERCEL_API_TOKEN` / `VERCEL_ACCESS_TOKEN`) |
| `VERCEL_TEAM_ID` | team the sandboxes are billed to |
| `VERCEL_PROJECT_ID` | project that owns the named sandboxes |
| `VERCEL_SANDBOX_RUNTIME` | default runtime (`node24`) |
| `VERCEL_SANDBOX_TIMEOUT_MS` | session lifetime before auto-stop (45 min) |
| `VERCEL_SANDBOX_VCPUS` | vCPUs, memory is `vcpus * 2048` MB (2) |
| `VERCEL_SANDBOX_PREFIX` | sandbox name prefix (`decillion`) |
| `VERCEL_SANDBOX_MAX_OUTPUT` | chars of command output returned (60000) |

Deploy it with `scripts/deploy_sandbox_tool.py`, which bakes those values into
the creature image and prints the ids Nest needs.
