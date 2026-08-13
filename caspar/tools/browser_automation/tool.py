"""browser_automation tool creature — a real headless browser for a Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API. Two kinds of caller reach
it, both over the same contract:

* the space's **agents**, through the agent backbone's bridge executor, so an
  agent can drive a real browser — open pages, click, type, run JS, screenshot —
  to do things a plain HTTP fetch cannot (JS-rendered sites, logins, forms);
* the tool's **front-end** (the Victor "Browser" mini-app), relayed by the client
  and signed as the human user — a mini browser a person can steer by hand.

It runs **Chromium via Playwright** inside the container (`requires_network`), so
the image is large. Nothing is stored off the container: browsing state lives in
in-memory browser contexts keyed by session.

## Sessions

Every call runs against a **session** — an isolated browser context (its own
cookies/storage) plus one page. The session key is the caller's ``space_id`` (so
a space's agents and people share one browser and one login) plus an optional
``session`` name for parallel tabs; with no ``space_id`` a shared ``default``
session is used. Sessions are created lazily on first use, capped
(``BROWSER_MAX_SESSIONS``) and evicted LRU, and idle sessions are reaped
(``BROWSER_SESSION_IDLE_S``).

## Thread-safety

Playwright's sync API is bound to the thread that created it, but the tool
runtime dispatches each signal on its own worker thread. So **all** browser work
runs on a single dedicated worker thread (:class:`_Playwright`), and every
``invoke`` submits its operation to that thread and blocks for the result. This
serialises browser access — correct and safe — without the caller knowing.

Credentials/tuning come from the container environment only.
"""

from __future__ import annotations

import base64
import os
import queue
import threading
import time
import traceback
from typing import Any, Callable, Dict, List, Optional, Tuple

NAV_TIMEOUT_MS = int(os.environ.get("BROWSER_NAV_TIMEOUT_MS", "45000"))
ACTION_TIMEOUT_MS = int(os.environ.get("BROWSER_ACTION_TIMEOUT_MS", "20000"))
MAX_TEXT_CHARS = int(os.environ.get("BROWSER_MAX_TEXT_CHARS", "40000"))
MAX_HTML_CHARS = int(os.environ.get("BROWSER_MAX_HTML_CHARS", "300000"))
# Screenshots ride back in the JSON reply as base64; the node caps a signal frame
# (~20 MB), so keep the raw image well under that.
MAX_SHOT_BYTES = int(os.environ.get("BROWSER_MAX_SHOT_BYTES", "4000000"))
MAX_SESSIONS = int(os.environ.get("BROWSER_MAX_SESSIONS", "8"))
SESSION_IDLE_S = float(os.environ.get("BROWSER_SESSION_IDLE_S", "900"))
DEFAULT_VIEWPORT = (
    int(os.environ.get("BROWSER_VIEWPORT_W", "1280")),
    int(os.environ.get("BROWSER_VIEWPORT_H", "800")),
)
USER_AGENT = os.environ.get("BROWSER_USER_AGENT", "").strip() or None
# Worker submit timeout — must exceed the longest single browser op (a slow nav).
WORKER_CALL_TIMEOUT_S = float(os.environ.get("BROWSER_WORKER_TIMEOUT_S", "120"))


class BrowserError(RuntimeError):
    def __init__(self, message: str, *, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- #
# The single Playwright worker thread
# --------------------------------------------------------------------------- #

class _Session:
    __slots__ = ("key", "context", "page", "created", "last")

    def __init__(self, key: str, context: Any, page: Any) -> None:
        self.key = key
        self.context = context
        self.page = page
        self.created = time.time()
        self.last = time.time()


class _Playwright:
    """Owns the Playwright driver + Chromium on one dedicated thread.

    Public API is thread-safe: :meth:`call` enqueues ``fn(worker)`` onto the
    worker thread and blocks for its result. Everything that touches Playwright
    objects must run inside such an ``fn``.
    """

    def __init__(self) -> None:
        self._q: "queue.Queue[Tuple[Callable[[_Playwright], Any], Dict[str, Any]]]" = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="browser-worker", daemon=True)
        self._started = threading.Event()
        self._start_error: Optional[str] = None
        self._pw = None
        self._browser = None
        self._sessions: "Dict[str, _Session]" = {}
        self._thread.start()

    # -- lifecycle (worker thread) -----------------------------------------
    def _run(self) -> None:
        try:
            from playwright.sync_api import sync_playwright  # type: ignore
            self._pw = sync_playwright().start()
        except Exception as exc:  # noqa: BLE001
            self._start_error = f"failed to start Playwright: {exc}"
            self._started.set()
            return
        self._started.set()
        while True:
            fn, box = self._q.get()
            if fn is None:  # shutdown sentinel
                break
            try:
                box["result"] = fn(self)
            except Exception as exc:  # noqa: BLE001 — surfaced to the caller
                box["error"] = exc
                box["trace"] = traceback.format_exc()
            finally:
                box["done"].set()

    def _ensure_browser(self) -> Any:
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        if self._pw is None:
            raise BrowserError(self._start_error or "Playwright is not available", status=503)
        self._browser = self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                  "--disable-setuid-sandbox", "--no-zygote"],
        )
        return self._browser

    def _reap_idle(self) -> None:
        now = time.time()
        for key, sess in list(self._sessions.items()):
            if now - sess.last > SESSION_IDLE_S:
                self._drop(key)

    def _drop(self, key: str) -> None:
        sess = self._sessions.pop(key, None)
        if sess is not None:
            try:
                sess.context.close()
            except Exception:  # noqa: BLE001
                pass

    def _session(self, key: str, *, create: bool = True) -> _Session:
        self._reap_idle()
        sess = self._sessions.get(key)
        if sess is not None:
            sess.last = time.time()
            return sess
        if not create:
            raise BrowserError(f"no open browser session '{key}'", status=404)
        if len(self._sessions) >= MAX_SESSIONS:
            # Evict the least-recently-used session to stay under the cap.
            oldest = min(self._sessions.values(), key=lambda s: s.last)
            self._drop(oldest.key)
        browser = self._ensure_browser()
        ctx_kwargs: Dict[str, Any] = {"viewport": {"width": DEFAULT_VIEWPORT[0], "height": DEFAULT_VIEWPORT[1]}}
        if USER_AGENT:
            ctx_kwargs["user_agent"] = USER_AGENT
        context = browser.new_context(**ctx_kwargs)
        context.set_default_timeout(ACTION_TIMEOUT_MS)
        context.set_default_navigation_timeout(NAV_TIMEOUT_MS)
        page = context.new_page()
        sess = _Session(key, context, page)
        self._sessions[key] = sess
        return sess

    # -- submit (any thread) ----------------------------------------------
    def call(self, fn: "Callable[[_Playwright], Any]", *, timeout: Optional[float] = None) -> Any:
        if not self._started.wait(30):
            raise BrowserError("Playwright worker did not start in time", status=503)
        if self._start_error:
            raise BrowserError(self._start_error, status=503)
        box: Dict[str, Any] = {"done": threading.Event()}
        self._q.put((fn, box))
        if not box["done"].wait(timeout or WORKER_CALL_TIMEOUT_S):
            raise BrowserError("browser operation timed out", status=504)
        if "error" in box:
            err = box["error"]
            if isinstance(err, BrowserError):
                raise err
            raise BrowserError(str(err), status=502)
        return box.get("result")


_WORKER: Optional[_Playwright] = None
_WORKER_LOCK = threading.Lock()


def _worker() -> _Playwright:
    global _WORKER
    with _WORKER_LOCK:
        if _WORKER is None:
            _WORKER = _Playwright()
        return _WORKER


# --------------------------------------------------------------------------- #
# Helpers (run on the worker thread, inside a `call`)
# --------------------------------------------------------------------------- #

def _clip(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "\n… [truncated]"


def _session_key(payload: Dict[str, Any]) -> str:
    space = ""
    for k in ("space_id", "spaceId", "store_id", "storeId"):
        v = payload.get(k)
        if isinstance(v, str) and v.strip():
            space = v.strip()
            break
    name = str(payload.get("session") or payload.get("session_id") or "main").strip() or "main"
    return f"{space or 'default'}::{name}"


def _page_state(page: Any) -> Dict[str, Any]:
    try:
        return {"url": page.url, "title": page.title()}
    except Exception:  # noqa: BLE001
        return {"url": getattr(page, "url", ""), "title": ""}


def _wait_until(payload: Dict[str, Any]) -> str:
    wu = str(payload.get("wait_until") or payload.get("waitUntil") or "load").strip()
    return wu if wu in ("load", "domcontentloaded", "networkidle", "commit") else "load"


# --------------------------------------------------------------------------- #
# Actions — each is a `fn(worker)` submitted to the worker thread
# --------------------------------------------------------------------------- #

def _do_navigate(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = str(payload.get("url") or payload.get("link") or "").strip()
    if not url:
        raise BrowserError("a `url` is required to navigate")
    if not url.startswith(("http://", "https://", "about:", "file://", "data:")):
        url = "https://" + url
    key = _session_key(payload)
    timeout = int(payload.get("timeout_ms") or NAV_TIMEOUT_MS)

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key)
        resp = sess.page.goto(url, wait_until=_wait_until(payload), timeout=timeout)
        state = _page_state(sess.page)
        return {"ok": True, "action": "navigate", "session": key, "status": resp.status if resp else None,
                **state}

    return _worker().call(fn, timeout=timeout / 1000.0 + 30)


def _do_content(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        html = sess.page.content()
        return {"ok": True, "action": "content", "session": key, **_page_state(sess.page),
                "html": _clip(html, MAX_HTML_CHARS), "html_chars": min(len(html), MAX_HTML_CHARS)}

    return _worker().call(fn)


def _do_text(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    selector = str(payload.get("selector") or "body").strip() or "body"

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        try:
            text = sess.page.inner_text(selector, timeout=ACTION_TIMEOUT_MS)
        except Exception:  # noqa: BLE001 — selector missing → whole-body text
            text = sess.page.inner_text("body", timeout=ACTION_TIMEOUT_MS)
        return {"ok": True, "action": "text", "session": key, **_page_state(sess.page),
                "text": _clip(text, MAX_TEXT_CHARS), "text_chars": min(len(text), MAX_TEXT_CHARS)}

    return _worker().call(fn)


def _do_screenshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    full_page = bool(payload.get("full_page") or payload.get("fullPage"))
    fmt = str(payload.get("format") or "jpeg").lower()
    fmt = "png" if fmt == "png" else "jpeg"
    quality = int(payload.get("quality") or 70)

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        opts: Dict[str, Any] = {"full_page": full_page, "type": fmt}
        if fmt == "jpeg":
            opts["quality"] = max(10, min(quality, 100))
        selector = payload.get("selector")
        if isinstance(selector, str) and selector.strip():
            data = sess.page.locator(selector.strip()).screenshot(type=fmt,
                                                                   **({"quality": opts["quality"]} if fmt == "jpeg" else {}))
        else:
            data = sess.page.screenshot(**opts)
        truncated = len(data) > MAX_SHOT_BYTES
        if truncated and fmt == "jpeg" and not full_page:
            # Retry at lower quality to fit the frame budget before giving up.
            data = sess.page.screenshot(type="jpeg", quality=35, full_page=False)
            truncated = len(data) > MAX_SHOT_BYTES
        if truncated:
            raise BrowserError(
                f"screenshot is {len(data)} bytes, over the {MAX_SHOT_BYTES}-byte cap; "
                "try format=jpeg, a lower quality, a selector, or full_page=false", status=413)
        return {"ok": True, "action": "screenshot", "session": key, **_page_state(sess.page),
                "format": fmt, "bytes": len(data), "encoding": "base64",
                "image": base64.b64encode(data).decode("ascii")}

    return _worker().call(fn)


def _do_click(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    selector = str(payload.get("selector") or payload.get("target") or "").strip()
    if not selector:
        raise BrowserError("a `selector` is required to click")

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        sess.page.click(selector, timeout=int(payload.get("timeout_ms") or ACTION_TIMEOUT_MS))
        return {"ok": True, "action": "click", "session": key, "selector": selector, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_fill(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    selector = str(payload.get("selector") or "").strip()
    text = payload.get("text")
    if text is None:
        text = payload.get("value")
    if not selector or text is None:
        raise BrowserError("`selector` and `text` are required to fill")

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        if payload.get("type_delay"):
            sess.page.type(selector, str(text), delay=int(payload["type_delay"]),
                           timeout=int(payload.get("timeout_ms") or ACTION_TIMEOUT_MS))
        else:
            sess.page.fill(selector, str(text), timeout=int(payload.get("timeout_ms") or ACTION_TIMEOUT_MS))
        if payload.get("enter") or payload.get("submit"):
            sess.page.press(selector, "Enter")
        return {"ok": True, "action": "fill", "session": key, "selector": selector, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_press(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    keyname = str(payload.get("key") or payload.get("press") or "").strip()
    if not keyname:
        raise BrowserError("a `key` is required to press (e.g. \"Enter\", \"Control+A\")")
    selector = str(payload.get("selector") or "").strip()

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        if selector:
            sess.page.press(selector, keyname)
        else:
            sess.page.keyboard.press(keyname)
        return {"ok": True, "action": "press", "session": key, "key": keyname, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_evaluate(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    script = str(payload.get("script") or payload.get("expression") or payload.get("code") or "").strip()
    if not script:
        raise BrowserError("a `script` (JS expression) is required to evaluate")

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        result = sess.page.evaluate(script)
        # Cap large results so a runaway expression cannot blow the reply frame.
        text = result
        if isinstance(result, str):
            text = _clip(result, MAX_TEXT_CHARS)
        return {"ok": True, "action": "evaluate", "session": key, "result": text, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_links(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    limit = max(1, min(int(payload.get("limit") or 100), 500))

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        rows = sess.page.evaluate(
            """(limit) => Array.from(document.querySelectorAll('a[href]')).slice(0, limit).map(a => ({
                   text: (a.innerText || a.textContent || '').trim().slice(0, 160), url: a.href }))
                 .filter(r => r.url && r.url.startsWith('http'))""",
            limit,
        )
        return {"ok": True, "action": "links", "session": key, **_page_state(sess.page),
                "links": rows or [], "count": len(rows or [])}

    return _worker().call(fn)


def _do_wait_for(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    selector = str(payload.get("selector") or "").strip()
    ms = payload.get("timeout_ms")

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        if selector:
            state = str(payload.get("state") or "visible")
            sess.page.wait_for_selector(selector, state=state if state in
                                        ("attached", "detached", "visible", "hidden") else "visible",
                                        timeout=int(ms or ACTION_TIMEOUT_MS))
        elif payload.get("wait_until") or payload.get("load_state"):
            sess.page.wait_for_load_state(_wait_until(payload), timeout=int(ms or NAV_TIMEOUT_MS))
        else:
            sess.page.wait_for_timeout(int(ms or 1000))
        return {"ok": True, "action": "wait_for", "session": key, "selector": selector or None,
                **_page_state(sess.page)}

    return _worker().call(fn, timeout=(int(ms or ACTION_TIMEOUT_MS)) / 1000.0 + 30)


def _do_scroll(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    dy = int(payload.get("dy") or payload.get("delta_y") or (0 if payload.get("to") else 800))
    to = str(payload.get("to") or "").lower()

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        if to == "bottom":
            sess.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        elif to == "top":
            sess.page.evaluate("window.scrollTo(0, 0)")
        else:
            sess.page.mouse.wheel(0, dy)
        return {"ok": True, "action": "scroll", "session": key, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_history(action: str) -> Callable[[Dict[str, Any]], Dict[str, Any]]:
    def handler(payload: Dict[str, Any]) -> Dict[str, Any]:
        key = _session_key(payload)

        def fn(w: _Playwright) -> Dict[str, Any]:
            sess = w._session(key, create=False)
            if action == "back":
                sess.page.go_back(wait_until=_wait_until(payload))
            elif action == "forward":
                sess.page.go_forward(wait_until=_wait_until(payload))
            else:
                sess.page.reload(wait_until=_wait_until(payload))
            return {"ok": True, "action": action, "session": key, **_page_state(sess.page)}

        return _worker().call(fn, timeout=NAV_TIMEOUT_MS / 1000.0 + 30)

    return handler


def _do_pdf(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        data = sess.page.pdf(format=str(payload.get("paper") or "A4"),
                             print_background=bool(payload.get("background", True)))
        if len(data) > MAX_SHOT_BYTES:
            raise BrowserError(f"pdf is {len(data)} bytes, over the {MAX_SHOT_BYTES}-byte cap", status=413)
        return {"ok": True, "action": "pdf", "session": key, **_page_state(sess.page),
                "bytes": len(data), "encoding": "base64", "pdf": base64.b64encode(data).decode("ascii")}

    return _worker().call(fn)


def _do_set_viewport(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)
    w_ = int(payload.get("width") or DEFAULT_VIEWPORT[0])
    h_ = int(payload.get("height") or DEFAULT_VIEWPORT[1])

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key)
        sess.page.set_viewport_size({"width": max(200, w_), "height": max(200, h_)})
        return {"ok": True, "action": "set_viewport", "session": key, "width": w_, "height": h_,
                **_page_state(sess.page)}

    return _worker().call(fn)


def _do_current(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)

    def fn(w: _Playwright) -> Dict[str, Any]:
        sess = w._session(key, create=False)
        return {"ok": True, "action": "current", "session": key, **_page_state(sess.page)}

    return _worker().call(fn)


def _do_close(payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _session_key(payload)

    def fn(w: _Playwright) -> Dict[str, Any]:
        existed = key in w._sessions
        w._drop(key)
        return {"ok": True, "action": "close", "session": key, "closed": existed}

    return _worker().call(fn)


def _do_sessions(payload: Dict[str, Any]) -> Dict[str, Any]:
    def fn(w: _Playwright) -> Dict[str, Any]:
        w._reap_idle()
        rows = []
        for sess in w._sessions.values():
            rows.append({"session": sess.key, **_page_state(sess.page),
                         "age_s": int(time.time() - sess.created),
                         "idle_s": int(time.time() - sess.last)})
        return {"ok": True, "action": "sessions", "sessions": rows, "count": len(rows),
                "max_sessions": MAX_SESSIONS}

    return _worker().call(fn)


_ACTIONS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "navigate": _do_navigate,
    "goto": _do_navigate,
    "open": _do_navigate,
    "content": _do_content,
    "html": _do_content,
    "get_html": _do_content,
    "text": _do_text,
    "get_text": _do_text,
    "extract_text": _do_text,
    "screenshot": _do_screenshot,
    "capture": _do_screenshot,
    "click": _do_click,
    "fill": _do_fill,
    "type": _do_fill,
    "press": _do_press,
    "evaluate": _do_evaluate,
    "eval": _do_evaluate,
    "links": _do_links,
    "wait_for": _do_wait_for,
    "wait": _do_wait_for,
    "scroll": _do_scroll,
    "back": _do_history("back"),
    "forward": _do_history("forward"),
    "reload": _do_history("reload"),
    "refresh": _do_history("reload"),
    "pdf": _do_pdf,
    "set_viewport": _do_set_viewport,
    "viewport": _do_set_viewport,
    "current": _do_current,
    "status": _do_current,
    "close": _do_close,
    "close_session": _do_close,
    "sessions": _do_sessions,
    "list_sessions": _do_sessions,
}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    return "navigate" if (payload.get("url") or payload.get("link")) else "current"


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action '{action}'", "actions": sorted(set(_ACTIONS))}
    try:
        return handler(payload)
    except BrowserError as exc:
        return {"ok": False, "action": action, "error": str(exc), "status": exc.status or None}
    except Exception as exc:  # noqa: BLE001 — never crash the serving creature
        return {"ok": False, "action": action, "error": f"{type(exc).__name__}: {exc}"}
