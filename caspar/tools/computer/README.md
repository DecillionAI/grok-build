# computer — the space's UI-browser-over-VNC creature

A Davinci tool creature (Caspar `docker` entity) that gives a Decillion **space a
real graphical computer**: a full GUI web browser running on a virtual desktop,
streamed live over VNC. The people in the space **watch and drive it** with mouse
/ touch / keyboard inside the app; the space's **agents drive the same desktop**
by taking screenshots and issuing click / type / key / scroll / navigate actions.
One desktop, two sets of hands.

**The desktop runs on the space's own cloud sandbox — not in this creature.** The
browser, the VNC server, the noVNC web bridge and the Cloudflare tunnel all run
on the per-space Modal / Vercel microVM the **`sandbox` tool** provisions. This
creature is an **orchestrator**: it drives the `sandbox` tool over the Caspar
signalling API (`exec` / `write` / `read`) — exactly the terminal / filesystem
operations the sandbox tool performs on Modal / Vercel — to install and run the
desktop there.

```
                    computer creature (this) ── bridge.invoke_tool ──▶ sandbox creature
                        │  (orchestrates)                                   │ exec/write/read
Victor "Computer" ──host.call▶ client ─signal─┘                            ▼
   mini-app (opens the VNC url in Victor's webview)          the space's Modal/Vercel sandbox:
space agents ─backbone bridge▶ signal (screenshot/click/type)   Xvfb + fluxbox + Firefox + x11vnc
                                                                → noVNC (websockify) → cloudflared tunnel
```

## First open vs. every open after

- **First time in a space** — this creature makes sure the space's sandbox is up,
  then writes a provision/start script to the sandbox and runs it: it **installs**
  the desktop packages there if missing (browser, `x11vnc`, `Xvfb`, `novnc` /
  `websockify`, `xdotool`, and downloads `cloudflared`), starts every daemon, and
  opens a **Cloudflare quick tunnel** to the noVNC port — **streaming the
  sandbox's install log** back to the front-end. When the tunnel publishes its
  public URL, `open` returns it.
- **Every open after** — this creature runs a quick detect script on the sandbox;
  if the desktop's processes are alive and it has a published URL, it returns that
  URL immediately, skipping the install.

The front-end (`frontend/computer.js`) opens automatically, streams the install
log (a self-chaining long-poll — the Victor guest VM has no timer), and the
moment the desktop is `ready` it opens the public VNC page in **Victor's in-app
webview/iframe** via the `host:openWebview` client capability. From there the
person interacts with the live browser directly.

## Why a docker creature (not WASM)

It must hold a long-lived gateway connection and drive a **sibling tool** over it
(`bridge.invoke_tool` → the `sandbox` creature); a TinyGo WASM creature cannot.
Because the heavy graphical stack lives on the sandbox, **this image is thin** —
just Python + the shared runtime/bridge.

## The space ↔ desktop binding

Every action requires `space_id`. The same `space_id` addresses the space's
sandbox (the sandbox tool derives the microVM name from it), so this creature and
the sandbox tool always mean the same machine. Agents never pass `space_id`
themselves: Nest pins it as a catalog `defaults` entry, and the billing meter
pins the authoritative space onto the front-end's arguments — so no caller can
reach another space's desktop. There is one desktop per sandbox (fixed display
`:99`, ports 5900/6080 on the sandbox).

## Actions

| function | what it does |
|---|---|
| `open` | provision (first time — streams the sandbox's install log) or reuse the space's desktop; returns its phase and, once ready, the public VNC `url` |
| `status` | phase (`idle`\|`installing`\|`ready`\|`error`), the ready `url`, and new install-log lines since your `cursor`. Long-polls (`wait` seconds) while installing |
| `url` | just the ready public VNC url (or a not-ready message) |
| `screenshot` | capture the desktop screen (via `scrot` on the sandbox, read back over the sandbox's `read`), return a base64 `image` (`format`=png\|jpeg) |
| `click` | click at `x`,`y` (`button`=left\|right\|middle, `double`) via `xdotool` on the sandbox |
| `move` | move the pointer to `x`,`y` |
| `type` | type `text` into the focused element |
| `key` | press a key/chord (`key`, e.g. `Return`, `ctrl+l`, `alt+Tab`) |
| `scroll` | scroll `to`=up\|down (or a `dy` pixel delta) |
| `navigate` | open a `url` in the desktop browser |
| `stop` | kill the desktop's processes on the sandbox (keeps the installed packages) |
| `restart` | rebuild the desktop from scratch |
| `delete` | stop and forget the space's desktop |

Screenshots come back base64-encoded and capped (`COMPUTER_MAX_SHOT_BYTES`) so
they fit under the node's signal-frame limit — a too-large PNG is re-encoded to
JPEG on the sandbox before it is returned.

## The front-end (the space desktop)

Two parts on one program: this docker back-end (entity `computer`) and a
downloadable Victor mini-app **front-end** (entity `frontend`,
`frontend/computer.js`). The front-end runs in the client's Victor host — it
drives provisioning and streams the log over the host bridge and, once ready,
opens the VNC page in Victor's webview. `deploy_computer_tool.py` deploys it as a
`downloadable` `javascript` entity right after the back-end.

Opening the VNC in the webview needs a small **client capability**,
`host:openWebview` (see `new-decillion` `VictorDesktop.tsx`): on web it layers an
`<iframe>` (allowing camera/microphone/fullscreen/clipboard) over the tool sheet;
off the web it falls back to the system browser.

## Configuration

Baked into the image by `deploy_computer_tool.py`; read from the container
environment only (never the signal payload).

| env | meaning |
|---|---|
| `COMPUTER_SANDBOX_PROGRAM_ID` | the `sandbox` tool's program id this creature drives (defaults to the manifest's `davinci.tools["sandbox"]`) |
| `COMPUTER_SANDBOX_ENTITY_ID` | the sandbox tool's entity id (default `sandbox`) |
| `COMPUTER_SCREEN_W` / `COMPUTER_SCREEN_H` | virtual screen size on the sandbox (1440×900) |
| `COMPUTER_BROWSER_PACKAGE` / `COMPUTER_BROWSER_BIN` | the GUI browser to install/run (default `firefox-esr`) |
| `COMPUTER_HOME_URL` | the page the browser opens on (default DuckDuckGo) |
| `COMPUTER_VNC_PASSWORD` | optional VNC password (embedded in the URL); empty = open (the tunnel URL is the secret) |
| `COMPUTER_TUNNEL_TIMEOUT_S` | how long the sandbox waits for the tunnel URL (90) |
| `COMPUTER_PROVISION_TIMEOUT_S` | how long this creature streams the install before giving up (480) |
| `COMPUTER_MAX_SHOT_BYTES` | screenshot byte cap (3.5 MB) |
| `COMPUTER_DISPLAY` / `COMPUTER_VNC_PORT` / `COMPUTER_WEB_PORT` | on-sandbox display / ports (`:99` / 5900 / 6080) |

## Deploy

`scripts/deploy_computer_tool.py` builds the (thin) image, bakes in the sandbox
tool's program id, deploys the back-end + front-end, registers the tool in the
on-chain platform registry (so `MarketService.listTools` lists it as an addable
tool) and its chat commands, and starts it as a long-lived serving creature.
**The `sandbox` tool must be deployed before this one** so its program id can be
resolved from the manifest. Trigger it by hand via the `deploy-computer-tool.yml`
workflow (like the other tools) — it is not part of push CI.
