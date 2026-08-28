# zapier — every app the user connected, inside the space

A Davinci tool creature (Caspar `docker` entity) that gives a Decillion **space
the user's own apps**: Gmail, Slack, Google Calendar, Sheets, Notion, HubSpot,
Jira, Trello — anything Zapier integrates. A member connects their Zapier account
and authorizes each app once from the tool's Connect screen; after that the
space's agents can act in those apps on their behalf, and people can drive the
same actions by hand from the Victor mini-app.

```
Victor "Zapier" mini-app ─host.call▶ client ─signal(as the user)▶ zapier creature ─MCP/HTTPS▶ mcp.zapier.com
     (the space desktop)                                               │                          │
space agents ─backbone bridge▶ signal ─────────────────────────────────┘             Zapier holds the
                                                                                    app OAuth creds
```

One creature serves **every** space; the binding is per-space state (which Zapier
server a member connected), keyed by the space id, so nothing is deployed per
space and any space that adds the tool from its tool-management page gets it.

## What it talks to

Zapier's **MCP server**, over Streamable HTTP:

```
https://mcp.zapier.com/api/v1/connect?token=<connection token>
```

The connection token is the credential for one Zapier MCP server, and that
server's tool list *is* the set of actions its owner authorized — one MCP tool per
app action (`gmail_send_email`, `google_calendar_find_event`,
`slack_send_channel_message`, …). Zapier holds the third-party OAuth credentials,
so **no Gmail/Slack/HubSpot token ever reaches this creature or an agent** — only
Zapier's own.

The token rides both the `Authorization: Bearer …` header and the `?token=` query
parameter (Zapier documents either), and the creature speaks the protocol
directly: `initialize` → `notifications/initialized` → `tools/list` (paged) →
`tools/call`. Responses come back as plain JSON *or* as a one-message
`text/event-stream`; both are parsed. A session id issued on `initialize` is
echoed on every later request, and the documented 404-when-the-session-expired
failure is recovered transparently by re-initializing once and retrying.

## Whose Zapier?

Three tiers, resolved per caller, most specific first:

| tier | where it comes from | who uses it |
|---|---|---|
| **personal** | a member connected their own account with `scope: "personal"` | that member |
| **space** | a member connected an account for the project | the space + **its agents** (shared by default; the owner can make it private) |
| **platform** | `ZAPIER_MCP_TOKEN`, baked into the image at deploy from the repository's GitHub secret | everyone, as the fallback |

A private space connection is not an error for anyone else — they simply fall
through to the platform workspace, so the tool keeps working. Only the member who
connected a connection can re-connect, share, or disconnect it.

Every credential comes from the container environment or the node's key/value
store — **never** from a signal payload, so a prompt-injected agent can neither
swap the server nor read a token back out. `status` and every reply that echoes a
server URL mask the token; arguments echoed back mask anything credential-shaped.

## Connecting (two paths)

**Zapier MCP Embed** — the friendly one, active when `ZAPIER_MCP_EMBED_ID` is
baked in. `connect` mints a one-time handshake and returns the URL of a page this
creature serves *itself*, through the node's VM HTTP ingress at the fixed
`/{machineName}/{gatewayPath}/embed` path (machine `m-tool-zapier`, default
`gatewayPath` = `zapier`). The front-end opens it in Victor's in-app webview; the
page hosts Zapier's `<zapier-mcp>` web component, so the person picks apps and
runs each app's OAuth right there. When Zapier emits `mcp-server-url` the page
POSTs it back to `embed/claim`, and the creature stores that personal server. The
space and owner come from the **stored handshake**, never the request, so a forged
claim cannot bind a server to a space it did not start; a claimed URL must also
sit under the Zapier origin. The front-end long-polls `connect_wait`, so the UI
needs no timer. Register the ingress origin once in Zapier's embed
allowed-domains config — the URL is stable across redeploys.

**Connection token** — always available. The front-end opens Zapier, the person
adds apps and authorizes accounts there, then pastes the server's connection
token (or its full URL). The tool verifies it by listing the server's actions
before storing it, so a bad paste fails immediately instead of at the first run.

## Efficiency: three steps, not one dump

A Zapier account can expose hundreds of actions whose JSON schemas run to tens of
thousands of tokens, so the agent never receives the raw list:

1. `apps` — the connected apps, with how many actions each has (a couple of dozen
   rows at most). Apps are inferred from the action names: the first segment,
   extended to the second when that second segment is not an action verb — which
   is what separates `google_calendar` (an app) from `gmail_send` (app + verb).
2. `actions` — search (`query`) and/or scope (`app`) the action list; returns
   compact `{name, app, title, summary}` rows, never schemas.
3. `describe` — one action's parameters, then `run`.

The action list is fetched once per server and cached in memory **and** in the
node's key/value store (`ZAPIER_TOOLS_TTL_S`, default 600s), so repeated agent
turns cost one HTTP round trip rather than a re-enumeration. `refresh` drops it
after the person adds apps in Zapier.

`run` resolves a near-miss name rather than failing on it (an agent that asks for
`gmail_send_an_email` gets `gmail_send_email`, with `resolved_from` recorded); a
genuinely ambiguous name comes back as ranked `candidates` instead. A failure that
looks like a missing app authorization is flagged `needs_auth: true` with the
Zapier URLs attached, so the agent tells the person to reauthorize instead of
retrying forever.

## Actions

| function | what it does |
|---|---|
| `status` | which Zapier server this caller uses, who owns it, how many apps/actions (the default) |
| `apps` | the connected apps, with action counts |
| `actions` | search/list the actions (`query`, `app`, `limit`) — compact rows |
| `describe` | one action's parameters (`tool` = its exact name) |
| `run` | execute one (`tool` + `params` object and/or plain-English `instructions`) |
| `connect` | start or complete connecting an account (`token`, or the embed handshake) |
| `connect_wait` | server-paced wait for the embed handshake to land (front-end) |
| `disconnect` | drop a stored connection (owner only) |
| `set_shared` | owner-only: may the space and its agents use this connection |
| `refresh` | re-read the action list from Zapier |

`run` passes `params` through verbatim and adds `instructions`; Zapier fills any
field left out from that natural-language brief, so a short brief plus the fields
that must be exact is usually the right call.

> **`action` is never a Zapier action name.** That key selects this creature's own
> operation, and it is honoured only when it names one — a Zapier action goes in
> `tool`. An unknown `function` that looks like an action name is treated as a
> `run`, so an agent that reaches for `gmail_send_email` directly still works.

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity `zapier`)
and a downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/zapier.js`). The front-end is an Elpian-based JS app that runs in the
Decillion client's Victor host — the space "desktop" — not on the node. It is the
connect surface (embed panel via `host:openWebview`, or the token path via
`host:openUrl`), an app/action browser, a per-action parameter form that runs the
action, a result view that offers "Fix in Zapier" when an account needs
reauthorizing, and a settings screen for sharing and disconnecting. In widget mode
it renders `@tool zapier …` chat replies as cards.
`deploy_zapier_tool.py` deploys it as a `downloadable` `javascript` entity right
after the back-end, so any space with the tool gets its UI for free.

## Configuration

| env | meaning |
|---|---|
| `ZAPIER_MCP_TOKEN` | the platform workspace's Zapier connection token (GitHub secret; aliases `ZAPIER_AUTH_TOKEN`, `ZAPIER_TOKEN`, `ZAPIER_MCP_AUTH_TOKEN`, `ZAPIER_API_KEY`) |
| `ZAPIER_MCP_URL` | the MCP endpoint (default `https://mcp.zapier.com/api/v1/connect`) |
| `ZAPIER_MCP_SERVER_URL` | a fully-formed platform server URL; wins over the token |
| `ZAPIER_MCP_EMBED_ID` / `ZAPIER_MCP_EMBED_SECRET` | Zapier MCP Embed — the in-app connect panel |
| `ZAPIER_MCP_EMBED_SCRIPT` | the embed web-component script (default Zapier's) |
| `ZAPIER_MCP_SERVER_PREFIX` | origin an embed-issued server URL must sit under (default `https://mcp.zapier.com/`) |
| `ZAPIER_VM_HTTP_INGRESS_BASE` | the node's public VM-ingress origin, so the embed page has an absolute URL |
| `ZAPIER_MCP_HOME_URL` / `ZAPIER_CONNECTIONS_URL` | where the UI sends people to manage apps |
| `ZAPIER_PLATFORM_LABEL` | what the platform workspace is called in the UI |
| `ZAPIER_TOOLS_TTL_S` | action-list cache TTL, seconds (600) |
| `ZAPIER_LIST_LIMIT` / `ZAPIER_LIST_CAP` | default / maximum `actions` rows (40 / 200) |
| `ZAPIER_MAX_OUTPUT` | max chars of a run's output returned (40 000) |
| `ZAPIER_HTTP_TIMEOUT` / `ZAPIER_CALL_TIMEOUT` | per-request timeouts, seconds (60 / 120) |
| `ZAPIER_HANDSHAKE_TTL_S` | how long a connect link stays valid (1800) |
| `ZAPIER_MCP_PROTOCOL_VERSION` | MCP protocol version header (`2025-06-18`) |

## Deploy

`scripts/deploy_zapier_tool.py` bakes the token (and any embed config) into the
image, deploys the back-end + front-end, binds the fixed gateway route for the
connect panel, registers the tool in the on-chain platform registry (so the
client's tool manager lists it as an addable tool) and its chat commands, and
starts it as a long-lived serving creature. It is driven by
decillionai-server's manual `deploy-zapier-tool.yml` workflow
(`scripts/deploy-caspar-external.sh zapier`), which reads `ZAPIER_MCP_TOKEN` from
the repository's GitHub secrets. With no token the tool still deploys and works —
each space then connects its own Zapier account.
