# browser_automation — the space's headless-browser creature

A Davinci tool creature (Caspar `docker` entity) that gives a Decillion **space a
real headless browser**. Both the space's agents (through the agent backbone's
bridge executor) and people (through the tool's Victor mini-app) drive it with the
same contract: open pages, read the rendered text/HTML, click, type into and
submit forms, run JavaScript, follow links, scroll, screenshot, and export PDFs.

```
Victor "Browser" mini-app ─host.call▶ client ─signal(as the user)▶ browser_automation creature
     (the space desktop)                                               │  Playwright ▶ headless Chromium
space agents ─backbone bridge▶ signal ─────────────────────────────────┘
```

It runs **Chromium via Playwright inside the container**, so it can do what a
plain HTTP fetch (the `web_search` tool's `fetch`) cannot: JavaScript-rendered
sites, logins, forms, and multi-step flows. The image is large by design — the
browser and its system libraries are baked in (`playwright install --with-deps
chromium`), so nothing is downloaded at runtime.

## Sessions

Every call runs against a **session** — an isolated browser context (its own
cookies/storage) plus one page. The session key is the caller's space plus an
optional `session` name, so:

- all of a space's steps share one browser and one login by default (`session`
  omitted → the shared session for that space);
- passing a distinct `session` name opens a second parallel tab.

Sessions are created lazily on first use, capped (`BROWSER_MAX_SESSIONS`, LRU
eviction) and idle-reaped (`BROWSER_SESSION_IDLE_S`). With no space bound (a raw
call) a shared `default` session is used.

## Thread-safety

Playwright's sync API is bound to its creating thread, but the tool runtime
dispatches each signal on its own worker thread. So **all** browser work runs on a
single dedicated worker thread and every `invoke` submits its operation there and
blocks for the result — browser access is serialised, correct and safe, without
the caller knowing.

## Actions

| function | what it does |
|---|---|
| `navigate` (`goto`/`open`) | open a `url` and wait for load (`wait_until`) — the usual first step |
| `text` | rendered (visible) text of the page or a `selector` |
| `content` (`html`) | the page's current HTML (after JS has run) |
| `links` | outbound links as `{text, url}` |
| `screenshot` | base64 `image` (`format`=jpeg\|png, `full_page`, or a `selector`) |
| `click` | click a `selector` |
| `fill` / `type` | type `text` into a `selector` (optional `enter` to submit) |
| `press` | press a `key`/chord (on a `selector` or the focused element) |
| `evaluate` (`eval`) | run a JS `script` expression and return its result |
| `scroll` | scroll (`to`=top\|bottom, or `dy` pixels) |
| `wait_for` | wait for a `selector` / a load `state` / a delay |
| `back` / `forward` / `reload` | history navigation |
| `set_viewport` | resize the viewport |
| `current` | the session's URL + title |
| `pdf` | render the page to a base64 PDF |
| `sessions` / `close` | list / close browsing sessions |

Selectors are CSS or Playwright `text=` selectors. Screenshots and PDFs come back
base64-encoded and are capped (`BROWSER_MAX_SHOT_BYTES`, default 4 MB) so they fit
under the node's signal-frame limit; a too-large JPEG screenshot is retried at
lower quality before it is refused. Text/HTML are capped
(`BROWSER_MAX_TEXT_CHARS`, `BROWSER_MAX_HTML_CHARS`).

## Configuration

| env | meaning |
|---|---|
| `BROWSER_NAV_TIMEOUT_MS` | navigation timeout (45000) |
| `BROWSER_ACTION_TIMEOUT_MS` | per-action timeout (20000) |
| `BROWSER_MAX_TEXT_CHARS` / `BROWSER_MAX_HTML_CHARS` | text/HTML caps (40000 / 300000) |
| `BROWSER_MAX_SHOT_BYTES` | screenshot/PDF byte cap (4000000) |
| `BROWSER_MAX_SESSIONS` | concurrent sessions before LRU eviction (8) |
| `BROWSER_SESSION_IDLE_S` | idle session reaping (900) |
| `BROWSER_VIEWPORT_W` / `BROWSER_VIEWPORT_H` | default viewport (1280×800) |
| `BROWSER_USER_AGENT` | override the browser User-Agent |

## The front-end (the space desktop)

The tool has **two parts on one program**: this docker back-end (entity
`browser_automation`) and a downloadable Victor mini-app **front-end** (entity
`frontend`, `frontend/browser.js`). The front-end is a little browser — an address
bar plus a live screenshot of the page with back/reload/scroll — that runs in the
Decillion client's Victor host (the space "desktop"), not on the node. It reaches
this back-end over the host bridge, sharing one `desktop` session so a person can
step through a site by hand. `deploy_browser_tool.py` deploys it as a
`downloadable` `javascript` entity right after the back-end.

## Deploy

`scripts/deploy_browser_tool.py` builds the (large) Playwright image, deploys the
back-end + front-end, registers the tool in the on-chain platform registry (so
`MarketService.listTools` lists it as an addable tool), and starts it as a
long-lived serving creature so the browser stays warm between calls. `ci-deploy.sh`
runs it on every deploy, and the Nest deployer records it in the manifest under
`davinci.tools["browser_automation"]`. Because the image is multi-GB, its build
timeout is larger than the other tools' (`BROWSER_REBUILD_TIMEOUT`, default 1200s).
