# github — the space's git + GitHub client creature

A Davinci tool creature (Caspar `docker` entity) that gives a Decillion **space a
full GitHub client**: a human member connects a GitHub account, then everyone the
member allows — people **and** the space's agents — can browse organizations and
repositories and drive git and GitHub (clone, branch, commit, push, pull, merge,
open/merge pull requests, manage issues).

```
Victor "GitHub" mini-app ─host.call▶ Nest ─signal(as the user)▶ github creature ─REST▶ GitHub
     (the space desktop)             (space_id + sandbox pinned)      │
space agents ─Davinci bridge▶ signal ──────────────────────────────────┤
                                                                        │ signal(exec/read/write)
                                                          vercel_sandbox creature ─▶ the space's machine
```

One creature serves **every** space; the binding is per-space state (the OAuth
token one member connected), keyed by the space id, so nothing is deployed per
space and any space that adds the tool from its tool-management page gets it.

## The filesystem is the space's sandbox, not this container

This creature keeps **no repository files of its own**. Every clone, fetch, pull,
push, commit, branch, merge and every file read/write/delete happens on the
space's **vercel_sandbox** creature — the same machine the space's agents and the
Files desktop use — reached by signalling that creature over Caspar
(`bridge.invoke_tool` → the sandbox's `exec`/`read`/`write`/`list_dir`). So a repo
cloned here is on the one shared filesystem everyone in the space sees, under
`~/github/<owner>__<repo>`. Git authenticates with the token passed to the sandbox
**in the command's environment** (never in the command string or the repo's
stored config).

**Discovery is on Caspar, not through the backend.** The creature finds the
sandbox itself, the same way the agent backbone discovers a space's tools: it
reads the space store's members over the gateway (`readMembers`), fetches each
member creature's descriptor (`getCreature`), and picks the space's **execution**
tool (the sandbox). The result is cached briefly and re-resolved if a signal
fails (e.g. the sandbox was re-minted). The NestJS proxy pins only the `space_id`
on a call — it is never in the creature↔creature routing path, so the tool can
only ever drive *its own* space's machine (the one that store's members list).

## Connecting (OAuth web application flow)

The connect button uses GitHub's standard **web application flow** — the same
"press Connect → GitHub opens in a tab → approve → done" flow every other GitHub
app uses, with **no code to type**:

1. `oauth_start` → the creature returns the GitHub `authorize_url` (carrying a
   one-time `state` that also encodes the space id) and records the handshake.
2. The front-end opens that URL in a browser tab (via the host's `host:openUrl`
   capability).
3. The user picks the **account + organizations** to grant and approves.
4. GitHub redirects the tab to the creature's own **fixed callback URL** with
   `?code&state`. The callback is served *inside the container* by the tool's
   `http_handler`, reached through the Caspar VM gateway at the deterministic
   `/{creatureUsername}/{gatewayPath}/oauth/callback` ingress path (default
   `gatewayPath` = `github`; bound at deploy via `deploy_github_tool.py`). The
   handler swaps the code for a token and stores it — no Nest route involved. The
   URL is stable across redeploys (the node re-points the route at each fresh
   serving instance), so it is registered once as the OAuth app's callback URL
   and as `GITHUB_OAUTH_REDIRECT_URI`. The tab shows "connected" and closes.
5. The front-end long-polls `oauth_wait` and flips to the dashboard once the token
   lands — server-paced, so it needs no client-side timer.

The client secret never leaves the creature (the exchange runs there), and the
space + owner come from the creature's stored handshake, not the callback request,
so a forged callback cannot bind a token to a space it did not start. The member
who started the flow **owns** the connection.

## Sharing

A per-space **shared** toggle (owner-only, `set_shared`) decides who may *use* the
connection:

- **private** (default) — only the member who connected it. Every other caller,
  human or agent, is refused with a clear message.
- **shared** — everyone in the space, including the agents, may drive it.

`status` is always readable (so the UI can show "connected as …"); only *using*
the connection is gated. Only the owner can flip sharing or disconnect.

## Actions

| function | what it does |
|---|---|
| `status` | connection state, account, sharing, and whether the caller may use/manage it |
| `oauth_start` / `oauth_wait` | web-flow connect (front-end): get the authorize URL, then wait for the callback |
| `oauth_exchange` | swap the callback's `code` for a token (called by the in-container callback `http_handler`) |
| `set_shared` / `disconnect` | owner-only settings |
| `orgs` | the connected user + the orgs they granted |
| `repos` | repositories (optionally scoped to an `org`) |
| `repo` / `branches` / `commits` | repository detail, branches, commits |
| `pulls` / `get_pull` / `create_pull` / `merge_pull` / `update_pull` | pull requests |
| `issues` / `create_issue` | issues |
| `clone` | clone a repo into the space (idempotent) |
| `pull` / `push` / `fetch` | sync a clone with origin |
| `commit` | stage + commit (`message`, optional `files`) |
| `checkout` / `branch` / `merge` | branch + merge in the clone |
| `git_status` / `git_log` | clone state |
| `read_file` / `write_file` / `delete_file` / `list_dir` / `list_cloned` | files in the clone (on the sandbox) |

Every action requires `space_id`, pinned by Nest for front-end calls and by the
space membership for agents — a caller can never name another space.

Git authenticates with the token injected per-invocation via `http.extraheader`,
so the token is **never** written into a repo's stored remote or config, and it
is scrubbed from any git output echoed back.

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`github`) and a downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/dashboard.js`). The front-end is an Elpian-based JS app that runs in the
Decillion client's Victor host — the space "desktop" — not on the node.
`deploy_github_tool.py` deploys it as a `downloadable` `javascript` entity right
after the back-end, so any space with the tool gets its UI for free.

It reaches this back-end over the client's **host bridge**: it calls
`hostCall("<function>", args, cb)`, the client signs the matching Caspar signal
with the **human user's** identity (pinning `space_id`) and returns the reply. To
open the GitHub authorization page it calls the client capability
`hostCall("host:openUrl", { url })`, handled by the client rather than the
back-end (see `new-decillion` `VictorDesktop`).

## Configuration

Credentials are read from the **container environment only** — never from the
signal payload, so a prompt-injected agent cannot swap the OAuth app.

| env | meaning |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | the GitHub OAuth App / GitHub App client id |
| `GITHUB_OAUTH_CLIENT_SECRET` | **required** — the web flow signs the token exchange with it |
| `GITHUB_OAUTH_REDIRECT_URI` | **required** — the creature's fixed in-container callback (`…/{creatureUsername}/{gatewayPath}/oauth/callback`, logged by `deploy_github_tool.py` as `GITHUB_OAUTH_CALLBACK_INGRESS`); must **exactly** match the OAuth app's "Authorization callback URL" |
| `GITHUB_OAUTH_SCOPES` | default `repo,read:org,workflow,read:user` |
| `GITHUB_OAUTH_STATE_TTL_S` | how long a pending connect stays valid (default `900`) |

> **CI note:** GitHub Actions forbids secret/variable names starting with the
> reserved `GITHUB_` prefix. Provide the app under the `GH_OAUTH_CLIENT_ID`,
> `GH_OAUTH_CLIENT_SECRET`, `GH_OAUTH_SCOPES` aliases — `ci-deploy.sh` and
> `deploy_github_tool.py` map them to the `GITHUB_OAUTH_*` names above (a Docker
> ENV has no such restriction).
| `GITHUB_API_BASE` | default `https://api.github.com` (set for GitHub Enterprise) |
| `GITHUB_WEB_BASE` | default `https://github.com` |
| `GITHUB_MAX_OUTPUT` | chars of git/API output returned (60000) |
| `GITHUB_GIT_TIMEOUT_S` | per-git-command timeout (600) |

State survives the container in the node's key/value store (over the docker-host
bridge); a node whose `dbOp` is unavailable falls back to a JSON file under
`GITHUB_WORKSPACE` (`/workspace`), so the tool always works and is durable when
the store is present.

Deploy it with `scripts/deploy_github_tool.py`, which bakes those values into the
creature image and prints the ids Nest needs. `ci-deploy.sh` runs it whenever a
`GITHUB_OAUTH_CLIENT_ID` is configured, and the deployer records it in the
manifest under `davinci.tools["github"]` so it appears on the space tool-manager.
