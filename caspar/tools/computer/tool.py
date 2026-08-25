"""computer — the space's UI-browser-over-VNC creature.

A Davinci tool creature (Caspar ``docker`` entity) that gives every Decillion
space a **real graphical browser** the humans in the space watch and drive with
their mouse / touch / keyboard, and that the space's agents drive
programmatically (screenshot + click/type/key) — the same desktop, two sets of
hands.

Crucially, this creature owns **no desktop of its own**. The graphical browser,
the VNC server, the noVNC web bridge and the Cloudflare tunnel all run **on the
space's own cloud sandbox** — the per-space Modal / Vercel microVM the ``sandbox``
tool provisions. This creature is an *orchestrator*: it drives the ``sandbox``
tool over the Caspar signalling API (``exec`` / ``write`` / ``read``) to install
and run the desktop there, exactly the terminal / filesystem operations the
sandbox tool performs on Modal / Vercel.

```
                    computer creature (this) ── bridge.invoke_tool ──▶ sandbox creature
                        │  (orchestrates)                                   │ exec/write/read
Victor "Computer" ──host.call▶ client ─signal─┘                            ▼
   mini-app (opens the VNC url in Victor's webview)          the space's Modal/Vercel sandbox:
space agents ─backbone bridge▶ signal (screenshot/click/type)   Xvfb + WM + browser + x11vnc
                                                                → noVNC (websockify) → cloudflared tunnel
```

First open in a space: this creature makes sure the space's sandbox is up, then —
if the desktop isn't installed there yet — writes an install/start script to the
sandbox and runs it, **streaming the sandbox's install log** back to the
front-end. Once the sandbox's cloudflared tunnel publishes its public URL, that
URL is returned; the front-end opens it in Victor's webview/iframe, where the
person interacts with the live browser. Every later open **detects** the desktop
is already running on the sandbox (its processes are alive and it has published a
URL) and returns that URL, skipping the install.

Why a docker creature (not WASM): it must hold a long-lived gateway connection
and drive a sibling tool over it (``bridge.invoke_tool``); a TinyGo WASM creature
cannot. The heavy graphical stack lives on the sandbox, so this image stays thin.

Binding: one desktop per space, keyed by ``space_id`` — Nest pins that as a
catalog default (agents) and the billing meter pins the authoritative space onto
the front-end's arguments (people), so no caller can reach another space's
desktop. The same ``space_id`` addresses the space's sandbox, so this creature
and the sandbox tool always mean the same machine.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Configuration (baked into the image by scripts/deploy_computer_tool.py)
# --------------------------------------------------------------------------- #

def _int_env(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, "")).strip() or default)
    except (TypeError, ValueError):
        return default


# The sandbox tool this creature drives. Its program id is baked in at deploy
# time from the manifest (`davinci.tools["sandbox"].programId`); the entity/tool
# id default to "sandbox". Without a program id this creature cannot reach the
# space's sandbox and every action fails with a clear message.
SANDBOX_PROGRAM_ID = os.environ.get("COMPUTER_SANDBOX_PROGRAM_ID", "").strip()
SANDBOX_ENTITY_ID = os.environ.get("COMPUTER_SANDBOX_ENTITY_ID", "sandbox").strip() or "sandbox"
SANDBOX_TOOL_ID = os.environ.get("COMPUTER_SANDBOX_TOOL_ID", "sandbox").strip() or "sandbox"

# The virtual screen the browser and VNC share, on the sandbox.
SCREEN_W = _int_env("COMPUTER_SCREEN_W", 1440)
SCREEN_H = _int_env("COMPUTER_SCREEN_H", 900)

# Which GUI browser to install/run on the sandbox (the package + its binary).
# Firefox ESR runs as root without a sandbox flag, so it is the least fragile.
BROWSER_PACKAGE = os.environ.get("COMPUTER_BROWSER_PACKAGE", "firefox-esr").strip() or "firefox-esr"
BROWSER_BIN = os.environ.get("COMPUTER_BROWSER_BIN", "firefox-esr").strip() or "firefox-esr"
HOME_URL = os.environ.get("COMPUTER_HOME_URL", "https://duckduckgo.com").strip() or "https://duckduckgo.com"

# Optional VNC password (embedded in the noVNC URL so the webview connects without
# a prompt). Empty = open desktop — the tunnel URL is already an unguessable secret.
VNC_PASSWORD = os.environ.get("COMPUTER_VNC_PASSWORD", "").strip()

# On-sandbox layout. One desktop per sandbox (== per space), so fixed display/ports.
REMOTE_DIR = ".decillion-computer"       # relative to the sandbox home dir
REMOTE_DISPLAY = os.environ.get("COMPUTER_DISPLAY", ":99").strip() or ":99"
REMOTE_VNC_PORT = _int_env("COMPUTER_VNC_PORT", 5900)
REMOTE_WEB_PORT = _int_env("COMPUTER_WEB_PORT", 6080)

# Timeouts.
SANDBOX_BOOT_TIMEOUT_S = _int_env("COMPUTER_SANDBOX_BOOT_TIMEOUT_S", 240)
EXEC_TIMEOUT_S = _int_env("COMPUTER_EXEC_TIMEOUT_S", 60)
PROVISION_TIMEOUT_S = _int_env("COMPUTER_PROVISION_TIMEOUT_S", 480)
TUNNEL_WAIT_S = _int_env("COMPUTER_TUNNEL_TIMEOUT_S", 90)
MAX_SHOT_BYTES = _int_env("COMPUTER_MAX_SHOT_BYTES", 3_500_000)
MAX_LOG_LINES = _int_env("COMPUTER_MAX_LOG_LINES", 400)

# Phases a desktop moves through; the front-end drives its UI off these.
PHASE_IDLE = "idle"
PHASE_INSTALLING = "installing"
PHASE_READY = "ready"
PHASE_ERROR = "error"

_TRY_CF_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


# --------------------------------------------------------------------------- #
# The on-sandbox provision/start script + a quick detect script
# --------------------------------------------------------------------------- #
#
# These run *on the space's sandbox* (through the sandbox tool's `exec`), not in
# this container. `provision.sh` installs the desktop (only if missing), starts
# every daemon, opens the Cloudflare quick tunnel and writes the public URL to
# `$DIR/url`; it echoes each step so `exec`'s captured output streams to the
# front-end. `detect.sh` reports whether the desktop is installed and running.

_PROVISION_SCRIPT = r'''#!/bin/sh
set -u
DIR="$HOME/''' + REMOTE_DIR + r'''"
mkdir -p "$DIR"
DISP="''' + REMOTE_DISPLAY + r'''"
GEOM="''' + str(SCREEN_W) + r'''x''' + str(SCREEN_H) + r'''x24"
BROWSER_BIN="''' + BROWSER_BIN + r'''"
BROWSER_PKG="''' + BROWSER_PACKAGE + r'''"
HOME_URL="''' + HOME_URL + r'''"
VNC_PORT="''' + str(REMOTE_VNC_PORT) + r'''"
WEB_PORT="''' + str(REMOTE_WEB_PORT) + r'''"
VNCPW="''' + VNC_PASSWORD + r'''"

have(){ command -v "$1" >/dev/null 2>&1; }
SUDO=""
[ "$(id -u)" = "0" ] || { have sudo && SUDO="sudo"; }

# --- 1. install the desktop packages, only if they are missing -------------
if ! have Xvfb || ! have x11vnc || ! have websockify || { ! have "$BROWSER_BIN" && ! have firefox && ! have chromium && ! have chromium-browser; }; then
  echo "INSTALL: installing the graphical desktop (browser + VNC + noVNC) on the sandbox…"
  if have apt-get; then
    $SUDO apt-get update -y || true
    DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox "$BROWSER_PKG" novnc websockify xdotool scrot imagemagick x11-utils ca-certificates curl \
      || echo "INSTALL: apt-get reported errors (continuing)"
  elif have apk; then
    $SUDO apk add --no-cache xvfb x11vnc fluxbox "$BROWSER_PKG" novnc websockify xdotool scrot imagemagick curl \
      || echo "INSTALL: apk reported errors (continuing)"
  elif have dnf; then
    $SUDO dnf install -y xorg-x11-server-Xvfb x11vnc fluxbox "$BROWSER_PKG" novnc python3-websockify xdotool scrot ImageMagick curl \
      || echo "INSTALL: dnf reported errors (continuing)"
  else
    echo "INSTALL: no supported package manager (apt/apk/dnf) — cannot install"
  fi
else
  echo "INSTALL: desktop packages already present — skipping"
fi

# --- cloudflared (a single static binary; kept under $DIR) -----------------
CF="$DIR/cloudflared"
if [ ! -x "$CF" ]; then
  echo "INSTALL: fetching the Cloudflare tunnel client…"
  a="$(uname -m)"
  case "$a" in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; *) a=amd64 ;; esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a" -o "$CF" \
    && chmod +x "$CF" || echo "INSTALL: could not fetch cloudflared"
else
  echo "INSTALL: cloudflared already present — skipping"
fi

if ! have "$BROWSER_BIN"; then
  for b in firefox firefox-esr chromium chromium-browser; do have "$b" && { BROWSER_BIN="$b"; break; }; done
fi

NOVNC=""
for d in /usr/share/novnc /usr/share/webapps/novnc; do [ -d "$d" ] && { NOVNC="$d"; break; }; done

# --- 2. (re)start the daemons (idempotent) ---------------------------------
pkill -f "Xvfb $DISP" 2>/dev/null || true
echo "START: virtual display $DISP ($GEOM)"
setsid Xvfb "$DISP" -screen 0 "$GEOM" -nolisten tcp -ac >"$DIR/xvfb.log" 2>&1 &
echo $! >"$DIR/xvfb.pid"
sleep 2
export DISPLAY="$DISP"
export HOME="$HOME"

if have fluxbox; then
  echo "START: window manager"
  setsid fluxbox >"$DIR/wm.log" 2>&1 &
  echo $! >"$DIR/wm.pid"
  sleep 1
fi

echo "START: launching the browser"
case "$BROWSER_BIN" in
  *chrom*)
    setsid "$BROWSER_BIN" --no-sandbox --disable-dev-shm-usage --user-data-dir="$DIR/profile" \
      --window-position=0,0 --start-maximized --no-first-run "$HOME_URL" >"$DIR/browser.log" 2>&1 &
    ;;
  *)
    setsid "$BROWSER_BIN" --no-remote --profile "$DIR/profile" "$HOME_URL" >"$DIR/browser.log" 2>&1 &
    ;;
esac
echo $! >"$DIR/browser.pid"
sleep 2

pkill -f "x11vnc.*$DISP" 2>/dev/null || true
echo "START: VNC server on port $VNC_PORT"
if [ -n "$VNCPW" ]; then PWARG="-passwd $VNCPW"; else PWARG="-nopw"; fi
setsid x11vnc -display "$DISP" -forever -shared -noxdamage -rfbport "$VNC_PORT" $PWARG >"$DIR/x11vnc.log" 2>&1 &
echo $! >"$DIR/vnc.pid"
sleep 1

pkill -f "websockify.*$WEB_PORT" 2>/dev/null || true
echo "START: noVNC web bridge on port $WEB_PORT"
if [ -n "$NOVNC" ]; then
  setsid websockify --web "$NOVNC" "0.0.0.0:$WEB_PORT" "127.0.0.1:$VNC_PORT" >"$DIR/novnc.log" 2>&1 &
else
  setsid websockify "0.0.0.0:$WEB_PORT" "127.0.0.1:$VNC_PORT" >"$DIR/novnc.log" 2>&1 &
fi
echo $! >"$DIR/novnc.pid"
sleep 1

pkill -f "cloudflared.*$WEB_PORT" 2>/dev/null || true
rm -f "$DIR/url"
echo "START: opening a secure Cloudflare tunnel"
setsid "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$WEB_PORT" >"$DIR/cloudflared.log" 2>&1 &
echo $! >"$DIR/tunnel.pid"

# --- 3. wait for the public URL and record it ------------------------------
i=0
while [ $i -lt ''' + str(TUNNEL_WAIT_S) + r''' ]; do
  u="$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$DIR/cloudflared.log" 2>/dev/null | head -n1)"
  if [ -n "$u" ]; then printf '%s' "$u" >"$DIR/url"; echo "READY: $u"; break; fi
  i=$((i+1)); sleep 1
done
[ -s "$DIR/url" ] || echo "ERROR: the tunnel did not publish a URL in time"
echo "PROVISION_DONE"
'''

_DETECT_SCRIPT = r'''#!/bin/sh
DIR="$HOME/''' + REMOTE_DIR + r'''"
have(){ command -v "$1" >/dev/null 2>&1; }
inst=MISSING
if have Xvfb && have x11vnc && have websockify && [ -x "$DIR/cloudflared" ] && \
   { have ''' + BROWSER_BIN + r''' || have firefox || have chromium || have chromium-browser; }; then
  inst=INSTALLED
fi
run=DOWN
url=""
if [ -f "$DIR/tunnel.pid" ] && kill -0 "$(cat "$DIR/tunnel.pid" 2>/dev/null)" 2>/dev/null && [ -s "$DIR/url" ]; then
  run=UP; url="$(cat "$DIR/url" 2>/dev/null)"
fi
echo "INST=$inst"
echo "RUN=$run"
echo "URL=$url"
'''


# --------------------------------------------------------------------------- #
# Desktop state (per space, in THIS container — the sandbox holds the real thing)
# --------------------------------------------------------------------------- #

class Desktop:
    def __init__(self, space_id: str) -> None:
        self.space_id = space_id
        self.phase = PHASE_IDLE
        self.url: str = ""
        self.error: str = ""
        self.installed = False
        self.lock = threading.Lock()
        self._log: List[str] = []
        self._provisioning = False
        self._remote_log_off = 0  # bytes of the sandbox install.log already mirrored

    def log(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        entry = "[" + stamp + "] " + str(line).rstrip()
        with self.lock:
            self._log.append(entry)
            if len(self._log) > MAX_LOG_LINES:
                self._log = self._log[-MAX_LOG_LINES:]
        print("COMPUTER_LOG " + entry, flush=True)

    def logs_from(self, cursor: int) -> Tuple[List[str], int]:
        with self.lock:
            total = len(self._log)
            start = max(0, min(cursor, total))
            return list(self._log[start:]), total

    def snapshot(self, cursor: int = 0) -> Dict[str, Any]:
        lines, total = self.logs_from(cursor)
        return {
            "ok": self.phase != PHASE_ERROR,
            "space_id": self.space_id,
            "phase": self.phase,
            "url": self.url or None,
            "installed": self.installed,
            "ready": self.phase == PHASE_READY and bool(self.url),
            "error": self.error or None,
            "logs": lines,
            "cursor": total,
        }


_DESKTOPS: Dict[str, Desktop] = {}
_REGISTRY_LOCK = threading.Lock()
_BRIDGE = None  # the gateway bridge, set by the runtime (our route to the sandbox)


def set_bridge(bridge) -> None:  # noqa: ANN001 — runtime hook
    """Runtime hook: keep the gateway bridge. It is this creature's ONLY route to
    the sandbox tool (``bridge.invoke_tool``), so without it no desktop can be
    provisioned."""
    global _BRIDGE
    _BRIDGE = bridge


def _get_desktop(space_id: str, create: bool = True) -> Optional[Desktop]:
    with _REGISTRY_LOCK:
        desk = _DESKTOPS.get(space_id)
        if desk is None and create:
            desk = Desktop(space_id)
            _DESKTOPS[space_id] = desk
        return desk


# --------------------------------------------------------------------------- #
# Driving the sandbox tool over the gateway
# --------------------------------------------------------------------------- #

class SandboxError(RuntimeError):
    pass


def _sbx(function: str, payload: Dict[str, Any], *, timeout: float = EXEC_TIMEOUT_S) -> Dict[str, Any]:
    """Invoke one function on the space's sandbox creature and return its result.

    ``payload`` must carry ``space_id`` — that binds the call to this space's
    sandbox (the sandbox tool derives the microVM name from it)."""
    if _BRIDGE is None:
        raise SandboxError("not connected to the platform gateway — cannot reach the sandbox")
    if not SANDBOX_PROGRAM_ID:
        raise SandboxError("the sandbox tool is not configured (COMPUTER_SANDBOX_PROGRAM_ID is unset)")
    reply = _BRIDGE.invoke_tool(SANDBOX_PROGRAM_ID, SANDBOX_ENTITY_ID, function, payload,
                                tool_id=SANDBOX_TOOL_ID, timeout=timeout)
    # invoke_tool returns the tool's `{tool_id, function, result}`; unwrap `result`.
    if isinstance(reply, dict) and "result" in reply and isinstance(reply["result"], dict):
        return reply["result"]
    if isinstance(reply, dict):
        return reply
    raise SandboxError("the sandbox did not reply")


def _sbx_exec(space_id: str, command: str, *, timeout: float = EXEC_TIMEOUT_S,
              sudo: bool = False, env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"space_id": space_id, "command": command}
    if sudo:
        payload["sudo"] = True
    if env:
        payload["env"] = env
    return _sbx("exec", payload, timeout=timeout)


# --------------------------------------------------------------------------- #
# Provisioning — drive the sandbox to install + run the desktop, stream its log
# --------------------------------------------------------------------------- #

def _detect(space_id: str) -> Tuple[str, str, str]:
    """(installed, running, url) as reported from the sandbox."""
    res = _sbx_exec(space_id, _DETECT_SCRIPT, timeout=SANDBOX_BOOT_TIMEOUT_S)
    out = str(res.get("stdout") or "")
    inst = run = ""
    url = ""
    for line in out.splitlines():
        if line.startswith("INST="):
            inst = line[5:].strip()
        elif line.startswith("RUN="):
            run = line[4:].strip()
        elif line.startswith("URL="):
            url = line[4:].strip()
    return inst, run, url


def _stream_remote_log(desk: Desktop) -> str:
    """Fetch the tail of the sandbox's provision log we have not shown yet, append
    each new line to the desktop log, and return the whole slice (so the caller
    can scan it for markers)."""
    off = desk._remote_log_off
    cmd = ("tail -c +" + str(off + 1) + " \"$HOME/" + REMOTE_DIR + "/install.log\" 2>/dev/null | head -c 40000")
    try:
        res = _sbx_exec(desk.space_id, cmd, timeout=EXEC_TIMEOUT_S)
    except SandboxError:
        return ""
    chunk = str(res.get("stdout") or "")
    if not chunk:
        return ""
    desk._remote_log_off = off + len(chunk.encode("utf-8", "replace"))
    for line in chunk.splitlines():
        line = line.strip()
        if line:
            desk.log(_pretty_remote(line))
    return chunk


def _pretty_remote(line: str) -> str:
    """Turn the script's terse markers into friendlier front-end log lines."""
    for prefix, label in (("INSTALL:", "install"), ("START:", "start"), ("READY:", "ready"),
                          ("ERROR:", "error"), ("PROVISION_DONE", "done")):
        if line.startswith(prefix):
            return line
    return line


def _provision(desk: Desktop) -> None:
    space_id = desk.space_id
    try:
        desk.phase = PHASE_INSTALLING
        desk.error = ""
        desk._remote_log_off = 0
        desk.log("connecting to the space sandbox…")

        # 1) Make sure the sandbox is up (this cold-boots the microVM if needed).
        boot = _sbx_exec(space_id, "echo sandbox-ready", timeout=SANDBOX_BOOT_TIMEOUT_S)
        if not boot.get("ok") and "sandbox-ready" not in str(boot.get("stdout") or ""):
            raise RuntimeError("could not start the space sandbox: " + str(boot.get("error") or boot.get("stderr") or "")[:200])
        desk.log("the space sandbox is up")

        # 2) Already running there? Then skip the install entirely.
        inst, run, url = _detect(space_id)
        desk.installed = inst == "INSTALLED"
        if run == "UP" and url:
            desk.url = _compose_url(url)
            desk.phase = PHASE_READY
            desk.log("the desktop is already running on the sandbox — reusing it")
            return

        # 3) Write the provision/start script onto the sandbox and run it in the
        #    background, capturing its output to install.log so we can stream it.
        desk.log("preparing the desktop on the sandbox" + ("" if desk.installed else " (first time — installing)"))
        _sbx("write", {"space_id": space_id,
                       "path": REMOTE_DIR + "/provision.sh",
                       "content": _PROVISION_SCRIPT}, timeout=EXEC_TIMEOUT_S)
        _sbx_exec(space_id,
                  "mkdir -p \"$HOME/" + REMOTE_DIR + "\"; : > \"$HOME/" + REMOTE_DIR + "/install.log\"; "
                  "setsid sh \"$HOME/" + REMOTE_DIR + "/provision.sh\" "
                  ">\"$HOME/" + REMOTE_DIR + "/install.log\" 2>&1 </dev/null & echo launched",
                  timeout=EXEC_TIMEOUT_S)

        # 4) Stream the sandbox's install log until it publishes a URL (or fails).
        deadline = time.time() + PROVISION_TIMEOUT_S
        while time.time() < deadline:
            slice_ = _stream_remote_log(desk)
            if "PROVISION_DONE" in slice_ or "READY:" in slice_:
                break
            time.sleep(2.0)
        _stream_remote_log(desk)  # final drain

        # 5) Read the published URL from the sandbox.
        inst, run, url = _detect(space_id)
        desk.installed = inst == "INSTALLED" or desk.installed
        if url:
            desk.url = _compose_url(url)
            desk.phase = PHASE_READY
            desk.log("the computer is ready — opening the live browser")
        else:
            raise RuntimeError("the desktop did not publish a tunnel URL on the sandbox")
    except Exception as exc:  # noqa: BLE001 — report, don't crash the serving loop
        desk.error = str(exc)
        desk.phase = PHASE_ERROR
        desk.log("provisioning failed: " + str(exc))
    finally:
        desk._provisioning = False


def _compose_url(base: str) -> str:
    base = base.strip().rstrip("/")
    if not base:
        return ""
    query = "autoconnect=1&resize=remote&reconnect=1&show_dot=1"
    if VNC_PASSWORD:
        query += "&password=" + VNC_PASSWORD
    return base + "/vnc.html?" + query


def _begin_provision(desk: Desktop) -> None:
    with desk.lock:
        if desk._provisioning:
            return
        desk._provisioning = True
    threading.Thread(target=_provision, args=(desk,), daemon=True).start()


# --------------------------------------------------------------------------- #
# Agent control surface (xdotool / scrot on the sandbox, over exec/read)
# --------------------------------------------------------------------------- #

def _require_ready(space_id: str) -> Desktop:
    desk = _get_desktop(space_id, create=False)
    if desk is None or desk.phase != PHASE_READY or not desk.url:
        raise SandboxError("the computer is not running for this space — open it first")
    return desk


def _xdotool(space_id: str, args: str) -> Dict[str, Any]:
    return _sbx_exec(space_id, "DISPLAY=" + REMOTE_DISPLAY + " xdotool " + args, timeout=EXEC_TIMEOUT_S)


def _act_screenshot(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    fmt = str(payload.get("format") or "png").lower()
    remote = REMOTE_DIR + "/shot.png"
    cmd = ("DISPLAY=" + REMOTE_DISPLAY + " sh -c 'scrot -o \"$HOME/" + remote + "\" "
           "|| import -window root \"$HOME/" + remote + "\"'")
    res = _sbx_exec(space_id, cmd, timeout=EXEC_TIMEOUT_S)
    if not res.get("ok"):
        raise SandboxError("screenshot failed: " + str(res.get("stderr") or res.get("error") or "")[:160])
    read = _sbx("read", {"space_id": space_id, "path": REMOTE_DIR + "/shot.png"}, timeout=EXEC_TIMEOUT_S)
    content = str(read.get("content") or "")
    if read.get("encoding") != "base64":
        # A text body means it wasn't a PNG — surface the failure.
        raise SandboxError("could not read the screenshot from the sandbox")
    if len(content) > int(MAX_SHOT_BYTES * 1.4):
        # Re-encode smaller on the sandbox to fit the signal frame.
        _sbx_exec(space_id, "convert \"$HOME/" + remote + "\" -resize 70% -quality 65 \"$HOME/" + REMOTE_DIR + "/shot.jpg\" 2>/dev/null || true",
                  timeout=EXEC_TIMEOUT_S)
        read2 = _sbx("read", {"space_id": space_id, "path": REMOTE_DIR + "/shot.jpg"}, timeout=EXEC_TIMEOUT_S)
        if read2.get("encoding") == "base64" and read2.get("content"):
            content = str(read2["content"])
            fmt = "jpeg"
    return {"ok": True, "action": "screenshot", "space_id": space_id,
            "format": "png" if fmt == "png" else "jpeg",
            "bytes": len(content), "image": content}


def _act_click(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    button = str(payload.get("button") or "1")
    button = {"left": "1", "middle": "2", "right": "3"}.get(button, button)
    x = payload.get("x")
    y = payload.get("y")
    if x is not None and y is not None:
        _xdotool(space_id, "mousemove --sync " + str(int(x)) + " " + str(int(y)))
    clicks = int(payload.get("count") or (2 if payload.get("double") else 1))
    _xdotool(space_id, "click --repeat " + str(max(1, clicks)) + " " + button)
    return {"ok": True, "action": "click", "space_id": space_id, "x": x, "y": y,
            "button": button, "count": clicks}


def _act_move(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    x = int(payload.get("x") or 0)
    y = int(payload.get("y") or 0)
    _xdotool(space_id, "mousemove --sync " + str(x) + " " + str(y))
    return {"ok": True, "action": "move", "space_id": space_id, "x": x, "y": y}


def _act_type(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    text = str(payload.get("text") or payload.get("value") or "")
    if not text:
        raise SandboxError("text is required")
    # Base64 the text so arbitrary characters survive the shell unharmed.
    b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    cmd = ("DISPLAY=" + REMOTE_DISPLAY + " sh -c 'xdotool type --clearmodifiers --delay 20 -- "
           "\"$(printf %s " + b64 + " | base64 -d)\"'")
    _sbx_exec(space_id, cmd, timeout=EXEC_TIMEOUT_S)
    return {"ok": True, "action": "type", "space_id": space_id, "chars": len(text)}


def _act_key(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    key = str(payload.get("key") or payload.get("keys") or "")
    if not key:
        raise SandboxError("key is required (e.g. Return, ctrl+l, alt+Tab)")
    key = key.replace("Control", "ctrl").replace("Alt", "alt").replace("Shift", "shift")
    if not re.match(r"^[A-Za-z0-9_+]+$", key):
        raise SandboxError("invalid key spec")
    _xdotool(space_id, "key --clearmodifiers " + key)
    return {"ok": True, "action": "key", "space_id": space_id, "key": key}


def _act_scroll(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    direction = str(payload.get("to") or payload.get("direction") or "").lower()
    amount = int(payload.get("amount") or payload.get("clicks") or 3)
    dy = payload.get("dy")
    if dy is not None:
        amount = max(1, abs(int(dy)) // 120)
        button = "5" if int(dy) > 0 else "4"
    else:
        button = "4" if direction in ("up", "top") else "5"
    _xdotool(space_id, "click --repeat " + str(max(1, amount)) + " " + button)
    return {"ok": True, "action": "scroll", "space_id": space_id, "button": button, "amount": amount}


def _act_navigate(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_ready(space_id)
    url = str(payload.get("url") or payload.get("text") or "").strip()
    if not url:
        raise SandboxError("url is required")
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url
    if not re.match(r"^https?://[^\s'\"]+$", url):
        raise SandboxError("invalid url")
    # Open in the running browser via keyboard (focus address bar, type, Enter) —
    # provider- and browser-agnostic.
    b64 = base64.b64encode(url.encode("utf-8")).decode("ascii")
    cmd = ("DISPLAY=" + REMOTE_DISPLAY + " sh -c 'xdotool key --clearmodifiers ctrl+l; sleep 0.3; "
           "xdotool type --clearmodifiers -- \"$(printf %s " + b64 + " | base64 -d)\"; "
           "xdotool key Return'")
    _sbx_exec(space_id, cmd, timeout=EXEC_TIMEOUT_S)
    return {"ok": True, "action": "navigate", "space_id": space_id, "url": url}


# --------------------------------------------------------------------------- #
# Lifecycle actions
# --------------------------------------------------------------------------- #

def _act_open(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    desk = _get_desktop(space_id, create=True)
    assert desk is not None
    cursor = int(payload.get("cursor") or 0)
    if desk.phase == PHASE_READY and desk.url:
        snap = desk.snapshot(cursor)
        snap["action"] = "open"
        snap["reused"] = True
        return snap
    if not desk._provisioning and desk.phase in (PHASE_IDLE, PHASE_ERROR):
        _begin_provision(desk)
    snap = desk.snapshot(cursor)
    snap["action"] = "open"
    snap["reused"] = False
    return snap


def _act_status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    desk = _get_desktop(space_id, create=False)
    cursor = int(payload.get("cursor") or 0)
    if desk is None:
        return {"ok": True, "action": "status", "space_id": space_id, "phase": PHASE_IDLE,
                "url": None, "installed": False, "ready": False, "logs": [], "cursor": 0}
    # Long-poll: the Victor guest VM has no timer, so it paces its poll loop by
    # asking us to hold the call briefly while the desktop is still installing —
    # we return early the moment new log lines land or the phase changes.
    wait = 0.0
    try:
        wait = min(float(payload.get("wait") or 0.0), 8.0)
    except (TypeError, ValueError):
        wait = 0.0
    if wait > 0 and desk.phase == PHASE_INSTALLING:
        deadline = time.time() + wait
        while time.time() < deadline:
            _, total = desk.logs_from(cursor)
            if total > cursor or desk.phase != PHASE_INSTALLING:
                break
            time.sleep(0.25)
    snap = desk.snapshot(cursor)
    snap["action"] = "status"
    return snap


def _act_url(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    desk = _get_desktop(space_id, create=False)
    if desk is None or desk.phase != PHASE_READY or not desk.url:
        phase = desk.phase if desk else PHASE_IDLE
        return {"ok": False, "action": "url", "space_id": space_id, "phase": phase,
                "url": None, "message": "the computer is not ready yet"}
    return {"ok": True, "action": "url", "space_id": space_id, "phase": PHASE_READY, "url": desk.url}


def _act_stop(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    desk = _get_desktop(space_id, create=False)
    # Kill the desktop's processes on the sandbox (best-effort), keeping the
    # installed packages so the next open is fast.
    try:
        _sbx_exec(space_id,
                  "for p in tunnel novnc vnc browser wm xvfb; do "
                  "[ -f \"$HOME/" + REMOTE_DIR + "/$p.pid\" ] && kill \"$(cat \"$HOME/" + REMOTE_DIR + "/$p.pid\")\" 2>/dev/null; done; "
                  "rm -f \"$HOME/" + REMOTE_DIR + "/url\"; echo stopped",
                  timeout=EXEC_TIMEOUT_S)
    except SandboxError:
        pass
    if desk is not None:
        desk.phase = PHASE_IDLE
        desk.url = ""
        desk.log("stopped the computer on the sandbox")
    return {"ok": True, "action": "stop", "space_id": space_id, "stopped": True}


def _act_restart(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _act_stop(space_id, payload)
    desk = _get_desktop(space_id, create=True)
    assert desk is not None
    with desk.lock:
        desk._log = []
    desk.phase = PHASE_IDLE
    desk.url = ""
    _begin_provision(desk)
    snap = desk.snapshot(0)
    snap["action"] = "restart"
    return snap


def _act_delete(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _act_stop(space_id, payload)
    with _REGISTRY_LOCK:
        _DESKTOPS.pop(space_id, None)
    return {"ok": True, "action": "delete", "space_id": space_id, "deleted": True}


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

_ACTIONS: Dict[str, Callable[[str, Dict[str, Any]], Dict[str, Any]]] = {
    "open": _act_open, "start": _act_open, "launch": _act_open, "desktop": _act_open,
    "status": _act_status, "logs": _act_status, "poll": _act_status,
    "url": _act_url, "get_url": _act_url,
    "stop": _act_stop, "suspend": _act_stop,
    "restart": _act_restart, "reset": _act_restart,
    "delete": _act_delete, "destroy": _act_delete,
    "screenshot": _act_screenshot, "capture": _act_screenshot,
    "click": _act_click, "double_click": _act_click,
    "move": _act_move, "mouse_move": _act_move,
    "type": _act_type, "text": _act_type,
    "key": _act_key, "press": _act_key,
    "scroll": _act_scroll,
    "navigate": _act_navigate, "goto": _act_navigate, "open_url": _act_navigate,
}

_ALL_ACTIONS = sorted(set(_ACTIONS))


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip().lower() != "invoke":
            return candidate.strip().lower()
    return "open"


def _space_id(payload: Dict[str, Any]) -> str:
    for key in ("space_id", "spaceId", "store_id", "storeId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise SandboxError("space_id is required — the computer is bound to a Decillion space")


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": "unknown action '" + action + "'", "actions": _ALL_ACTIONS}
    if action == "double_click":
        payload.setdefault("double", True)
    try:
        space_id = _space_id(payload)
    except SandboxError as exc:
        return {"ok": False, "action": action, "error": str(exc)}
    try:
        return handler(space_id, payload)
    except SandboxError as exc:
        return {"ok": False, "action": action, "space_id": space_id, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — never crash the serving loop
        return {"ok": False, "action": action, "space_id": space_id, "error": str(exc)}
