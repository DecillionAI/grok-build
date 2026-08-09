"""github tool creature — a full git + GitHub client bound to a Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API. Two kinds of caller reach
it, both over the same contract:

* the tool's **front-end** (the Victor "GitHub" mini-app), relayed by Nest and
  **signed as the human user** with ``space_id`` pinned — the connect/OAuth flow
  and the whole repository dashboard;
* the space's **agents**, through Davinci's bridge executor, so an agent can
  clone, branch, commit, push and open/merge pull requests exactly like a human.

State that must survive the container is kept in the node's key/value store
(reached over the docker-host bridge, :mod:`caspar_bridge`), with a local-file
fallback so the tool still works on a node whose ``dbOp`` is unavailable. It is
**keyed by space** so one creature serves every space without a per-space
deployment:

    github/conn/<space_id>     JSON  {owner_user_id, login, shared, scopes, ...}
    github/token/<space_id>    the user's GitHub OAuth access token (secret)
    github/pending/<space_id>  in-flight OAuth handshake (per space, for oauth_wait)
    github/oauth_state/<state> in-flight OAuth handshake (per state, for the callback)

The **binding between a Decillion space and a GitHub account is the OAuth token**
one member connected, so the token is what every call is authorised against. A
per-space *shared* toggle decides whether the rest of the space (people **and**
agents) may drive the connection, or only the member who connected it.

OAuth uses GitHub's standard **web application flow** (authorization code) — the
same "press Connect → GitHub opens in a tab → approve → done" flow every other
GitHub app uses, with **no code to type**:

1. The front-end calls ``oauth_start``; the back-end returns the GitHub
   ``authorize_url`` (with a one-time ``state``) and opens it in a browser tab.
2. The member approves the account + organization access on github.com.
3. GitHub redirects the tab to Nest's fixed callback
   (``GITHUB_OAUTH_REDIRECT_URI``) with ``?code=…&state=…``. Nest signals this
   creature ``oauth_exchange``, which swaps the code for a token and stores it.
4. The front-end long-polls ``oauth_wait`` and flips to the dashboard once the
   token lands.

The OAuth **app credentials** come from the container environment only — never
from a signal payload a prompt could influence:

    GITHUB_OAUTH_CLIENT_ID       required (the OAuth App / GitHub App client id)
    GITHUB_OAUTH_CLIENT_SECRET   required (the web flow signs the token exchange)
    GITHUB_OAUTH_REDIRECT_URI    required — Nest's callback, must exactly match the
                                 OAuth app's "Authorization callback URL"
    GITHUB_OAUTH_SCOPES          default "repo,read:org,workflow,read:user"
    GITHUB_API_BASE              default https://api.github.com
    GITHUB_WEB_BASE              default https://github.com
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import requests

API_BASE = os.environ.get("GITHUB_API_BASE", "https://api.github.com").rstrip("/")
WEB_BASE = os.environ.get("GITHUB_WEB_BASE", "https://github.com").rstrip("/")
DEFAULT_SCOPES = os.environ.get("GITHUB_OAUTH_SCOPES", "repo,read:org,workflow,read:user")
# How long an in-flight OAuth handshake (the authorize→callback round-trip) stays
# valid before the front-end must start over.
OAUTH_STATE_TTL_S = int(os.environ.get("GITHUB_OAUTH_STATE_TTL_S", "900"))

HTTP_TIMEOUT = float(os.environ.get("GITHUB_HTTP_TIMEOUT", "45"))
# Command output / API bodies are fed back into an LLM context and a mobile UI —
# cap them hard so a huge diff or file listing can never blow either up.
MAX_OUTPUT_CHARS = int(os.environ.get("GITHUB_MAX_OUTPUT", "60000"))
API_PAGE_CAP = int(os.environ.get("GITHUB_API_PAGE_CAP", "300"))

# The container keeps NO repository files of its own — all clones live on the
# space's sandbox (see the git/filesystem section). Only the OAuth token/connection
# state falls back to a local file here when the node key/value store is absent.
WORKSPACE = os.environ.get("GITHUB_WORKSPACE", "/workspace")
STATE_DIR = os.path.join(WORKSPACE, ".state")

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


class GithubError(RuntimeError):
    """A tool operation failed; carries an HTTP-ish status for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Persistence — node DB (durable) with a local-file fallback
# --------------------------------------------------------------------------- #
#
# The tool runtime connects the docker-host bridge and hands it to us via
# ``set_bridge`` so persistence can use the node's key/value store, which
# survives a container restart. When no bridge is present (offline / a node
# whose dbOp is unavailable) we fall back to a JSON file under the workspace, and
# we always mirror to that file so reads are cheap and a warm container is
# self-consistent either way.

_BRIDGE = None  # set by set_bridge()


def set_bridge(bridge) -> None:
    global _BRIDGE
    _BRIDGE = bridge


def _bridge():
    """The live gateway bridge, required to signal the space's sandbox creature."""
    if _BRIDGE is None:
        raise GithubError(
            "the github creature is not connected to the node — repository work runs on the "
            "space's sandbox over the gateway, which is unavailable here", status=503)
    return _BRIDGE


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
        # Keep the local mirror warm so a later bridge hiccup still reads.
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
# HTTP: GitHub REST + OAuth (direct egress, like the sandbox tool)
# --------------------------------------------------------------------------- #

def _client_id() -> str:
    val = os.environ.get("GITHUB_OAUTH_CLIENT_ID", "").strip()
    if not val:
        raise GithubError(
            "no GitHub OAuth app configured — set GITHUB_OAUTH_CLIENT_ID on the github "
            "creature image (see scripts/deploy_github_tool.py)")
    return val


def _api(method: str, path: str, token: str, *, body: Any = None,
         params: Optional[Dict[str, Any]] = None) -> Any:
    """Call the GitHub REST API with the space's token and return parsed JSON."""
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "decillion-github-tool",
    }
    try:
        resp = requests.request(method, url, headers=headers, json=body,
                                params={k: v for k, v in (params or {}).items() if v not in (None, "")},
                                timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise GithubError(f"GitHub API unreachable: {exc}", status=502)
    parsed = _parse(resp)
    if resp.status_code == 401:
        raise GithubError("GitHub rejected the stored token (401) — reconnect the tool",
                          status=401, body=parsed)
    if resp.status_code == 403 and isinstance(parsed, dict) and "rate limit" in str(parsed.get("message", "")).lower():
        raise GithubError("GitHub API rate limit reached — try again shortly", status=403, body=parsed)
    if resp.status_code >= 300:
        msg = parsed.get("message") if isinstance(parsed, dict) else parsed
        raise GithubError(f"GitHub API {method} {path} failed ({resp.status_code}): {msg}",
                          status=resp.status_code, body=parsed)
    return parsed


def _parse(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return (resp.text or "")[:2000]


def _form_post(url: str, fields: Dict[str, str]) -> Tuple[int, Any]:
    headers = {"Accept": "application/json", "User-Agent": "decillion-github-tool"}
    try:
        resp = requests.post(url, data=fields, headers=headers, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise GithubError(f"GitHub unreachable: {exc}", status=502)
    return resp.status_code, _parse(resp)


# --------------------------------------------------------------------------- #
# Identity & access control (the shared toggle)
# --------------------------------------------------------------------------- #

def _space_id(payload: Dict[str, Any]) -> str:
    for key in ("space_id", "spaceId", "store_id", "storeId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise GithubError("space_id is required — this tool is bound to a Decillion space")


def _caller(payload: Dict[str, Any]) -> str:
    """The user id on whose behalf this call is made, as far as the tool can tell.

    The tool runtime stamps the trusted caller from the signal envelope as
    ``__caller_id`` (Nest sets the envelope's ``reply_to`` from the authenticated
    user; a guest cannot forge it). The remaining keys are only a fallback for
    offline/unit runs that call :func:`invoke` directly. Either way this is only
    *one* half of the access decision — the other half is the stored owner +
    shared flag."""
    for key in ("__caller_id", "reply_to", "replyTo", "caller_id", "callerId", "user_id", "userId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _conn(space_id: str) -> Optional[Dict[str, Any]]:
    return _json_get(f"github/conn/{space_id}")


def _token_for(space_id: str) -> str:
    token = _store_get(f"github/token/{space_id}")
    if not token:
        raise GithubError("this space is not connected to GitHub yet — connect the tool first",
                          status=409)
    return token


def _effective_owner(space_id: str, payload: Dict[str, Any], conn: Dict[str, Any]) -> str:
    """The connection's owner, claiming it for the caller when unset.

    A connection can end up with no recorded owner (e.g. connected before the
    caller identity was propagated to the tool). Rather than lock everyone out,
    the first authenticated caller **claims** ownership — self-healing, and a
    no-op once an owner is set (which is the case for every new connection)."""
    owner = str(conn.get("owner_user_id") or "")
    if owner:
        return owner
    caller = _caller(payload)
    if caller:
        conn["owner_user_id"] = caller
        _json_put(f"github/conn/{space_id}", conn)
        return caller
    return ""


def _require_use(space_id: str, payload: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Authorise a data/action call and return (token, connection).

    Enforces the *shared* toggle: when a connection is not shared, only the
    member who connected it (matched by user id) may drive it. A call whose
    caller identity cannot be established is allowed only for a shared
    connection — never for a private one."""
    conn = _conn(space_id)
    if not conn:
        raise GithubError("this space is not connected to GitHub yet — connect the tool first",
                          status=409)
    if not conn.get("shared", False):
        caller = _caller(payload)
        owner = _effective_owner(space_id, payload, conn)
        if not caller or caller != owner:
            raise GithubError(
                "this GitHub connection is private to the member who connected it; ask them to "
                "enable sharing in the tool settings to let the rest of the space use it",
                status=403)
    return _token_for(space_id), conn


def _assert_owner(space_id: str, payload: Dict[str, Any], conn: Dict[str, Any], what: str) -> None:
    owner = _effective_owner(space_id, payload, conn)
    caller = _caller(payload)
    if owner and caller and caller != owner:
        raise GithubError(f"only the member who connected GitHub can {what}", status=403)


# --------------------------------------------------------------------------- #
# OAuth web application flow (authorization code)
# --------------------------------------------------------------------------- #
#
# The classic "Connect with GitHub" flow: the front-end opens the authorize URL
# in a tab, the member approves, and GitHub redirects the tab to Nest's fixed
# callback with a one-time ``code``. Nest hands the code back to us over a signal
# (``oauth_exchange``) and we swap it for a token. No code is ever typed, and the
# client secret stays in this container — the front-end never sees it.

def _client_secret() -> str:
    val = os.environ.get("GITHUB_OAUTH_CLIENT_SECRET", "").strip()
    if not val:
        raise GithubError(
            "no GitHub OAuth client secret configured — set GITHUB_OAUTH_CLIENT_SECRET on the "
            "github creature image (the web flow signs the token exchange with it)")
    return val


def _redirect_uri() -> str:
    val = os.environ.get("GITHUB_OAUTH_REDIRECT_URI", "").strip()
    if not val:
        raise GithubError(
            "no GitHub OAuth redirect URI configured — set GITHUB_OAUTH_REDIRECT_URI on the github "
            "creature image to Nest's callback (…/api/github/oauth/callback), and register the exact "
            "same URL as the OAuth app's Authorization callback URL")
    return val


def _make_state(space_id: str) -> str:
    """A one-time, unguessable state that also carries the space id.

    The Nest callback receives only ``code`` + ``state`` from GitHub's redirect,
    so the space id must travel inside the state. It is base64url-encoded (opaque
    to GitHub) and paired with a random nonce we verify against stored state, so a
    forged state cannot connect a token to a space."""
    prefix = base64.urlsafe_b64encode(space_id.encode("utf-8")).decode("ascii").rstrip("=")
    return prefix + "." + secrets.token_urlsafe(24)


def _oauth_start(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Begin the web flow: return the GitHub authorize URL for the front-end to
    open in a browser tab. Records a one-time handshake keyed by both the state
    (for the callback) and the space (for oauth_wait)."""
    client_id = _client_id()
    redirect_uri = _redirect_uri()
    _client_secret()  # fail fast now if the exchange could never succeed later
    scopes = str(payload.get("scopes") or DEFAULT_SCOPES)
    state = _make_state(space_id)
    expires_at = time.time() + OAUTH_STATE_TTL_S
    handshake = {
        "state": state, "space_id": space_id,
        "started_by": _caller(payload), "scopes": scopes,
        "expires_at": expires_at,
    }
    _json_put(f"github/oauth_state/{state}", handshake)
    _json_put(f"github/pending/{space_id}", {"state": state, "expires_at": expires_at})
    query = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scopes.replace(",", " "),
        "state": state,
        "allow_signup": "false",
    })
    return {
        "ok": True, "action": "oauth_start", "space_id": space_id,
        "authorize_url": f"{WEB_BASE}/login/oauth/authorize?{query}",
        "state": state,
        "expires_in": OAUTH_STATE_TTL_S,
    }


def _oauth_exchange(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Swap the authorization ``code`` for a token and store the connection.

    Called by Nest's OAuth callback route (signed as the operator) with the
    ``code`` + ``state`` GitHub redirected back. The space and the owner come from
    the stored handshake, never from the caller, so this cannot be steered."""
    code = str(payload.get("code") or "").strip()
    state = str(payload.get("state") or "").strip()
    if not code or not state:
        raise GithubError("the GitHub callback was missing its code or state", status=400)

    handshake = _json_get(f"github/oauth_state/{state}")
    if not handshake:
        raise GithubError("this GitHub authorization is unknown or already used — start over",
                          status=409)
    if time.time() > float(handshake.get("expires_at") or 0):
        _store_del(f"github/oauth_state/{state}")
        raise GithubError("this GitHub authorization expired — start over", status=410)

    target_space = str(handshake.get("space_id") or "")
    if not target_space:
        raise GithubError("the stored GitHub authorization has no space", status=409)

    fields = {
        "client_id": _client_id(),
        "client_secret": _client_secret(),
        "code": code,
        "redirect_uri": _redirect_uri(),
        "state": state,
    }
    status, parsed = _form_post(f"{WEB_BASE}/login/oauth/access_token", fields)
    if not isinstance(parsed, dict):
        raise GithubError(f"unexpected token response from GitHub ({status})", status=status or 502)
    if parsed.get("error"):
        raise GithubError(f"GitHub authorization failed: {parsed.get('error_description') or parsed.get('error')}",
                          status=400)
    token = parsed.get("access_token")
    if not token:
        raise GithubError("GitHub returned no access token", status=502)

    login, name = "", ""
    try:
        me = _api("GET", "/user", str(token))
        login, name = str(me.get("login") or ""), str(me.get("name") or "")
    except GithubError:
        pass
    conn = {
        "owner_user_id": handshake.get("started_by") or "",
        "login": login, "name": name,
        "shared": bool((_conn(target_space) or {}).get("shared", False)),
        "scopes": str(parsed.get("scope") or handshake.get("scopes") or DEFAULT_SCOPES),
        "connected_at": int(time.time()),
    }
    _store_put(f"github/token/{target_space}", str(token))
    _json_put(f"github/conn/{target_space}", conn)
    _store_del(f"github/oauth_state/{state}")
    _store_del(f"github/pending/{target_space}")
    return {"ok": True, "action": "oauth_exchange", "space_id": target_space,
            "status": "connected", "connected": True, "login": login, "name": name,
            "shared": conn["shared"], "scopes": conn["scopes"]}


def _oauth_wait(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Server-paced wait for the callback to land, so the front-end needs no
    timer: block until the token is stored (the exchange ran), the handshake
    expires, or a wall budget under the host-call timeout elapses. The front-end
    simply re-invokes on ``status == "pending"``."""
    budget = time.time() + float(payload.get("wait_seconds") or 25)
    interval = 2.0
    while True:
        if _store_get(f"github/token/{space_id}"):
            res = _status(space_id, payload)
            res.update({"ok": True, "action": "oauth_wait", "status": "connected", "connected": True})
            return res
        pending = _json_get(f"github/pending/{space_id}")
        if not pending or time.time() > float(pending.get("expires_at") or 0):
            return {"ok": True, "action": "oauth_wait", "space_id": space_id,
                    "status": "expired", "connected": False}
        if time.time() + interval >= budget:
            return {"ok": True, "action": "oauth_wait", "space_id": space_id,
                    "status": "pending", "connected": False}
        time.sleep(interval)


def _status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Report the connection state + settings. Read-only, never gated: everyone
    may *see* whether the tool is connected; only *using* it is gated."""
    conn = _conn(space_id)
    if not conn:
        return {"ok": True, "action": "status", "space_id": space_id, "connected": False}
    caller = _caller(payload)
    owner = str(conn.get("owner_user_id") or "")
    # An unowned connection (legacy/broken connect) is claimable by any caller, so
    # present them as the owner in the UI — the first use call makes it official.
    is_owner = bool(caller) and (owner == "" or caller == owner)
    return {
        "ok": True, "action": "status", "space_id": space_id, "connected": True,
        "login": conn.get("login"), "name": conn.get("name"),
        "shared": bool(conn.get("shared", False)),
        "scopes": conn.get("scopes"), "connected_at": conn.get("connected_at"),
        "is_owner": is_owner, "can_manage": is_owner,
        "can_use": bool(conn.get("shared", False)) or is_owner,
    }


def _disconnect(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    conn = _conn(space_id)
    if conn:
        _assert_owner(space_id, payload, conn, "disconnect it")
    _store_del(f"github/token/{space_id}")
    _store_del(f"github/conn/{space_id}")
    _store_del(f"github/pending/{space_id}")
    return {"ok": True, "action": "disconnect", "space_id": space_id, "connected": False}


def _set_shared(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Flip the shared toggle. Owner-only — it changes who else may drive the
    connection, so a non-owner must never be able to open it up (or lock it)."""
    conn = _conn(space_id)
    if not conn:
        raise GithubError("connect the tool before changing its settings", status=409)
    _assert_owner(space_id, payload, conn, "change its sharing")
    shared = payload.get("shared")
    if isinstance(shared, str):
        shared = shared.strip().lower() in ("1", "true", "yes", "on")
    conn["shared"] = bool(shared)
    _json_put(f"github/conn/{space_id}", conn)
    return {"ok": True, "action": "set_shared", "space_id": space_id, "shared": conn["shared"]}


# --------------------------------------------------------------------------- #
# GitHub API actions (read + write)
# --------------------------------------------------------------------------- #

def _paginate(token: str, path: str, params: Optional[Dict[str, Any]] = None,
              *, cap: int = API_PAGE_CAP) -> List[Any]:
    out: List[Any] = []
    page = 1
    while len(out) < cap:
        rows = _api("GET", path, token, params={**(params or {}), "per_page": 100, "page": page})
        if not isinstance(rows, list) or not rows:
            break
        out.extend(rows)
        if len(rows) < 100:
            break
        page += 1
    return out[:cap]


def _repo_row(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "full_name": r.get("full_name"), "name": r.get("name"),
        "owner": (r.get("owner") or {}).get("login"), "private": r.get("private"),
        "default_branch": r.get("default_branch"), "description": r.get("description"),
        "language": r.get("language"), "stars": r.get("stargazers_count"),
        "open_issues": r.get("open_issues_count"), "fork": r.get("fork"),
        "archived": r.get("archived"), "pushed_at": r.get("pushed_at"),
        "permissions": r.get("permissions"), "clone_url": r.get("clone_url"),
    }


def _a_orgs(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    orgs = _paginate(token, "/user/orgs")
    me = _api("GET", "/user", token)
    return {"ok": True, "action": "orgs", "space_id": space_id,
            "user": {"login": me.get("login"), "name": me.get("name"), "avatar_url": me.get("avatar_url")},
            "orgs": [{"login": o.get("login"), "description": o.get("description"),
                      "avatar_url": o.get("avatar_url")} for o in orgs if isinstance(o, dict)]}


def _a_repos(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    org = str(payload.get("org") or "").strip()
    if org:
        rows = _paginate(token, f"/orgs/{_slug(org)}/repos", {"sort": "pushed"})
    else:
        rows = _paginate(token, "/user/repos",
                         {"sort": "pushed", "affiliation": "owner,collaborator,organization_member"})
    return {"ok": True, "action": "repos", "space_id": space_id, "org": org or None,
            "repos": [_repo_row(r) for r in rows if isinstance(r, dict)]}


def _a_repo(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    return {"ok": True, "action": "repo", "space_id": space_id,
            "repo": _repo_row(_api("GET", f"/repos/{full}", token))}


def _a_branches(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    rows = _paginate(token, f"/repos/{full}/branches")
    return {"ok": True, "action": "branches", "space_id": space_id, "repo": full,
            "branches": [{"name": b.get("name"), "protected": b.get("protected"),
                          "sha": (b.get("commit") or {}).get("sha")} for b in rows if isinstance(b, dict)]}


def _a_commits(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    params: Dict[str, Any] = {"per_page": int(payload.get("limit") or 30)}
    if payload.get("branch") or payload.get("sha"):
        params["sha"] = payload.get("branch") or payload.get("sha")
    if payload.get("path"):
        params["path"] = payload["path"]
    rows = _api("GET", f"/repos/{full}/commits", token, params=params)
    out = []
    for c in rows if isinstance(rows, list) else []:
        commit = c.get("commit") or {}
        author = commit.get("author") or {}
        out.append({"sha": c.get("sha"), "message": commit.get("message"),
                    "author": author.get("name"), "date": author.get("date"),
                    "login": (c.get("author") or {}).get("login")})
    return {"ok": True, "action": "commits", "space_id": space_id, "repo": full, "commits": out}


def _pull_row(p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "number": p.get("number"), "title": p.get("title"), "state": p.get("state"),
        "draft": p.get("draft"), "user": (p.get("user") or {}).get("login"),
        "head": (p.get("head") or {}).get("ref"), "base": (p.get("base") or {}).get("ref"),
        "merged": p.get("merged"), "mergeable": p.get("mergeable"),
        "mergeable_state": p.get("mergeable_state"), "html_url": p.get("html_url"),
        "created_at": p.get("created_at"), "updated_at": p.get("updated_at"),
        "body": _clip(p.get("body") or "", 4000),
    }


def _a_pulls(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    state = str(payload.get("state") or "open")
    rows = _paginate(token, f"/repos/{full}/pulls", {"state": state, "sort": "updated", "direction": "desc"})
    return {"ok": True, "action": "pulls", "space_id": space_id, "repo": full, "state": state,
            "pulls": [_pull_row(p) for p in rows if isinstance(p, dict)]}


def _a_get_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    return {"ok": True, "action": "get_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("GET", f"/repos/{full}/pulls/{number}", token))}


def _a_create_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    head, base, title = (str(payload.get("head") or "").strip(),
                         str(payload.get("base") or "").strip(),
                         str(payload.get("title") or "").strip())
    if not head or not base or not title:
        raise GithubError("create_pull needs `title`, `head` and `base`")
    body: Dict[str, Any] = {"title": title, "head": head, "base": base}
    if payload.get("body"):
        body["body"] = str(payload["body"])
    if payload.get("draft") is not None:
        body["draft"] = bool(payload["draft"])
    return {"ok": True, "action": "create_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("POST", f"/repos/{full}/pulls", token, body=body))}


def _a_merge_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    body: Dict[str, Any] = {}
    method = str(payload.get("merge_method") or payload.get("method") or "merge").lower()
    if method in ("merge", "squash", "rebase"):
        body["merge_method"] = method
    for key in ("commit_title", "commit_message"):
        if payload.get(key):
            body[key] = str(payload[key])
    res = _api("PUT", f"/repos/{full}/pulls/{number}/merge", token, body=body)
    return {"ok": bool(res.get("merged")), "action": "merge_pull", "space_id": space_id,
            "repo": full, "number": number, "merged": res.get("merged"),
            "sha": res.get("sha"), "message": res.get("message")}


def _a_update_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    number = _number(payload)
    body: Dict[str, Any] = {}
    for key in ("title", "body", "state", "base"):
        if payload.get(key) is not None:
            body[key] = str(payload[key])
    if not body:
        raise GithubError("update_pull needs at least one of title, body, state, base")
    return {"ok": True, "action": "update_pull", "space_id": space_id, "repo": full,
            "pull": _pull_row(_api("PATCH", f"/repos/{full}/pulls/{number}", token, body=body))}


def _a_issues(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    state = str(payload.get("state") or "open")
    rows = _paginate(token, f"/repos/{full}/issues", {"state": state, "sort": "updated", "direction": "desc"})
    out = []
    for i in rows if isinstance(rows, list) else []:
        if not isinstance(i, dict) or i.get("pull_request"):
            continue  # the issues endpoint also returns PRs; drop them
        out.append({"number": i.get("number"), "title": i.get("title"), "state": i.get("state"),
                    "user": (i.get("user") or {}).get("login"), "comments": i.get("comments"),
                    "html_url": i.get("html_url"),
                    "labels": [l.get("name") for l in (i.get("labels") or []) if isinstance(l, dict)]})
    return {"ok": True, "action": "issues", "space_id": space_id, "repo": full, "state": state, "issues": out}


def _a_create_issue(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    title = str(payload.get("title") or "").strip()
    if not title:
        raise GithubError("create_issue needs a `title`")
    body: Dict[str, Any] = {"title": title}
    if payload.get("body"):
        body["body"] = str(payload["body"])
    if isinstance(payload.get("labels"), list):
        body["labels"] = [str(l) for l in payload["labels"]]
    i = _api("POST", f"/repos/{full}/issues", token, body=body)
    return {"ok": True, "action": "create_issue", "space_id": space_id, "repo": full,
            "number": i.get("number"), "html_url": i.get("html_url")}


# --------------------------------------------------------------------------- #
# Git operations on a per-space workspace
# --------------------------------------------------------------------------- #

def _full_name(payload: Dict[str, Any]) -> str:
    """The ``owner/repo`` slug, from an explicit field or owner+repo pair."""
    full = str(payload.get("repo") or payload.get("full_name") or "").strip()
    if "/" in full:
        owner, name = full.split("/", 1)
        return f"{_slug(owner)}/{_slug(name)}"
    owner = str(payload.get("owner") or payload.get("org") or "").strip()
    name = str(payload.get("name") or full).strip()
    if not owner or not name:
        raise GithubError("a repository is required as `repo` = \"owner/name\" (or owner + name)")
    return f"{_slug(owner)}/{_slug(name)}"


def _slug(s: str) -> str:
    """A GitHub owner/repo/branch component with path + shell metacharacters
    stripped, so a forged value can never escape a filesystem path or an argv."""
    cleaned = _UNSAFE.sub("", str(s).strip())
    if not cleaned:
        raise GithubError(f"invalid name component: {s!r}")
    return cleaned


def _number(payload: Dict[str, Any]) -> int:
    for key in ("number", "pull_number", "issue_number", "pr"):
        val = payload.get(key)
        if val not in (None, ""):
            try:
                return int(val)
            except (TypeError, ValueError):
                raise GithubError(f"{key} must be a number")
    raise GithubError("a pull request / issue number is required")


# --------------------------------------------------------------------------- #
# Git + filesystem — run on the space's vercel_sandbox creature over signalling
# --------------------------------------------------------------------------- #
#
# The github tool NEVER touches its own container filesystem for repository work.
# Every clone / fetch / pull / push / commit / branch / merge and every file
# read/write/list happens on the space's **vercel_sandbox** creature — the same
# machine the space's agents and the Files desktop use — reached by signalling
# that creature over Caspar (bridge.invoke_tool). So a repo an agent clones here
# is the repo everyone in the space sees, on one shared filesystem.

SANDBOX_ENTITY = os.environ.get("GITHUB_SANDBOX_ENTITY", "vercel_sandbox")
# Where clones live on the sandbox, relative to its home directory.
REPO_ROOT = os.environ.get("GITHUB_SANDBOX_REPO_ROOT", "github")
SANDBOX_TIMEOUT_S = int(os.environ.get("GITHUB_SANDBOX_TIMEOUT_S", "300"))
_SANDBOX_TTL = float(os.environ.get("GITHUB_SANDBOX_CACHE_TTL", "300"))

# Discovered (space_id -> ({program_id, entity_id, creature_id}, deadline)). The
# sandbox creature's id is resolved from the space itself over Caspar (see
# _discover_sandbox), never handed to us by the backend, and cached briefly.
_SANDBOX_CACHE: Dict[str, Tuple[Dict[str, str], float]] = {}


def _auth_header(token: str) -> str:
    """The ``http.extraheader`` value that authenticates git without writing the
    token into the repo's stored remote or config. Carried to the sandbox in the
    command's environment, never in the command string itself."""
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return f"AUTHORIZATION: basic {basic}"


# --------------------------------------------------------------------------- #
# Discovering the space's sandbox creature over Caspar (no backend involved)
# --------------------------------------------------------------------------- #
#
# The github creature finds the space's sandbox itself, exactly the way the agent
# backbone discovers a space's tools: read the space store's members over the
# gateway, fetch each member creature's descriptor, and pick the one that is the
# space's execution tool (the sandbox). Nothing is pinned by the NestJS proxy —
# creature↔creature routing is resolved on Caspar and stays on Caspar.

def _first_array(obj: Any, keys: List[str]) -> List[Any]:
    if isinstance(obj, list):
        return obj
    if not isinstance(obj, dict):
        return []
    for k in keys:
        if isinstance(obj.get(k), list):
            return obj[k]
    for k in ("result", "data", "obj", "value"):
        if isinstance(obj.get(k), dict):
            nested = _first_array(obj[k], keys)
            if nested:
                return nested
    return []


def _pick(entry: Dict[str, Any], keys: List[str]) -> str:
    for k in keys:
        v = entry.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _member_routing(entry: Any) -> Optional[Dict[str, str]]:
    if not isinstance(entry, dict):
        return None
    creature_id = _pick(entry, ["creatureId", "creature_id", "userId", "user_id", "id"])
    program_id = _pick(entry, ["programId", "program_id", "pid"])
    entity_id = _pick(entry, ["entityId", "entity_id"])
    if not creature_id and not program_id:
        return None
    return {"creature_id": creature_id, "program_id": program_id, "entity_id": entity_id}


def _extract_descriptor(resp: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(resp, dict):
        return None
    roots = [resp, resp.get("obj"), resp.get("meta"), resp.get("metadata"),
             resp.get("result"), resp.get("data"), resp.get("creature"), resp.get("record")]
    for root in roots:
        if not isinstance(root, dict):
            continue
        pub = root.get("public")
        d = (pub.get("decillion") if isinstance(pub, dict) else None) or root.get("decillion")
        if not d and root.get("kind") and isinstance(root.get("usecases"), list):
            d = root
        if isinstance(d, dict) and d.get("kind"):
            return d
    return None


def _is_sandbox_descriptor(d: Dict[str, Any]) -> bool:
    """True when a member's descriptor is the space's sandbox (execution) tool."""
    name = str(d.get("name") or "").lower()
    tool_id = str(d.get("tool_id") or "").lower()
    if "github" in name or "github" in tool_id:
        return False  # never mistake ourselves for the sandbox
    if "sandbox" in name or "vercel_sandbox" in tool_id:
        return True
    cats = [str(c).lower() for c in (d.get("categories") or [])]
    return str(d.get("category") or "").lower() == "execution" or "execution" in cats


def _read_members(space_id: str) -> List[Dict[str, str]]:
    id_input = {"storeId": space_id, "id": space_id, "store": space_id, "storeID": space_id}
    for op in ("readMembers", "listStoreMembers", "listStoreAccess", "listAccess"):
        try:
            resp = _bridge().call(op, id_input, timeout=15)
        except Exception:  # noqa: BLE001 — try the next alias
            continue
        rows = _first_array(resp, ["members", "list", "access", "creatures", "results", "items", "entries"])
        members = [m for m in (_member_routing(r) for r in rows) if m]
        if members:
            return members
    return []


def _read_programs(space_id: str) -> List[Dict[str, Any]]:
    """The space's attached programs, from the on-chain program index.

    Platform tools (the sandbox) are attached to a space as **programs** — an
    entry in `Json::StoreProgramIndex::<space>`, written by the spaces creature —
    not as store *members*. The index carries each program's descriptor + routing
    inline, so this is both the correct place to find the sandbox and cheaper than
    a per-member `getCreature` round-trip."""
    try:
        resp = _bridge().call("getJson", {"key": "Json::StoreProgramIndex::" + space_id, "path": ""}, timeout=15)
    except Exception:  # noqa: BLE001
        return []
    data: Any = None
    if isinstance(resp, dict):
        data = resp.get("data")
        if not isinstance(data, dict):
            for k in ("obj", "result"):
                v = resp.get(k)
                if isinstance(v, dict) and isinstance(v.get("data"), dict):
                    data = v.get("data")
                    break
    if not isinstance(data, dict):
        return []
    return [v for v in data.values() if isinstance(v, dict) and v]


def _program_is_sandbox(rec: Dict[str, Any]) -> bool:
    meta = rec.get("metadata") if isinstance(rec.get("metadata"), dict) else {}
    d = meta.get("descriptor") if isinstance(meta.get("descriptor"), dict) else None
    if d and _is_sandbox_descriptor(d):
        return True
    name = str(meta.get("name") or rec.get("name") or "").lower()
    if "github" in name:
        return False
    return "sandbox" in name or "vercel_sandbox" in name


def _read_platform_registry() -> List[Dict[str, Any]]:
    """The platform-tool registry (the market creature's ``platform`` bucket).

    This is the *same* global, space-independent source ``spaces/create`` reads to
    decide which tools to auto-attach — a docker tool's ``getJson`` and a WASM
    creature's ``putJson`` share the node's global JSON keyspace. Every entry is
    ``{key, name, programId, creatureId, entityId, descriptor, autoAttach}``."""
    try:
        resp = _bridge().call(
            "getJson", {"key": "Json::CreatureNamespace::market", "path": "platform"}, timeout=15)
    except Exception:  # noqa: BLE001
        return []
    data: Any = None
    if isinstance(resp, dict):
        data = resp.get("data")
        if not isinstance(data, dict):
            for k in ("obj", "result"):
                v = resp.get(k)
                if isinstance(v, dict) and isinstance(v.get("data"), dict):
                    data = v.get("data")
                    break
    if not isinstance(data, dict):
        return []
    return [v for v in data.values() if isinstance(v, dict) and v]


def _registry_entry_is_sandbox(entry: Dict[str, Any]) -> bool:
    """True when a platform-registry entry is the execution sandbox (never us).

    Matched on identity (key/name) or an execution descriptor — deliberately not
    on ``autoAttach`` alone, so a future auto-attach platform tool that is not the
    sandbox (the manifest already carries a `nest` tool) is never mis-routed."""
    key = str(entry.get("key") or "").lower()
    name = str(entry.get("name") or "").lower()
    if "github" in key or "github" in name:
        return False
    d = entry.get("descriptor") if isinstance(entry.get("descriptor"), dict) else None
    if d and _is_sandbox_descriptor(d):
        return True
    return "sandbox" in key or "sandbox" in name or "vercel_sandbox" in key


def _discover_sandbox(space_id: str) -> Optional[Dict[str, str]]:
    """Resolve the space's sandbox creature routing, cached briefly."""
    now = time.monotonic()
    cached = _SANDBOX_CACHE.get(space_id)
    if cached and cached[1] > now:
        return cached[0]
    self_pid = getattr(_BRIDGE, "program_id", "") or ""
    # 1) Preferred: the space's program index, where the sandbox is attached.
    for rec in _read_programs(space_id):
        pid = _pick(rec, ["programId", "program_id"])
        if pid and pid == self_pid:
            continue
        if not _program_is_sandbox(rec):
            continue
        meta = rec.get("metadata") if isinstance(rec.get("metadata"), dict) else {}
        route = {
            "program_id": pid or _pick(rec, ["creatureId", "creature_id"]),
            "creature_id": _pick(rec, ["creatureId", "creature_id"]),
            "entity_id": _pick(rec, ["entityId", "entity_id"]) or str(meta.get("entityId") or "") or SANDBOX_ENTITY,
        }
        _SANDBOX_CACHE[space_id] = (route, now + _SANDBOX_TTL)
        return route
    # 2) Fallback: the space's members (older attach paths / non-platform tools).
    for m in _read_members(space_id):
        if m["program_id"] and m["program_id"] == self_pid:
            continue  # skip ourselves
        ident = m["creature_id"] or m["program_id"]
        try:
            resp = _bridge().call("getCreature", {"userId": ident, "creatureId": ident}, timeout=15)
        except Exception:  # noqa: BLE001
            continue
        descriptor = _extract_descriptor(resp)
        if descriptor and _is_sandbox_descriptor(descriptor):
            route = {"program_id": m["program_id"] or ident,
                     "creature_id": m["creature_id"],
                     "entity_id": m["entity_id"] or SANDBOX_ENTITY}
            _SANDBOX_CACHE[space_id] = (route, now + _SANDBOX_TTL)
            return route
    # 3) Fallback: the global platform registry. One sandbox creature serves every
    #    space (the space is bound by the pinned `space_id`, not by a distinct
    #    per-space program), so the registry entry is enough to route to it even
    #    when this space's on-chain index was never populated — e.g. the space was
    #    created before the sandbox was registered, so `attachPlatformTools` never
    #    added it. Without this, such a space can never reach its sandbox.
    for entry in _read_platform_registry():
        pid = _pick(entry, ["programId", "program_id"])
        if not pid or pid == self_pid:
            continue
        if not _registry_entry_is_sandbox(entry):
            continue
        route = {
            "program_id": pid,
            "creature_id": _pick(entry, ["creatureId", "creature_id"]),
            "entity_id": _pick(entry, ["entityId", "entity_id"]) or SANDBOX_ENTITY,
        }
        _SANDBOX_CACHE[space_id] = (route, now + _SANDBOX_TTL)
        return route
    return None


def _invalidate_sandbox(space_id: str) -> None:
    _SANDBOX_CACHE.pop(space_id, None)


def _sandbox_route(space_id: str, payload: Dict[str, Any]) -> Tuple[str, str]:
    """The space sandbox creature's (program id, entity id) to signal.

    Discovered from the space over Caspar (:func:`_discover_sandbox`). An explicit
    ``sandbox_program_id`` in the payload is honoured only as an override/escape
    hatch (e.g. tests) — the normal path resolves it on-chain, so the backend is
    never in the creature↔creature routing path."""
    pid = (payload.get("sandbox_program_id") or payload.get("sandboxProgramId") or "")
    if isinstance(pid, str) and pid.strip():
        ent = (payload.get("sandbox_entity_id") or payload.get("sandboxEntityId") or SANDBOX_ENTITY)
        return pid.strip(), str(ent or SANDBOX_ENTITY)
    route = _discover_sandbox(space_id)
    if not route:
        raise GithubError(
            "could not find this space's sandbox — repository work runs on the space's cloud "
            "machine, which does not appear among the space's creatures yet", status=409)
    return route["program_id"], route["entity_id"]


def _sbx(space_id: str, payload: Dict[str, Any], function: str, args: Dict[str, Any],
         *, timeout: Optional[float] = None) -> Dict[str, Any]:
    """Signal the space's sandbox creature and return its action result.

    Re-discovers the sandbox once if the signal fails (e.g. it was re-minted), so
    a stale cached id self-heals instead of failing every call."""
    body = dict(args)
    body["space_id"] = space_id
    wait = (timeout or SANDBOX_TIMEOUT_S) + 30
    pid, ent = _sandbox_route(space_id, payload)
    try:
        reply = _bridge().invoke_tool(pid, ent, function, body, tool_id=SANDBOX_ENTITY, timeout=wait)
    except Exception:  # noqa: BLE001 — one retry against a freshly-discovered sandbox
        _invalidate_sandbox(space_id)
        if payload.get("sandbox_program_id"):
            raise
        route = _discover_sandbox(space_id)
        if not route:
            raise
        reply = _bridge().invoke_tool(route["program_id"], route["entity_id"], function, body,
                                      tool_id=SANDBOX_ENTITY, timeout=wait)
    # invoke_tool returns the tool runtime envelope {tool_id, function, result};
    # unwrap to the sandbox action's own result. Tolerate a bare result too.
    if isinstance(reply, dict):
        inner = reply.get("result")
        if isinstance(inner, dict):
            return inner
        return reply
    raise GithubError("the sandbox creature did not reply", status=504)


def _sbx_exec(space_id: str, payload: Dict[str, Any], command: str, *,
              env: Optional[Dict[str, str]] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
    """Run a shell line on the space's sandbox and return {exit_code, stdout, stderr}."""
    t = timeout or SANDBOX_TIMEOUT_S
    args: Dict[str, Any] = {"command": command, "timeout_ms": int(t * 1000)}
    if env:
        args["env"] = {str(k): str(v) for k, v in env.items()}
    res = _sbx(space_id, payload, "exec", args, timeout=t)
    if res.get("error") and res.get("exit_code") is None:
        raise GithubError(f"sandbox exec failed: {res.get('error')}", status=502)
    return res


def _git_env(token: str) -> Dict[str, str]:
    # The token rides in the environment (GH_XHDR), so it is never part of the
    # command string the sandbox logs or echoes.
    return {"GH_XHDR": _auth_header(token), "GH_BASE": WEB_BASE}


def _git() -> str:
    """The git invocation prefix: auth via the GH_XHDR env, no stored credentials,
    a fixed identity, and every clone dir trusted."""
    return ('git -c "http.${GH_BASE}/.extraheader=${GH_XHDR}" -c credential.helper= '
            '-c user.name="Decillion GitHub Tool" -c user.email=github-tool@decillion.local '
            '-c safe.directory=* ')


def _repo_path(full: str) -> str:
    """The clone directory for a repo on the sandbox (under REPO_ROOT)."""
    return REPO_ROOT + "/" + full.replace("/", "__")


def _rel(path: str) -> str:
    """A repo-relative path with traversal rejected."""
    p = str(path or "").strip().lstrip("/")
    parts = []
    for seg in p.replace("\\", "/").split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise GithubError("path escapes the repository", status=400)
        parts.append(seg)
    return "/".join(parts)


def _sh(s: str) -> str:
    """Single-quote a string for safe inclusion in the sandbox shell line."""
    return "'" + str(s).replace("'", "'\\''") + "'"


def _scrub(res: Dict[str, Any], token: str) -> None:
    hdr = _auth_header(token)
    for k in ("stdout", "stderr", "output"):
        if isinstance(res.get(k), str):
            res[k] = res[k].replace(hdr, "AUTHORIZATION: basic ***")


def _exec_result(res: Dict[str, Any], action: str, space_id: str, full: str) -> Dict[str, Any]:
    return {"ok": res.get("exit_code") == 0, "action": action, "space_id": space_id, "repo": full,
            "exit_code": res.get("exit_code"), "stdout": _clip(res.get("stdout") or ""),
            "stderr": _clip(res.get("stderr") or "")}


def _a_clone(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    rp = _repo_path(full)
    url = f"{WEB_BASE}/{full}.git"
    depth = f"--depth {int(payload['depth'])}" if payload.get("depth") else ""
    branch = f"--branch {_slug(payload['branch'])}" if payload.get("branch") else ""
    # Idempotent: fetch when already cloned, else clone. All under REPO_ROOT.
    cmd = (f"mkdir -p {_sh(REPO_ROOT)} && "
           f"if [ -d {_sh(rp + '/.git')} ]; then cd {_sh(rp)} && {_git()}fetch --all --prune; "
           f"else {_git()}clone {depth} {branch} {url} {_sh(rp)}; fi")
    res = _sbx_exec(space_id, payload, cmd, env=_git_env(token))
    _scrub(res, token)
    if res.get("exit_code") != 0:
        raise GithubError(f"git clone/fetch failed: {res.get('stderr') or res.get('stdout')}", status=502)
    return {"ok": True, "action": "clone", "space_id": space_id, "repo": full, "path": rp,
            "output": _clip(res.get("stderr") or res.get("stdout") or "")}


def _run_git(space_id: str, payload: Dict[str, Any], action: str, git_args: str,
             token: str, *, require_clone: bool = True) -> Dict[str, Any]:
    full = _full_name(payload)
    rp = _repo_path(full)
    guard = (f"if [ ! -d {_sh(rp + '/.git')} ]; then echo __NOCLONE__ 1>&2; exit 3; fi && "
             if require_clone else "")
    cmd = f"{guard}cd {_sh(rp)} && {_git()}{git_args}"
    res = _sbx_exec(space_id, payload, cmd, env=_git_env(token))
    _scrub(res, token)
    if require_clone and res.get("exit_code") == 3 and "__NOCLONE__" in (res.get("stderr") or ""):
        raise GithubError(f"{full} is not cloned into this space yet — clone it first", status=409)
    return _exec_result(res, action, space_id, full)


def _a_pull(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    branch = f" {_slug(payload['branch'])}" if payload.get("branch") else ""
    return _run_git(space_id, payload, "pull", f"pull origin{branch}", token)


def _a_fetch(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    return _run_git(space_id, payload, "fetch", "fetch --all --prune", token)


def _a_commit(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    message = str(payload.get("message") or "").strip()
    if not message:
        raise GithubError("commit needs a `message`")
    files = payload.get("files")
    if isinstance(files, list) and files:
        add = "add -- " + " ".join(_sh(str(f)) for f in files)
    else:
        add = "add -A"
    full = _full_name(payload)
    rp = _repo_path(full)
    # Stage then commit; the message rides in the environment to avoid quoting.
    cmd = (f"if [ ! -d {_sh(rp + '/.git')} ]; then echo __NOCLONE__ 1>&2; exit 3; fi && "
           f"cd {_sh(rp)} && {_git()}{add} && {_git()}commit -m \"$GH_MSG\"")
    env = _git_env(token); env["GH_MSG"] = message
    res = _sbx_exec(space_id, payload, cmd, env=env)
    _scrub(res, token)
    if res.get("exit_code") == 3 and "__NOCLONE__" in (res.get("stderr") or ""):
        raise GithubError(f"{full} is not cloned into this space yet — clone it first", status=409)
    return _exec_result(res, "commit", space_id, full)


def _a_push(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    if payload.get("branch"):
        ref = f"origin {_slug(payload['branch'])}"
    elif payload.get("set_upstream"):
        ref = "-u origin HEAD"
    else:
        ref = "origin HEAD"
    force = "--force-with-lease " if payload.get("force") else ""
    out = _run_git(space_id, payload, "push", f"push {force}{ref}", token)
    if not out["ok"]:
        raise GithubError(f"git push failed: {out.get('stderr') or out.get('stdout')}", status=502)
    return out


def _a_checkout(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    branch = str(payload.get("branch") or "").strip()
    if not branch:
        raise GithubError("checkout needs a `branch`")
    flag = "-b " if payload.get("create") else ""
    start = f" {_slug(payload['start_point'])}" if payload.get("start_point") else ""
    out = _run_git(space_id, payload, "checkout", f"checkout {flag}{_slug(branch)}{start}", token)
    if not out["ok"]:
        raise GithubError(f"git checkout failed: {out.get('stderr') or out.get('stdout')}", status=502)
    out["branch"] = branch
    return out


def _a_merge(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    branch = str(payload.get("branch") or payload.get("from") or "").strip()
    if not branch:
        raise GithubError("merge needs a `branch` to merge in")
    return _run_git(space_id, payload, "merge", f"merge {_slug(branch)}", token)


def _a_git_status(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    rp = _repo_path(full)
    cmd = (f"if [ ! -d {_sh(rp + '/.git')} ]; then echo __NOCLONE__ 1>&2; exit 3; fi && "
           f"cd {_sh(rp)} && {_git()}rev-parse --abbrev-ref HEAD && echo '---' && "
           f"{_git()}status --porcelain=v1")
    res = _sbx_exec(space_id, payload, cmd, env=_git_env(token))
    _scrub(res, token)
    if res.get("exit_code") == 3 and "__NOCLONE__" in (res.get("stderr") or ""):
        raise GithubError(f"{full} is not cloned into this space yet — clone it first", status=409)
    out = res.get("stdout") or ""
    branch, _, status = out.partition("\n---\n")
    body = [ln for ln in status.splitlines() if ln.strip()]
    return {"ok": res.get("exit_code") == 0, "action": "git_status", "space_id": space_id,
            "repo": full, "branch": branch.strip(), "status": status, "dirty": bool(body)}


def _a_git_log(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    n = int(payload.get("limit") or 20)
    out = _run_git(space_id, payload, "git_log",
                   f"log -{n} --pretty=format:%h%x09%an%x09%ad%x09%s --date=short", token)
    commits = []
    for line in (out.get("stdout") or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            commits.append({"sha": parts[0], "author": parts[1], "date": parts[2], "message": parts[3]})
    return {"ok": out["ok"], "action": "git_log", "space_id": space_id,
            "repo": _full_name(payload), "commits": commits}


def _a_list_cloned(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    res = _sbx(space_id, payload, "list_dir", {"path": REPO_ROOT})
    repos = []
    for e in (res.get("entries") or []):
        if isinstance(e, dict) and e.get("type") == "dir" and e.get("name"):
            repos.append({"repo": str(e["name"]).replace("__", "/"),
                          "path": REPO_ROOT + "/" + str(e["name"])})
    return {"ok": True, "action": "list_cloned", "space_id": space_id, "repos": repos, "count": len(repos)}


def _a_read_file(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    full = _full_name(payload)
    rel = _rel(payload.get("path") or "")
    if not rel:
        raise GithubError("read_file needs a `path`")
    res = _sbx(space_id, payload, "read", {"path": _repo_path(full) + "/" + rel})
    if res.get("ok") is False:
        raise GithubError(res.get("error") or f"could not read {rel}", status=res.get("status") or 404)
    return {"ok": True, "action": "read_file", "space_id": space_id, "repo": full, "path": rel,
            "content": res.get("content"), "encoding": res.get("encoding", "text"),
            "bytes": res.get("bytes")}


def _a_write_file(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    full = _full_name(payload)
    rel = _rel(payload.get("path") or "")
    if not rel:
        raise GithubError("write_file needs a `path`")
    args = {"path": _repo_path(full) + "/" + rel, "content": payload.get("content", ""),
            "encoding": payload.get("encoding", "text")}
    res = _sbx(space_id, payload, "write", args)
    if res.get("ok") is False:
        raise GithubError(res.get("error") or f"could not write {rel}", status=res.get("status") or 502)
    return {"ok": True, "action": "write_file", "space_id": space_id, "repo": full, "path": rel,
            "bytes": res.get("bytes")}


def _a_delete_file(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    token, _ = _require_use(space_id, payload)
    full = _full_name(payload)
    rel = _rel(payload.get("path") or "")
    if not rel:
        raise GithubError("delete_file needs a `path`")
    rp = _repo_path(full)
    res = _sbx_exec(space_id, payload, f"cd {_sh(rp)} && rm -rf {_sh(rel)}")
    return {"ok": res.get("exit_code") == 0, "action": "delete_file", "space_id": space_id,
            "repo": full, "path": rel, "stderr": _clip(res.get("stderr") or "")}


def _a_list_dir(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _require_use(space_id, payload)
    full = _full_name(payload)
    rel = _rel(payload.get("path") or ".")
    base = _repo_path(full)
    path = base + ("/" + rel if rel else "")
    res = _sbx(space_id, payload, "list_dir", {"path": path})
    if res.get("ok") is False:
        raise GithubError(res.get("error") or "could not list", status=res.get("status") or 404)
    entries = [e for e in (res.get("entries") or []) if isinstance(e, dict) and e.get("name") != ".git"]
    return {"ok": True, "action": "list_dir", "space_id": space_id, "repo": full, "path": rel or ".",
            "entries": entries, "count": len(entries)}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _clip(text: Optional[str], limit: int = MAX_OUTPUT_CHARS) -> str:
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated, {len(text) - limit} more chars]"


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

_ACTIONS = {
    # connection / oauth (web application flow)
    "oauth_start": _oauth_start, "connect": _oauth_start,
    "oauth_exchange": _oauth_exchange, "exchange": _oauth_exchange,
    "oauth_wait": _oauth_wait, "wait": _oauth_wait,
    "status": _status, "connection": _status,
    "disconnect": _disconnect, "logout": _disconnect,
    "set_shared": _set_shared, "settings": _set_shared,
    # github api (read)
    "orgs": _a_orgs, "repos": _a_repos, "list_repos": _a_repos, "repo": _a_repo,
    "branches": _a_branches, "commits": _a_commits,
    "pulls": _a_pulls, "list_pulls": _a_pulls, "get_pull": _a_get_pull, "pr": _a_get_pull,
    "issues": _a_issues,
    # github api (write)
    "create_pull": _a_create_pull, "open_pr": _a_create_pull,
    "merge_pull": _a_merge_pull, "merge_pr": _a_merge_pull,
    "update_pull": _a_update_pull, "create_issue": _a_create_issue,
    # git (local per-space workspace)
    "clone": _a_clone, "pull": _a_pull, "git_pull": _a_pull, "fetch": _a_fetch,
    "push": _a_push, "commit": _a_commit,
    "checkout": _a_checkout, "branch": _a_checkout, "merge": _a_merge,
    "git_status": _a_git_status, "status_repo": _a_git_status, "git_log": _a_git_log,
    "list_cloned": _a_list_cloned,
    "read_file": _a_read_file, "write_file": _a_write_file,
    "delete_file": _a_delete_file, "rm": _a_delete_file,
    "list_dir": _a_list_dir, "ls": _a_list_dir,
}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    return "status"


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action '{action}'", "actions": sorted(set(_ACTIONS))}
    try:
        space_id = _space_id(payload)
        return handler(space_id, payload)
    except GithubError as exc:
        return {"ok": False, "action": action, "error": str(exc), "status": exc.status or None}
    except Exception as exc:  # noqa: BLE001 — never crash the serving loop
        return {"ok": False, "action": action, "error": f"{type(exc).__name__}: {exc}"}
