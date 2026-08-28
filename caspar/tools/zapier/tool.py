"""zapier tool creature — every app a person connected to Zapier, in a Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API. Two kinds of caller reach it
over the same contract:

* the space's **agents**, through the agent backbone's bridge executor, so an
  agent can send the Gmail, post the Slack message, add the CRM row, create the
  calendar event — anything the person authorized in Zapier;
* the tool's **front-end** (the Victor "Zapier" mini-app), relayed by the client
  and signed as the human user — where a person connects their Zapier account,
  authorizes app accounts, browses the actions and runs one by hand.

## What it talks to

Zapier's **MCP server**, over Streamable HTTP:

    https://mcp.zapier.com/api/v1/connect?token=<connection token>

The token is the credential for one Zapier MCP server, and that server's tool
list *is* the set of actions its owner authorized — one MCP tool per app action
(``google_calendar_find_event``, ``slack_send_channel_message``, …). Zapier holds
the third-party OAuth credentials; this creature never sees a Gmail or Slack
token, only Zapier's.

## Whose Zapier?

Three tiers, resolved per caller, most specific first:

1. **the caller's own connection** — a member connected their personal Zapier
   MCP server from the front-end (embed handshake or connection token);
2. **the space's connection** — the same, connected for the whole project. Shared
   with the space by default, because the point of connecting it inside a project
   is that the project's *agents* can act; the owner can make it private;
3. **the platform server** — ``ZAPIER_MCP_TOKEN``, baked into the image at deploy
   from the repository's GitHub secret. The always-available fallback, so the tool
   is useful the moment it is attached.

Every credential comes from the container environment or the node's key/value
store — **never** from a signal payload a prompt could influence, so a
prompt-injected agent can neither swap the server nor read a token back out.

## Efficiency

A Zapier account can expose hundreds of actions, and their full JSON schemas are
far too large to hand an agent. So the agent never receives the raw list:

* ``apps`` returns the connected apps (a couple of dozen rows at most);
* ``actions`` searches/filters the action list and returns compact rows;
* ``describe`` returns the full input schema for **one** action;
* ``run`` executes one, resolving a near-miss name rather than failing on it.

The list is fetched once per server and cached (in memory + the node's key/value
store) so repeated agent turns cost one HTTP round trip, not a re-enumeration.

## Functions

    status      which Zapier server this caller uses, and who owns it
    apps        the apps reachable through it, with how many actions each has
    actions     search/list the actions (``query``, ``app``, ``limit``)
    describe    one action's parameters (its full input schema)
    run         execute one action (``tool`` + ``params`` and/or ``instructions``)
    connect     start (or complete) connecting a Zapier account
    connect_wait  server-paced wait for the embed handshake to land
    disconnect  drop a stored connection (owner only)
    set_shared  owner-only: may the space (and its agents) use this connection
    refresh     drop the cached action list and re-read it from Zapier
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import re
import secrets
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import requests

# --------------------------------------------------------------------------- #
# Configuration (container environment only — never a signal payload)
# --------------------------------------------------------------------------- #

# The Zapier MCP endpoint. The connection token rides either the Authorization
# header (preferred) or the `token` query parameter; Zapier accepts both, and the
# `?token=` spelling is the one the platform is configured with.
MCP_URL = os.environ.get("ZAPIER_MCP_URL", "").strip() or "https://mcp.zapier.com/api/v1/connect"

# The platform's own Zapier MCP connection token, baked into the image at deploy
# time from the repository's GitHub secret (see scripts/deploy_zapier_tool.py).
PLATFORM_TOKEN = (
    os.environ.get("ZAPIER_MCP_TOKEN", "").strip()
    or os.environ.get("ZAPIER_API_KEY", "").strip()
    or os.environ.get("ZAPIER_MCP_API_KEY", "").strip()
)
# A fully-formed platform server URL wins over the token when both are set.
PLATFORM_SERVER_URL = os.environ.get("ZAPIER_MCP_SERVER_URL", "").strip()
PLATFORM_LABEL = os.environ.get("ZAPIER_PLATFORM_LABEL", "").strip() or "Decillion platform workspace"

# Where a person manages their Zapier MCP servers, app connections and tools.
ZAPIER_MCP_HOME = os.environ.get("ZAPIER_MCP_HOME_URL", "").strip() or "https://mcp.zapier.com/"
ZAPIER_CONNECTIONS_URL = (
    os.environ.get("ZAPIER_CONNECTIONS_URL", "").strip() or "https://zapier.com/app/connections"
)

# Zapier MCP Embed — the in-app "connect your accounts" surface. When an embed id
# is configured the front-end can open a webview served by THIS creature that
# hosts Zapier's <zapier-mcp> web component, and the user authorizes app accounts
# without ever copying a token. Optional: with no embed id the connect flow falls
# back to pasting a connection token.
EMBED_ID = os.environ.get("ZAPIER_MCP_EMBED_ID", "").strip()
EMBED_SECRET = os.environ.get("ZAPIER_MCP_EMBED_SECRET", "").strip()
EMBED_SCRIPT = (
    os.environ.get("ZAPIER_MCP_EMBED_SCRIPT", "").strip() or "https://mcp.zapier.com/embed/v1/mcp.js"
)
# Only a URL under this origin is accepted as an embed-issued server URL, so a
# forged claim cannot point a space's connection at someone else's endpoint.
EMBED_URL_PREFIX = (
    os.environ.get("ZAPIER_MCP_SERVER_PREFIX", "").strip() or "https://mcp.zapier.com/"
)
# The public origin + path this creature's HTTP handler is reachable on, so the
# front-end can open the embed page in Victor's webview. Bound at deploy time.
INGRESS_BASE = os.environ.get("ZAPIER_VM_HTTP_INGRESS_BASE", "").strip().rstrip("/")
INGRESS_PATH = "/" + (os.environ.get("ZAPIER_INGRESS_PATH", "").strip().strip("/") or "m-tool-zapier/zapier")

HTTP_TIMEOUT = float(os.environ.get("ZAPIER_HTTP_TIMEOUT", "60"))
CALL_TIMEOUT = float(os.environ.get("ZAPIER_CALL_TIMEOUT", "120"))
TOOLS_TTL_S = float(os.environ.get("ZAPIER_TOOLS_TTL_S", "600"))
LIST_LIMIT = int(os.environ.get("ZAPIER_LIST_LIMIT", "40"))
LIST_CAP = int(os.environ.get("ZAPIER_LIST_CAP", "200"))
MAX_OUTPUT = int(os.environ.get("ZAPIER_MAX_OUTPUT", "40000"))
HANDSHAKE_TTL_S = float(os.environ.get("ZAPIER_HANDSHAKE_TTL_S", "1800"))
PROTOCOL_VERSION = os.environ.get("ZAPIER_MCP_PROTOCOL_VERSION", "").strip() or "2025-06-18"

STATE_DIR = os.environ.get("ZAPIER_STATE_DIR", "/app/state")
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class ZapierError(RuntimeError):
    """A tool operation failed; carries an HTTP-ish status for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Persistence — node key/value store (durable) with a local-file mirror
# --------------------------------------------------------------------------- #
#
# Identical to the github tool's: the runtime hands us the gateway bridge through
# ``set_bridge``, so a connection survives a container restart; the local file is
# a warm mirror so a bridge hiccup still reads.

_BRIDGE = None  # set by set_bridge()


def set_bridge(bridge) -> None:
    global _BRIDGE
    _BRIDGE = bridge


def _file_path(key: str) -> str:
    return os.path.join(STATE_DIR, _UNSAFE.sub("_", key) + ".json")


def _file_get(key: str) -> Optional[str]:
    try:
        with open(_file_path(key), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _file_put(key: str, val: str) -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = _file_path(key) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(val)
        os.replace(tmp, _file_path(key))
    except OSError:
        pass


def _file_del(key: str) -> None:
    try:
        os.remove(_file_path(key))
    except OSError:
        pass


def _bridge_get(key: str) -> Optional[str]:
    if _BRIDGE is None:
        return None
    try:
        res = _BRIDGE.db_get(key)
    except Exception:  # noqa: BLE001 — a flaky bridge falls back to the file
        return None
    if not isinstance(res, dict):
        return None
    if res.get("found") is False:
        return None
    val = res.get("val")
    if val is None:
        val = res.get("value")
    if val is None:
        return None
    if res.get("encoding") == "base64" or res.get("b64"):
        try:
            return base64.b64decode(val).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return None
    return str(val)


def _store_get(key: str) -> Optional[str]:
    val = _bridge_get(key)
    if val is not None:
        _file_put(key, val)
        return val
    return _file_get(key)


def _store_put(key: str, val: str) -> None:
    if _BRIDGE is not None:
        try:
            _BRIDGE.db_put(key, val)
        except Exception:  # noqa: BLE001
            pass
    _file_put(key, val)


def _store_del(key: str) -> None:
    if _BRIDGE is not None:
        try:
            _BRIDGE.db_del(key)
        except Exception:  # noqa: BLE001
            pass
    _file_del(key)


def _json_get(key: str) -> Optional[Dict[str, Any]]:
    raw = _store_get(key)
    if not raw:
        return None
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except (TypeError, ValueError):
        return None


def _json_put(key: str, obj: Dict[str, Any]) -> None:
    _store_put(key, json.dumps(obj))


# --------------------------------------------------------------------------- #
# Caller + space identity
# --------------------------------------------------------------------------- #

def _space_id(payload: Dict[str, Any]) -> str:
    for key in ("space_id", "spaceId", "store_id", "storeId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise ZapierError("space_id is required — this tool is bound to a Decillion space")


def _caller(payload: Dict[str, Any]) -> str:
    """The user id this call is made on behalf of, as far as the tool can tell.

    The runtime stamps the TRUSTED caller from the signal envelope as
    ``__caller_id`` (the client sets ``reply_to`` from the authenticated user and
    a guest cannot forge it). The remaining keys are only a fallback for offline
    or unit runs that call :func:`invoke` directly."""
    for key in ("__caller_id", "reply_to", "replyTo", "caller_id", "callerId", "user_id", "userId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _conn_key(space_id: str, user_id: str = "") -> str:
    return f"zapier/conn/{space_id}/u/{user_id}" if user_id else f"zapier/conn/{space_id}"


def _secret_key(space_id: str, user_id: str = "") -> str:
    return f"zapier/secret/{space_id}/u/{user_id}" if user_id else f"zapier/secret/{space_id}"


# --------------------------------------------------------------------------- #
# Server resolution: whose Zapier does this caller drive?
# --------------------------------------------------------------------------- #

class Server:
    """A resolved Zapier MCP server: where to reach it and who it belongs to."""

    def __init__(self, *, url: str, token: str = "", bearer: str = "", scope: str = "platform",
                 owner: str = "", label: str = "", shared: bool = True) -> None:
        self.url = url
        self.token = token          # a Zapier connection token (?token= / Bearer)
        self.bearer = bearer        # an explicit bearer (the embed secret) when set
        self.scope = scope          # "user" | "space" | "platform"
        self.owner = owner
        self.label = label
        self.shared = shared

    @property
    def fingerprint(self) -> str:
        raw = self.url + "\n" + (self.bearer or self.token)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]

    def describe(self) -> Dict[str, Any]:
        return {"scope": self.scope, "label": self.label, "owner_user_id": self.owner or None,
                "shared": self.shared, "endpoint": _redact_url(self.url)}


def _redact_url(url: str) -> str:
    """The server URL with any token query parameter masked — safe to return."""
    try:
        parts = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        masked = [(k, ("…" if k.lower() in ("token", "key", "secret", "api_key") else v)) for k, v in query]
        return urllib.parse.urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(masked), "")
        )
    except Exception:  # noqa: BLE001
        return url.split("?")[0]


def _server_from_record(conn: Dict[str, Any], secret: str, *, scope: str) -> Server:
    """Build a Server from a stored connection record + its secret."""
    kind = str(conn.get("kind") or "token")
    if kind == "server_url":
        # A per-user embed server URL: the bearer is the embed secret, not a
        # connection token, and the URL is already complete.
        return Server(url=secret, bearer=conn.get("bearer") or EMBED_SECRET, scope=scope,
                      owner=str(conn.get("owner_user_id") or ""),
                      label=str(conn.get("label") or "Your Zapier workspace"),
                      shared=bool(conn.get("shared", True)))
    return Server(url=_token_url(secret), token=secret, scope=scope,
                  owner=str(conn.get("owner_user_id") or ""),
                  label=str(conn.get("label") or "Your Zapier workspace"),
                  shared=bool(conn.get("shared", True)))


def _token_url(token: str) -> str:
    """The platform's configured MCP endpoint carrying a connection token.

    Zapier documents both spellings; the query form is the one the platform is
    configured with, and the Authorization header is sent as well (see
    :func:`_headers`) so either side of Zapier's auth is satisfied."""
    base = MCP_URL
    if "token=" in base:
        return base
    joiner = "&" if "?" in base else "?"
    return base + joiner + "token=" + urllib.parse.quote(token, safe="")


def _platform_server() -> Optional[Server]:
    if PLATFORM_SERVER_URL:
        return Server(url=PLATFORM_SERVER_URL, bearer=EMBED_SECRET or PLATFORM_TOKEN,
                      scope="platform", label=PLATFORM_LABEL)
    if PLATFORM_TOKEN:
        return Server(url=_token_url(PLATFORM_TOKEN), token=PLATFORM_TOKEN,
                      scope="platform", label=PLATFORM_LABEL)
    return None


def _stored_server(space_id: str, user_id: str, *, scope: str) -> Optional[Server]:
    conn = _json_get(_conn_key(space_id, user_id))
    if not conn:
        return None
    secret = _store_get(_secret_key(space_id, user_id))
    if not secret:
        return None
    return _server_from_record(conn, secret, scope=scope)


def _resolve_server(space_id: str, payload: Dict[str, Any]) -> Server:
    """The Zapier server this caller drives, most specific tier first.

    A private space connection is usable only by the member who connected it —
    every other caller (human or agent) falls through to the platform server
    rather than being refused, so the tool keeps working either way."""
    caller = _caller(payload)
    if caller:
        own = _stored_server(space_id, caller, scope="user")
        if own is not None:
            return own
    space = _stored_server(space_id, "", scope="space")
    if space is not None and (space.shared or (caller and caller == space.owner)):
        return space
    platform = _platform_server()
    if platform is not None:
        return platform
    if space is not None:
        raise ZapierError(
            "this space's Zapier connection is private to the member who connected it, and no "
            "platform Zapier workspace is configured — ask them to share it, or connect your own "
            "Zapier account from the tool's Connect screen", status=403)
    raise ZapierError(
        "no Zapier account is connected yet — open the Zapier tool and connect one (the platform "
        "workspace is unconfigured, so every space brings its own)", status=409)


# --------------------------------------------------------------------------- #
# MCP over Streamable HTTP
# --------------------------------------------------------------------------- #
#
# Zapier's MCP server speaks Streamable HTTP only (never SSE-transport): every
# JSON-RPC request is a POST, and the response comes back either as plain JSON or
# as a one-message text/event-stream. A session id may be issued on `initialize`
# and must be echoed on every later request; when it expires Zapier answers 404,
# which is the documented signal to re-initialize and retry once.

_SESSIONS: Dict[str, str] = {}     # fingerprint → Mcp-Session-Id
_TOOLS_CACHE: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}   # fingerprint → (fetched_at, tools)
_RPC_ID = 0


def _next_id() -> int:
    global _RPC_ID
    _RPC_ID += 1
    return _RPC_ID


def _headers(server: Server, *, session: str = "") -> Dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        # Streamable HTTP: the server may answer with either shape.
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "User-Agent": "decillion-zapier-tool/1.0",
    }
    bearer = server.bearer or server.token
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    if session:
        headers["Mcp-Session-Id"] = session
    return headers


def _parse_sse(text: str, want_id: Optional[int]) -> Optional[Dict[str, Any]]:
    """Pull the JSON-RPC message out of a text/event-stream response body."""
    chosen = None
    for block in re.split(r"\r?\n\r?\n", text):
        data = "\n".join(
            line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
        ).strip()
        if not data:
            continue
        try:
            msg = json.loads(data)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        if want_id is not None and msg.get("id") == want_id:
            return msg
        if chosen is None and ("result" in msg or "error" in msg):
            chosen = msg
    return chosen


def _post(server: Server, body: Dict[str, Any], *, session: str, timeout: float) -> requests.Response:
    try:
        return requests.post(server.url, headers=_headers(server, session=session),
                             data=json.dumps(body), timeout=timeout)
    except requests.Timeout as exc:
        raise ZapierError(f"Zapier did not answer in {int(timeout)}s — try again", status=504) from exc
    except requests.RequestException as exc:
        raise ZapierError(f"could not reach the Zapier MCP server: {exc}", status=502) from exc


def _rpc(server: Server, method: str, params: Optional[Dict[str, Any]] = None, *,
         timeout: Optional[float] = None, _retried: bool = False) -> Dict[str, Any]:
    """One JSON-RPC round trip against the server, initializing the session first."""
    fingerprint = server.fingerprint
    session = _SESSIONS.get(fingerprint, "")
    if not session and method != "initialize":
        session = _initialize(server)
    rid = _next_id()
    body: Dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        body["params"] = params
    resp = _post(server, body, session=session, timeout=timeout or HTTP_TIMEOUT)

    if resp.status_code in (401, 403):
        _SESSIONS.pop(fingerprint, None)
        raise ZapierError(
            "Zapier rejected this connection token (401/403). Reconnect the Zapier account from the "
            "tool's Connect screen, or have an operator refresh the platform token.",
            status=resp.status_code)
    if resp.status_code == 404 and not _retried:
        # A documented Zapier failure mode: the MCP session expired, so the next
        # call 404s. Re-initialize once and retry rather than surfacing it.
        _SESSIONS.pop(fingerprint, None)
        _initialize(server)
        return _rpc(server, method, params, timeout=timeout, _retried=True)
    if resp.status_code >= 400:
        raise ZapierError(f"Zapier MCP {method} failed ({resp.status_code}): "
                          f"{_clip(resp.text or '', 400)}", status=resp.status_code)

    new_session = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
    if new_session:
        _SESSIONS[fingerprint] = new_session

    ctype = (resp.headers.get("Content-Type") or "").lower()
    text = resp.text or ""
    msg: Optional[Dict[str, Any]]
    if "text/event-stream" in ctype:
        msg = _parse_sse(text, rid)
    else:
        try:
            parsed = json.loads(text) if text.strip() else None
            msg = parsed if isinstance(parsed, dict) else None
        except ValueError:
            msg = _parse_sse(text, rid)
    if msg is None:
        raise ZapierError(f"Zapier returned an unreadable {method} response: {_clip(text, 300)}",
                          status=502)
    if "error" in msg and msg["error"]:
        err = msg["error"] if isinstance(msg["error"], dict) else {"message": str(msg["error"])}
        raise ZapierError(str(err.get("message") or err), status=int(err.get("code") or 0) or 502,
                          body=err.get("data"))
    result = msg.get("result")
    return result if isinstance(result, dict) else {"result": result}


def _notify(server: Server, method: str, params: Optional[Dict[str, Any]] = None) -> None:
    """Fire-and-forget notification (no id, no response body to read)."""
    body: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    try:
        _post(server, body, session=_SESSIONS.get(server.fingerprint, ""), timeout=HTTP_TIMEOUT)
    except ZapierError:
        pass


def _initialize(server: Server) -> str:
    """Open an MCP session and return its id (empty when the server is stateless)."""
    result = _rpc(server, "initialize", {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "decillion-zapier-tool", "version": "1.0.0"},
    })
    session = _SESSIONS.get(server.fingerprint, "")
    _notify(server, "notifications/initialized")
    server_info = result.get("serverInfo") if isinstance(result, dict) else None
    if isinstance(server_info, dict):
        name = str(server_info.get("name") or "").strip()
        if name and server.label in ("", "Your Zapier workspace"):
            server.label = name
    return session


# --------------------------------------------------------------------------- #
# The action list (Zapier's MCP tools), fetched once and cached
# --------------------------------------------------------------------------- #

def _cache_key(server: Server) -> str:
    return f"zapier/tools/{server.fingerprint}"


def _fetch_tools(server: Server) -> List[Dict[str, Any]]:
    """Page through ``tools/list`` and return every action the server exposes."""
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    for _page in range(25):  # a hard stop; 25 pages is far more than Zapier returns
        params = {"cursor": cursor} if cursor else {}
        result = _rpc(server, "tools/list", params)
        for entry in result.get("tools") or []:
            if isinstance(entry, dict) and entry.get("name"):
                out.append(entry)
        cursor = result.get("nextCursor") or None
        if not cursor:
            break
    return out


def _tools(server: Server, *, refresh: bool = False) -> List[Dict[str, Any]]:
    key = server.fingerprint
    now = time.time()
    if not refresh:
        hit = _TOOLS_CACHE.get(key)
        if hit and now - hit[0] < TOOLS_TTL_S:
            return hit[1]
        stored = _json_get(_cache_key(server))
        if stored and now - float(stored.get("fetched_at") or 0) < TOOLS_TTL_S:
            tools = stored.get("tools")
            if isinstance(tools, list):
                _TOOLS_CACHE[key] = (float(stored["fetched_at"]), tools)
                return tools
    tools = _fetch_tools(server)
    _TOOLS_CACHE[key] = (now, tools)
    _json_put(_cache_key(server), {"fetched_at": now, "tools": tools})
    return tools


# --------------------------------------------------------------------------- #
# App inference
# --------------------------------------------------------------------------- #
#
# Zapier names an MCP tool `<app>_<verb>_<object>` (`google_calendar_find_event`,
# `slack_send_channel_message`). There is no app field on the wire, so the app is
# read off the name: take the first segment, and extend to the second when that
# second segment is not an action verb — which is exactly what separates
# `google_calendar` (an app) from `gmail_send` (an app plus a verb).

_VERBS = {
    "add", "append", "archive", "assign", "attach", "cancel", "clear", "close", "convert", "copy",
    "create", "delete", "download", "duplicate", "edit", "export", "find", "generate", "get",
    "import", "invite", "list", "lookup", "mark", "merge", "move", "new", "open", "post", "publish",
    "pull", "push", "put", "read", "remove", "rename", "reply", "retrieve", "run", "schedule",
    "search", "send", "set", "share", "start", "stop", "submit", "sync", "tag", "toggle",
    "unarchive", "update", "upload", "upsert", "watch", "write",
}

_ACRONYMS = {"api": "API", "crm": "CRM", "sms": "SMS", "url": "URL", "pdf": "PDF", "ai": "AI",
             "io": "IO", "hr": "HR", "id": "ID", "sql": "SQL", "ftp": "FTP", "rss": "RSS"}


def _app_of(name: str) -> str:
    parts = [p for p in str(name or "").split("_") if p]
    if not parts:
        return "zapier"
    if len(parts) >= 3 and parts[1].lower() not in _VERBS:
        return parts[0] + "_" + parts[1]
    return parts[0]


def _label_of(key: str) -> str:
    words = []
    for part in str(key or "").split("_"):
        if not part:
            continue
        words.append(_ACRONYMS.get(part.lower(), part[:1].upper() + part[1:]))
    return " ".join(words) or key


def _summary_of(entry: Dict[str, Any]) -> str:
    desc = str(entry.get("description") or "").strip()
    if desc:
        return _clip(desc.split("\n")[0].strip(), 200)
    return _label_of(str(entry.get("name") or "").replace(_app_of(entry.get("name") or ""), "", 1))


def _row(entry: Dict[str, Any]) -> Dict[str, Any]:
    """The compact shape an agent or the UI gets — never the full JSON schema."""
    name = str(entry.get("name") or "")
    app = _app_of(name)
    return {
        "name": name,
        "app": app,
        "app_label": _label_of(app),
        "title": _label_of(name[len(app):].strip("_")) or _label_of(name),
        "summary": _summary_of(entry),
    }


# --------------------------------------------------------------------------- #
# Matching: turn what a caller typed into an exact Zapier tool name
# --------------------------------------------------------------------------- #

def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def _tokens(text: str) -> List[str]:
    return [t for t in re.split(r"[^a-z0-9]+", str(text or "").lower()) if t]


def _score(entry: Dict[str, Any], terms: List[str]) -> float:
    """How well one action matches the caller's words. Name hits weigh most."""
    if not terms:
        return 0.0
    name = str(entry.get("name") or "").lower()
    desc = str(entry.get("description") or "").lower()
    name_tokens = set(_tokens(name))
    desc_tokens = set(_tokens(desc))
    hit = 0.0
    for term in terms:
        if term in name_tokens:
            hit += 1.0
        elif term in name:
            hit += 0.6
        elif term in desc_tokens:
            hit += 0.35
        elif term in desc:
            hit += 0.2
    return hit / len(terms)


def _resolve_tool(server: Server, wanted: str, *, refresh: bool = False) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Find the action a caller named. Returns (entry, alternatives).

    Agents habitually guess a plausible-but-wrong name (``slack_send_message``
    for ``slack_send_channel_message``). Failing on that wastes a whole turn, so
    an unambiguous near-miss is resolved and reported; a genuinely ambiguous one
    comes back as candidates the caller can pick from."""
    tools = _tools(server, refresh=refresh)
    if not wanted:
        raise ZapierError("name the action to run in `tool` — list them with `actions` first",
                          status=400)
    by_name = {str(t.get("name") or ""): t for t in tools}
    if wanted in by_name:
        return by_name[wanted], []
    normalized = {_norm(k): v for k, v in by_name.items()}
    if _norm(wanted) in normalized:
        return normalized[_norm(wanted)], []
    terms = _tokens(wanted)
    ranked = sorted(((_score(t, terms), t) for t in tools), key=lambda p: -p[0])
    ranked = [(s, t) for s, t in ranked if s > 0]
    if not ranked:
        raise ZapierError(
            f"no action called '{wanted}' is available on this Zapier server — run `actions` to see "
            f"what is (and `apps` for which apps are connected)", status=404)
    best, runner_up = ranked[0], (ranked[1] if len(ranked) > 1 else None)
    if best[0] >= 0.8 and (runner_up is None or best[0] - runner_up[0] >= 0.2):
        return best[1], []
    return {}, [_row(t) for _s, t in ranked[:8]]


# --------------------------------------------------------------------------- #
# Output shaping
# --------------------------------------------------------------------------- #

def _clip(text: str, limit: int) -> str:
    text = str(text or "")
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated, {len(text) - limit} more chars]"


_AUTH_HINTS = re.compile(
    r"("
    r"(?:must|need|needs|should|please|have to|failed to)\s+(?:to\s+|be\s+)?(?:re-?)?"
    r"(?:authenticat|authoriz|connect)"
    r"|(?:re-?)?authenticat\w*\s+(?:is\s+)?(?:required|needed|first)"
    r"|authoriz\w*\s+(?:is\s+)?(?:required|needed|failed)"
    r"|not\s+(?:authenticated|authorized|connected)"
    r"|no\s+(?:account|connection|auth)\b"
    r"|reconnect|re-connect|unauthorized|invalid credential|invalid.{0,12}token"
    r"|connect(?:ion)?\s+(?:is\s+)?(?:expired|broken|missing|invalid)"
    r"|\b401\b"
    r")",
    re.I,
)


def _content_text(content: Any) -> str:
    """Flatten an MCP content array into text."""
    if isinstance(content, str):
        return content
    parts: List[str] = []
    for block in content or []:
        if isinstance(block, dict):
            if isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif block.get("type") == "resource" and isinstance(block.get("resource"), dict):
                res = block["resource"]
                parts.append(str(res.get("text") or res.get("uri") or ""))
            else:
                parts.append(json.dumps(block, default=str))
        elif block is not None:
            parts.append(str(block))
    return "\n".join(p for p in parts if p)


def _maybe_json(text: str) -> Any:
    stripped = (text or "").strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #

def _connect_urls(server: Optional[Server]) -> Dict[str, str]:
    return {"manage_url": ZAPIER_MCP_HOME, "connections_url": ZAPIER_CONNECTIONS_URL}


def _a_status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Which Zapier server this caller drives, and what they may change.

    Read-only and never gated: everyone may *see* the connection state; only
    *using* someone else's private connection is refused."""
    caller = _caller(payload)
    own = _json_get(_conn_key(space_id, caller)) if caller else None
    space = _json_get(_conn_key(space_id))
    platform = _platform_server()
    try:
        server = _resolve_server(space_id, payload)
        active = server.describe()
        error = None
    except ZapierError as exc:
        server, active, error = None, None, str(exc)

    out: Dict[str, Any] = {
        "ok": True, "action": "status", "space_id": space_id,
        "connected": server is not None,
        "active": active,
        "personal": {"connected": bool(own), "label": (own or {}).get("label"),
                     "kind": (own or {}).get("kind")},
        "space": {"connected": bool(space), "label": (space or {}).get("label"),
                  "owner_user_id": (space or {}).get("owner_user_id"),
                  "shared": bool((space or {}).get("shared", True)),
                  "is_owner": bool(caller and space and caller == space.get("owner_user_id"))},
        "platform": {"configured": platform is not None, "label": PLATFORM_LABEL},
        "embed_available": bool(EMBED_ID),
        "can_manage_space_connection": bool(not space or (caller and caller == space.get("owner_user_id"))),
    }
    out.update(_connect_urls(server))
    if error:
        out["error"] = error
    if server is not None:
        try:
            tools = _tools(server)
            out["action_count"] = len(tools)
            out["app_count"] = len({_app_of(t.get("name") or "") for t in tools})
        except ZapierError as exc:
            out["error"] = str(exc)
            out["needs_auth"] = exc.status in (401, 403)
    return out


def _a_apps(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The apps this Zapier server can act on — the connected accounts, in effect."""
    server = _resolve_server(space_id, payload)
    tools = _tools(server, refresh=_truthy(payload.get("refresh")))
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for entry in tools:
        buckets.setdefault(_app_of(str(entry.get("name") or "")), []).append(entry)
    apps = []
    for key, entries in sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        apps.append({
            "app": key,
            "label": _label_of(key),
            "actions": len(entries),
            "summary": f"{len(entries)} action" + ("s" if len(entries) != 1 else "") + " available",
            "examples": [str(e.get("name") or "") for e in entries[:3]],
        })
    out = {"ok": True, "action": "apps", "space_id": space_id, "apps": apps,
           "app_count": len(apps), "action_count": len(tools), "server": server.describe()}
    out.update(_connect_urls(server))
    if not apps:
        out["note"] = ("this Zapier server exposes no actions yet — open Zapier from the Connect "
                       "screen and add the apps and actions you want, then refresh")
    return out


def _a_actions(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Search or list the actions available, compactly.

    Never returns input schemas: a Zapier account can expose hundreds of actions
    whose schemas run to tens of thousands of tokens. Narrow with ``query`` and/or
    ``app``, then ``describe`` the one you want."""
    server = _resolve_server(space_id, payload)
    tools = _tools(server, refresh=_truthy(payload.get("refresh")))
    app = str(payload.get("app") or "").strip().lower().replace(" ", "_")
    query = str(payload.get("query") or payload.get("search") or "").strip()
    limit = _int(payload.get("limit"), LIST_LIMIT, 1, LIST_CAP)

    pool = tools
    if app:
        pool = [t for t in pool if _norm(_app_of(str(t.get("name") or ""))).startswith(_norm(app))]
        if not pool:
            pool = [t for t in tools if _norm(app) in _norm(str(t.get("name") or ""))]
    matched = pool
    if query:
        terms = _tokens(query)
        ranked = sorted(((_score(t, terms), t) for t in pool), key=lambda p: -p[0])
        matched = [t for s, t in ranked if s > 0] or pool
    rows = [_row(t) for t in matched[:limit]]
    return {
        "ok": True, "action": "actions", "space_id": space_id,
        "query": query or None, "app": app or None,
        "actions": rows, "returned": len(rows), "total": len(matched),
        "truncated": len(matched) > len(rows),
        "note": ("call `describe` with an action name for its parameters, then `run` it"
                 if rows else "nothing matched — try `apps` to see what is connected"),
        "server": server.describe(),
    }


def _a_describe(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """One action's full input schema — what ``run`` accepts in ``params``."""
    server = _resolve_server(space_id, payload)
    wanted = _wanted_tool(payload)
    entry, alternatives = _resolve_tool(server, wanted)
    if not entry:
        return {"ok": False, "action": "describe", "error": f"'{wanted}' matched several actions",
                "candidates": alternatives}
    schema = entry.get("inputSchema") or entry.get("input_schema") or {}
    props = schema.get("properties") if isinstance(schema, dict) else {}
    required = schema.get("required") if isinstance(schema, dict) else []
    params = []
    for name, spec in (props or {}).items():
        spec = spec if isinstance(spec, dict) else {}
        params.append({
            "name": name,
            "type": str(spec.get("type") or "string"),
            "required": name in (required or []),
            "description": _clip(str(spec.get("description") or ""), 400),
            **({"enum": spec["enum"]} if isinstance(spec.get("enum"), list) else {}),
        })
    row = _row(entry)
    return {
        "ok": True, "action": "describe", "space_id": space_id, **row,
        "description": _clip(str(entry.get("description") or ""), 2000),
        "params": params, "required": list(required or []),
        "input_schema": schema,
        "note": ("Zapier fills any field you leave out from `instructions`, so a short natural-language "
                 "brief plus the fields that must be exact is usually the right call."),
        "server": server.describe(),
    }


def _a_run(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Execute one Zapier action against the caller's connected accounts."""
    server = _resolve_server(space_id, payload)
    wanted = _wanted_tool(payload)
    entry, alternatives = _resolve_tool(server, wanted)
    if not entry:
        return {"ok": False, "action": "run", "error":
                f"'{wanted}' matched several actions — name one of these exactly in `tool`",
                "candidates": alternatives, "server": server.describe()}
    name = str(entry.get("name") or "")
    args = _run_args(payload, entry)

    try:
        result = _rpc(server, "tools/call", {"name": name, "arguments": args}, timeout=CALL_TIMEOUT)
    except ZapierError as exc:
        out = {"ok": False, "action": "run", "tool": name, "app": _app_of(name),
               "error": str(exc), "status": exc.status or None, "server": server.describe()}
        if exc.status in (401, 403) or _AUTH_HINTS.search(str(exc)):
            out["needs_auth"] = True
            out.update(_connect_urls(server))
        return out

    text = _content_text(result.get("content"))
    structured = result.get("structuredContent")
    parsed = structured if isinstance(structured, (dict, list)) else _maybe_json(text)
    is_error = bool(result.get("isError"))
    needs_auth = bool(is_error and _AUTH_HINTS.search(text or ""))

    out: Dict[str, Any] = {
        "ok": not is_error, "action": "run", "tool": name, "app": _app_of(name),
        "app_label": _label_of(_app_of(name)), "title": _row(entry)["title"],
        "arguments": _redact_args(args),
        "text": _clip(text, MAX_OUTPUT),
        "server": server.describe(),
    }
    if parsed is not None:
        out["result"] = parsed
    if wanted and wanted != name:
        out["resolved_from"] = wanted
    if is_error:
        out["error"] = _clip(text, 1200) or "Zapier reported the action failed"
    if needs_auth:
        out["needs_auth"] = True
        out["error"] = (out.get("error") or "") + (
            f"\n\nThis looks like a missing or expired {_label_of(_app_of(name))} connection in Zapier. "
            f"Open Zapier from the tool's Connect screen and reauthorize the account.")
        out.update(_connect_urls(server))
    return out


def _a_refresh(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Re-read the action list from Zapier (after adding apps or actions there)."""
    server = _resolve_server(space_id, payload)
    _SESSIONS.pop(server.fingerprint, None)
    tools = _tools(server, refresh=True)
    return {"ok": True, "action": "refresh", "space_id": space_id,
            "action_count": len(tools),
            "app_count": len({_app_of(t.get("name") or "") for t in tools}),
            "server": server.describe()}


# --------------------------------------------------------------------------- #
# Connecting a Zapier account
# --------------------------------------------------------------------------- #

def _scope_of(payload: Dict[str, Any]) -> str:
    """``space`` (the default — the project's agents use it) or ``personal``."""
    raw = str(payload.get("scope") or payload.get("target") or "space").strip().lower()
    return "personal" if raw in ("personal", "user", "me", "mine") else "space"


def _assert_may_manage(space_id: str, payload: Dict[str, Any], scope: str, what: str) -> str:
    """Return the user id whose slot is being written, refusing a foreign one."""
    caller = _caller(payload)
    if scope == "personal":
        if not caller:
            raise ZapierError("could not establish who you are — reopen the tool and try again",
                              status=401)
        return caller
    existing = _json_get(_conn_key(space_id))
    owner = str((existing or {}).get("owner_user_id") or "")
    if existing and owner and caller and caller != owner:
        raise ZapierError(f"only the member who connected this space's Zapier account can {what}",
                          status=403)
    return ""


def _a_connect(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Start — or finish — connecting a Zapier account.

    Called with a ``token`` (or ``server_url``) it stores the connection. Called
    bare it returns how to connect: the embed webview URL when Zapier MCP Embed is
    configured (the user authorizes app accounts in-app, no token to copy), and
    always the Zapier URLs plus the token instructions as the universal path."""
    scope = _scope_of(payload)
    user_slot = _assert_may_manage(space_id, payload, scope, "replace it")
    token = str(payload.get("token") or payload.get("connection_token") or "").strip()
    server_url = str(payload.get("server_url") or payload.get("serverUrl") or "").strip()

    if token or server_url:
        return _store_connection(space_id, payload, scope, user_slot, token=token, server_url=server_url)

    out: Dict[str, Any] = {
        "ok": True, "action": "connect", "space_id": space_id, "scope": scope,
        "status": "pending",
        "instructions": (
            "Open Zapier, add the apps you want and authorize each account, then copy the MCP "
            "server's connection token back here."),
        "steps": [
            {"n": 1, "text": "Open Zapier MCP and sign in", "url": ZAPIER_MCP_HOME},
            {"n": 2, "text": "Add the apps and actions you want, authorizing each account"},
            {"n": 3, "text": "Copy your server's connection token and paste it here"},
        ],
    }
    out.update(_connect_urls(None))
    if EMBED_ID:
        handshake = _new_handshake(space_id, payload, scope, user_slot)
        out["embed_url"] = _embed_url(handshake)
        out["handshake"] = handshake
        out["status"] = "awaiting_embed"
        out["instructions"] = (
            "Connect your apps right here: authorize each account in the Zapier panel, and this "
            "tool picks up your personal Zapier server automatically.")
    return out


def _new_handshake(space_id: str, payload: Dict[str, Any], scope: str, user_slot: str) -> str:
    handshake = secrets.token_urlsafe(24)
    _json_put(f"zapier/embed/{handshake}", {
        "space_id": space_id, "scope": scope, "user_slot": user_slot,
        "started_by": _caller(payload), "expires_at": time.time() + HANDSHAKE_TTL_S,
    })
    # Also index it by space so `connect_wait` can find the freshest one.
    _json_put(f"zapier/embed_latest/{space_id}", {"handshake": handshake, "at": time.time()})
    return handshake


def _embed_url(handshake: str) -> str:
    path = f"{INGRESS_PATH}/embed?h={urllib.parse.quote(handshake, safe='')}"
    return (INGRESS_BASE + path) if INGRESS_BASE else path


def _store_connection(space_id: str, payload: Dict[str, Any], scope: str, user_slot: str, *,
                      token: str = "", server_url: str = "", label: str = "",
                      kind: str = "") -> Dict[str, Any]:
    """Persist a connection and verify it actually answers before reporting success."""
    if server_url:
        low = server_url.lower()
        # https only, except for a deliberately overridden prefix (a self-hosted
        # or regional endpoint, or a test harness).
        if not (low.startswith("https://") or low.startswith(EMBED_URL_PREFIX.lower())):
            raise ZapierError("a Zapier MCP server URL must be an https:// URL", status=400)
        secret, kind = server_url, kind or "server_url"
    elif token:
        # A pasted "token" is often the whole URL — accept either.
        if token.lower().startswith("https://"):
            secret, kind = token, kind or "server_url"
        else:
            secret, kind = token, kind or "token"
    else:
        raise ZapierError("pass the Zapier connection `token` (or a `server_url`) to connect",
                          status=400)

    record = {
        "kind": kind,
        "owner_user_id": _caller(payload),
        "label": label or str(payload.get("label") or "").strip() or "Zapier workspace",
        # A space connection is shared with the space (and therefore its agents)
        # by default — that is the entire point of connecting it inside a project.
        # The owner can lock it down with `set_shared`.
        "shared": _truthy(payload.get("shared"), default=True) if scope == "space" else False,
        "connected_at": time.time(),
        **({"bearer": EMBED_SECRET} if kind == "server_url" and EMBED_SECRET else {}),
    }
    probe = _server_from_record(record, secret, scope=("user" if scope == "personal" else "space"))
    _SESSIONS.pop(probe.fingerprint, None)
    try:
        tools = _fetch_tools(probe)
    except ZapierError as exc:
        raise ZapierError(f"that Zapier connection did not work: {exc}", status=exc.status or 400) from exc

    _store_put(_secret_key(space_id, user_slot), secret)
    _json_put(_conn_key(space_id, user_slot), record)
    _TOOLS_CACHE[probe.fingerprint] = (time.time(), tools)
    _json_put(_cache_key(probe), {"fetched_at": time.time(), "tools": tools})

    apps = sorted({_app_of(str(t.get("name") or "")) for t in tools})
    return {
        "ok": True, "action": "connect", "space_id": space_id, "scope": scope,
        "status": "connected", "connected": True,
        "label": record["label"], "shared": record["shared"],
        "action_count": len(tools), "app_count": len(apps),
        "apps": [{"app": a, "label": _label_of(a)} for a in apps[:40]],
        "server": probe.describe(),
    }


def _a_connect_wait(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Server-paced wait for an embed handshake to land, so the UI needs no timer.

    Returns ``pending`` when the budget runs out; the front-end simply calls
    again, exactly like the github tool's ``oauth_wait``."""
    handshake = str(payload.get("handshake") or "").strip()
    if not handshake:
        latest = _json_get(f"zapier/embed_latest/{space_id}") or {}
        handshake = str(latest.get("handshake") or "")
    if not handshake:
        return {"ok": True, "action": "connect_wait", "status": "expired", "connected": False}
    budget = time.time() + min(float(payload.get("wait_seconds") or 25), 40.0)
    interval = 2.0
    while True:
        pending = _json_get(f"zapier/embed/{handshake}")
        if pending is None or pending.get("claimed_at"):
            # The panel handed back a server (or the handshake is gone because it
            # was consumed) — report the resulting connection.
            res = _a_status(space_id, payload)
            res.update({"ok": True, "action": "connect_wait", "status": "connected",
                        "connected": bool(res.get("connected"))})
            return res
        if time.time() > float(pending.get("expires_at") or 0):
            _store_del(f"zapier/embed/{handshake}")
            return {"ok": True, "action": "connect_wait", "status": "expired", "connected": False}
        if time.time() + interval >= budget:
            return {"ok": True, "action": "connect_wait", "status": "pending", "connected": False,
                    "handshake": handshake}
        time.sleep(interval)


def _a_disconnect(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Drop a stored connection. Only its owner may."""
    scope = _scope_of(payload)
    user_slot = _assert_may_manage(space_id, payload, scope, "disconnect it")
    existing = _json_get(_conn_key(space_id, user_slot))
    secret = _store_get(_secret_key(space_id, user_slot))
    if secret and existing:
        try:
            stale = _server_from_record(existing, secret, scope="space")
            _SESSIONS.pop(stale.fingerprint, None)
            _TOOLS_CACHE.pop(stale.fingerprint, None)
            _store_del(_cache_key(stale))
        except Exception:  # noqa: BLE001 — best effort cache eviction
            pass
    _store_del(_secret_key(space_id, user_slot))
    _store_del(_conn_key(space_id, user_slot))
    return {"ok": True, "action": "disconnect", "space_id": space_id, "scope": scope,
            "connected": False, "status": "disconnected"}


def _a_set_shared(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Owner-only: may the rest of the space — including its agents — use this?"""
    conn = _json_get(_conn_key(space_id))
    if not conn:
        raise ZapierError("this space has no Zapier connection to share", status=409)
    _assert_may_manage(space_id, payload, "space", "change its sharing")
    if "shared" not in payload and "value" not in payload and "enabled" not in payload:
        raise ZapierError("pass `shared: true|false`", status=400)
    raw = payload.get("shared", payload.get("value", payload.get("enabled")))
    conn["shared"] = _truthy(raw, default=True)
    _json_put(_conn_key(space_id), conn)
    return {"ok": True, "action": "set_shared", "space_id": space_id, "shared": conn["shared"],
            "note": ("the space's members and agents can use this Zapier connection"
                     if conn["shared"] else
                     "only you can use this Zapier connection; agents fall back to the platform workspace")}


# --------------------------------------------------------------------------- #
# Argument helpers
# --------------------------------------------------------------------------- #

def _wanted_tool(payload: Dict[str, Any]) -> str:
    """The Zapier action a caller named.

    Deliberately NOT read from ``action``: that key selects this creature's own
    operation, so overloading it would make ``run`` unreachable."""
    for key in ("tool", "tool_name", "zap", "zap_tool", "zapier_tool", "name", "operation"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    app = str(payload.get("app") or "").strip()
    # A chat command arrives as one free-text blob ("gmail_send_email hi there"):
    # the first word is the action, the rest becomes the instructions.
    for key in ("args", "chat_text", "query", "text", "input", "task"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            first = val.strip().split()[0]
            if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{2,}", first):
                return first
            break
    return app


def _run_args(payload: Dict[str, Any], entry: Dict[str, Any]) -> Dict[str, Any]:
    """The arguments to hand Zapier: the caller's ``params`` plus ``instructions``.

    Zapier fills any field the caller omits from the natural-language
    ``instructions``, so both halves are passed through when present."""
    args: Dict[str, Any] = {}
    for key in ("params", "arguments", "args", "fields", "input", "body"):
        val = payload.get(key)
        if isinstance(val, dict):
            args.update(val)
        elif isinstance(val, str) and val.strip().startswith("{"):
            parsed = _maybe_json(val)
            if isinstance(parsed, dict):
                args.update(parsed)
        elif isinstance(val, list):
            # A caller (the Victor front-end, or a model that likes lists) may send
            # the fields as [{name, value}] pairs rather than one object.
            for pair in val:
                if isinstance(pair, dict) and pair.get("name"):
                    args[str(pair["name"])] = pair.get("value")

    instructions = ""
    for key in ("instructions", "instruction", "prompt", "task", "text", "message", "query"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            instructions = val.strip()
            break
    if not instructions:
        for key in ("args", "chat_text"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                rest = val.strip().split(None, 1)
                instructions = rest[1].strip() if len(rest) > 1 else ""
                break
    if instructions and "instructions" not in args:
        args["instructions"] = instructions

    # Never forward the platform's own routing/identity keys to Zapier.
    for noise in ("space_id", "spaceId", "store_id", "storeId", "__caller_id", "function",
                  "action", "tool", "tool_name", "command", "scope", "refresh", "limit"):
        args.pop(noise, None)

    schema = entry.get("inputSchema") or entry.get("input_schema") or {}
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict) and props and not args:
        raise ZapierError(
            f"'{entry.get('name')}' needs arguments — call `describe` for its parameters, then pass "
            f"them in `params` (and/or a plain-English `instructions`)", status=400)
    return args


_SECRETISH = re.compile(r"(token|secret|password|api[_-]?key|authorization)", re.I)


def _redact_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """Echo the arguments back with anything credential-shaped masked."""
    out: Dict[str, Any] = {}
    for key, val in (args or {}).items():
        out[key] = "…" if _SECRETISH.search(str(key)) else (
            _clip(val, 500) if isinstance(val, str) else val)
    return out


def _truthy(value: Any, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "y")


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, n))


# --------------------------------------------------------------------------- #
# The embed page — served IN this container over the node's VM HTTP ingress
# --------------------------------------------------------------------------- #
#
# Zapier MCP Embed is a browser web component: it renders Zapier's own
# "connect your apps" UI, runs the OAuth dance for each app, and hands the page
# the end user's personal MCP server URL. We serve a minimal page that hosts it
# and posts that URL straight back to this creature, so the user never copies a
# token and the URL never travels through the client.

def _embed_page(handshake: str) -> str:
    safe = html.escape(handshake, quote=True)
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your apps</title>
<script src="{html.escape(EMBED_SCRIPT, quote=True)}"></script>
<style>
  html,body{{margin:0;height:100%;background:#0b1220;color:#e6edf7;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif}}
  header{{padding:14px 18px;border-bottom:1px solid #22304d}}
  h1{{font-size:15px;margin:0}} p{{margin:4px 0 0;font-size:12px;color:#8ea3c4}}
  #wrap{{height:calc(100% - 62px)}}
  #done{{display:none;padding:28px;text-align:center}}
  #done b{{color:#4ade80}}
</style></head><body>
<header><h1>Connect your apps</h1>
<p>Authorize an account for each app you want your agents to use.</p></header>
<div id="wrap"><zapier-mcp embed-id="{html.escape(EMBED_ID, quote=True)}"
  width="100%" height="100%"></zapier-mcp></div>
<div id="done"><b>Connected.</b><p>You can close this panel and return to Decillion.</p></div>
<script>
  var handshake = {json.dumps(safe)};
  var el = document.querySelector('zapier-mcp');
  function claim(serverUrl) {{
    fetch('embed/claim', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{ h: handshake, serverUrl: serverUrl }})
    }}).then(function (r) {{ return r.json(); }}).then(function (res) {{
      if (res && res.ok) {{
        document.getElementById('wrap').style.display = 'none';
        document.getElementById('done').style.display = 'block';
      }}
    }}).catch(function () {{}});
  }}
  var serverUrl = null;
  if (el) {{
    el.addEventListener('mcp-server-url', function (e) {{
      if (e && e.detail && e.detail.serverUrl) {{
        serverUrl = e.detail.serverUrl;
        claim(serverUrl);
      }}
    }});
    // Adding or removing apps changes what agents can do — re-claim so the
    // creature re-reads the action list instead of serving a stale one.
    el.addEventListener('tools-changed', function () {{
      if (serverUrl) claim(serverUrl);
    }});
  }}
</script></body></html>"""


def _notice_page(title: str, message: str) -> str:
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(title)}</title>"
        "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;"
        "color:#e6edf7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}"
        ".card{max-width:420px;padding:32px;text-align:center}h1{font-size:19px;margin:0 0 12px}"
        "p{color:#8ea3c4;line-height:1.5}</style></head>"
        f'<body><div class="card"><h1>{html.escape(title)}</h1>'
        f"<p>{html.escape(message)}</p></div></body></html>"
    )


def _claim_embed(handshake: str, server_url: str) -> Dict[str, Any]:
    """Bind an embed-issued server URL to the space/user that started the flow.

    The space and owner come from the STORED handshake, never the request, so a
    forged claim cannot attach a server to a space it did not start."""
    pending = _json_get(f"zapier/embed/{handshake}")
    if not pending:
        raise ZapierError("this connect link has already been used or has expired", status=410)
    if time.time() > float(pending.get("expires_at") or 0):
        _store_del(f"zapier/embed/{handshake}")
        raise ZapierError("this connect link has expired — start the connect flow again", status=410)
    if not server_url.lower().startswith(EMBED_URL_PREFIX.lower()):
        raise ZapierError("that is not a Zapier MCP server URL", status=400)
    space_id = str(pending.get("space_id") or "")
    scope = str(pending.get("scope") or "space")
    res = _store_connection(
        space_id, {"__caller_id": pending.get("started_by") or ""}, scope,
        str(pending.get("user_slot") or ""),
        server_url=server_url, label="Zapier (connected apps)", kind="server_url")
    # Keep the handshake until it expires rather than burning it: the panel stays
    # open while the person keeps adding apps, and each `tools-changed` re-claim
    # re-reads the action list so agents see the new apps immediately.
    pending["claimed_at"] = time.time()
    _json_put(f"zapier/embed/{handshake}", pending)
    return res


def http_handler(method, path, query, headers, body):
    """The embed surface, served over the node's VM HTTP ingress straight into
    this container. Two routes only: the page, and the claim it posts back."""
    tail = "/" + str(path or "").strip("/").split("/")[-1]
    if method == "GET" and tail == "/embed":
        handshake = str(query.get("h") or "").strip()
        if not EMBED_ID:
            return (404, "text/html; charset=utf-8",
                    _notice_page("Not available",
                                 "Zapier MCP Embed is not configured for this deployment. "
                                 "Connect with a Zapier connection token instead."))
        if not handshake or not _json_get(f"zapier/embed/{handshake}"):
            return (400, "text/html; charset=utf-8",
                    _notice_page("Link expired",
                                 "Start the connect flow again from the Zapier tool."))
        return (200, "text/html; charset=utf-8", _embed_page(handshake))
    if method == "POST" and tail == "/claim":
        try:
            payload = json.loads((body or b"").decode("utf-8", "replace") or "{}")
        except ValueError:
            payload = {}
        try:
            res = _claim_embed(str(payload.get("h") or "").strip(),
                               str(payload.get("serverUrl") or "").strip())
            return (200, "application/json; charset=utf-8", json.dumps({"ok": True, "apps": res.get("app_count")}))
        except ZapierError as exc:
            return (int(exc.status or 400), "application/json; charset=utf-8",
                    json.dumps({"ok": False, "error": str(exc)}))
        except Exception:  # noqa: BLE001 — never leak internals to the browser
            return (500, "application/json; charset=utf-8",
                    json.dumps({"ok": False, "error": "unexpected error"}))
    return (404, "text/plain; charset=utf-8", "not found")


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

_ACTIONS = {
    "status": _a_status, "connection": _a_status,
    "apps": _a_apps, "list_apps": _a_apps, "services": _a_apps,
    "actions": _a_actions, "list_actions": _a_actions, "tools": _a_actions, "search": _a_actions,
    "describe": _a_describe, "schema": _a_describe, "params": _a_describe,
    "run": _a_run, "call": _a_run, "execute": _a_run, "do": _a_run,
    "refresh": _a_refresh, "reload": _a_refresh,
    "connect": _a_connect, "link": _a_connect,
    "connect_wait": _a_connect_wait, "wait": _a_connect_wait,
    "disconnect": _a_disconnect, "unlink": _a_disconnect,
    "set_shared": _a_set_shared, "share": _a_set_shared,
}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    """Pick this creature's operation.

    ``payload["action"]`` is honoured only when it actually names one of our
    operations: callers routinely put a Zapier action name in a key called
    ``action``, and treating that as our dispatch key would make ``run``
    unreachable."""
    raw = payload.get("action")
    if isinstance(raw, str) and raw.strip().lower() in _ACTIONS:
        return raw.strip().lower()
    for candidate in (payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    return "status"


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        # An unknown function that names a Zapier action is a `run` in disguise —
        # agents reach for `zapier_gmail_send_email` before they read the docs.
        payload.setdefault("tool", action)
        handler = _a_run
        action = "run"
    try:
        space_id = _space_id(payload)
        return handler(space_id, payload)
    except ZapierError as exc:
        return {"ok": False, "action": action, "error": str(exc), "status": exc.status or None}
    except Exception as exc:  # noqa: BLE001 — never crash the serving loop
        return {"ok": False, "action": action, "error": f"{type(exc).__name__}: {exc}"}
