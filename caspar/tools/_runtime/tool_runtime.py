"""Generic Davinci tool-creature runtime.

Every Davinci tool is deployed as its own Caspar ``docker`` creature. When the
node signals it (via ``/programs/runEntity``), the node uploads the signal to
``/app/input/task.json`` and captures this process's stdout as VM logs.

Contract:
    input  : /app/input/task.json = {"tool_id","function","payload"}
    output : a single line  ``TOOL_RESPONSE <json>``  on stdout

Dispatch order:
    1. The tool's own deployed ``tool.py`` ``invoke`` (the real implementation,
       shipped alongside this runtime with its own dependencies installed in the
       tool image). This is what runs in production.
    2. A small built-in fallback for a few well-known tools, so the runtime is
       still useful when no ``tool.py`` is present (e.g. unit tests).
    3. An echo, so an unknown tool never hard-fails.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback

INPUT_DIR = os.environ.get("DAVINCI_INPUT_DIR", "/app/input")
TOOL_ID = os.environ.get("TOOL_ID", "")


# --------------------------------------------------------------------------- #
# Docker-host bridge gateway
#
# When this tool runs as a gateway-managed docker creature the node injects
# CASPAR_GATEWAY_* env vars and the bridge client is shipped alongside this
# runtime (as ``caspar_bridge.py``). The bridge is the tool's only route to the
# outside world: tool implementations reach the node's HTTP/DB host functions
# through ``get_bridge()`` and the result is signalled back over the same
# connection. Everything here is env-guarded so the runtime stays usable (and
# unit-testable) with no gateway present.
# --------------------------------------------------------------------------- #
try:  # shipped into the tool image as a top-level module by the deploy harness
    import caspar_bridge as _bridge_mod  # type: ignore
except Exception:  # pragma: no cover - fallback for in-repo execution / tests
    try:
        from davinci import caspar_bridge as _bridge_mod  # type: ignore
    except Exception:
        _bridge_mod = None  # type: ignore

_BRIDGE = None  # type: ignore


def get_bridge():
    """Return the connected bridge client, or ``None`` when not gateway-managed."""
    return _BRIDGE


def _connect_bridge():
    global _BRIDGE
    if _BRIDGE is not None or _bridge_mod is None:
        return _BRIDGE
    # When no gateway is configured (CASPAR_GATEWAY_HOST unset — local/unit
    # tests) ``bridge_from_env`` returns None *without* connecting, so we fall
    # straight through to offline mode below. When a gateway IS configured we
    # retry a few times: the node binds the container's source IP to its identity
    # (``register_vm_container``) right after starting the container, so a
    # creature that connects in the first moments can momentarily lose the HELLO
    # identity race ("could not identify a docker creature for source ip ...").
    # A handful of short retries closes that window so a serving tool reliably
    # reaches TOOL_SERVE_READY instead of silently dropping to one-shot mode.
    # Heavy images (browser_automation's multi-GB Playwright image) boot far
    # slower under gVisor, so they have more startup variance and may need a
    # wider retry window before the node↔container identity settles — hence the
    # env-tunable attempt count and the per-attempt logging below, which makes a
    # persistent identity failure (vs. a transient one that later succeeds)
    # diagnosable straight from the VM logs.
    attempts = int(os.environ.get("TOOL_BRIDGE_CONNECT_ATTEMPTS", "8"))
    last_exc = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            _BRIDGE = _bridge_mod.bridge_from_env()
            return _BRIDGE
        except Exception as exc:  # noqa: BLE001 — never block the tool on bridge setup
            last_exc = exc
            print("TOOL_BRIDGE " + json.dumps(
                {"connect_attempt": attempt, "of": attempts, "error": repr(exc)[:200]}),
                flush=True)
            if attempt < attempts:
                time.sleep(min(3.0, 0.5 * attempt))
    print(f"TOOL_BRIDGE {json.dumps({'connect_error': repr(last_exc)[:200], 'attempts': attempts, 'gave_up': True})}",
          flush=True)
    _BRIDGE = None
    return _BRIDGE


def _reply_over_bridge(signal: dict, response: dict) -> None:
    """If the request carried reply metadata, push the result back over the
    gateway so the caller is notified through the connection (not just logs)."""
    bridge = _BRIDGE
    if bridge is None:
        return
    payload = signal.get("payload") or {}
    reply_to = signal.get("reply_to") or payload.get("reply_to") or signal.get("userId")
    correlation_id = signal.get("correlationId") or payload.get("correlationId")
    if not reply_to:
        return
    # Reply on the "creatures/signal" key so it passes the caller's machine
    # listener and is pushed onto the caller's gateway connection; the structured
    # packet lets the caller match it to the originating request.
    try:
        bridge.signal_user(
            "creatures/signal",
            str(reply_to),
            {"kind": "tools/result", "correlationId": correlation_id, "result": response},
        )
    except Exception as exc:  # noqa: BLE001
        print(f"TOOL_BRIDGE {json.dumps({'reply_error': repr(exc)[:160]})}", flush=True)


def _read_signal() -> dict:
    path = os.path.join(INPUT_DIR, "task.json")
    if os.path.isfile(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {"tool_id": TOOL_ID, "function": "invoke", "payload": {}}


# --------------------------------------------------------------------------- #
# Built-in fallback handlers (used only when no real tool.py is deployed)
# --------------------------------------------------------------------------- #

def _h_python_exec(payload: dict) -> dict:
    code = str(payload.get("code") or "result = 6 * 7")
    scope: dict = {}
    try:
        exec(code, {"__builtins__": __builtins__}, scope)  # noqa: S102 - sandboxed by gVisor
        return {"ok": True, "result": scope.get("result"), "vars": list(scope.keys())}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _h_http(payload: dict) -> dict:
    url = payload.get("url") or "https://example.com"
    out: dict = {}

    def _fetch():
        try:
            import urllib.request
            with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310
                body = resp.read(2048).decode("utf-8", "replace")
            out.update({"ok": True, "url": url, "status": resp.status,
                        "bytes": len(body), "preview": body[:200]})
        except Exception as exc:
            out.update({"ok": False, "url": url, "error": str(exc)})

    import threading
    t = threading.Thread(target=_fetch, daemon=True)
    t.start()
    t.join(7)
    if not out:
        return {"ok": False, "url": url, "error": "network unavailable (sandbox); request timed out",
                "query": payload.get("query") or payload.get("task")}
    return out


def _h_vector_search(payload: dict) -> dict:
    query = str(payload.get("query") or payload.get("task") or "")
    corpus = payload.get("corpus") or [
        "Davinci is an orchestration-first enterprise agent.",
        "Caspar runs creatures across six VM runtimes.",
        "Tool creatures respond to signals over the action protocol.",
    ]
    q = set(query.lower().split())
    ranked = sorted(corpus, key=lambda d: -len(q & set(d.lower().split())))
    return {"ok": True, "query": query, "top": ranked[:2]}


def _h_echo(tool_id: str, payload: dict) -> dict:
    return {"ok": True, "tool_id": tool_id, "echo": payload}


_BUILTINS = {
    "python_exec": _h_python_exec,
    "web_search": _h_http,
    "fetch_url": _h_http,
    "vector_search": _h_vector_search,
}


def _load_tool_module():
    """Import the deployed ``tool.py`` (the real per-tool implementation)."""
    try:
        import tool  # type: ignore
        return tool
    except Exception:
        return None


def _call_invoke(impl, function: str, payload: dict) -> dict:
    """Call a tool's invoke() supporting both (function, payload) and (payload)."""
    try:
        return impl.invoke(function, payload)  # type: ignore[misc]
    except TypeError:
        return impl.invoke(payload)  # type: ignore[misc]


def _dispatch(tool_id: str, function: str, payload: dict) -> dict:
    # 1. Prefer the tool's real implementation when it ships with the image.
    impl = _load_tool_module()
    if impl is not None and hasattr(impl, "invoke"):
        # Hand the tool the live gateway bridge when it wants one (opt-in via a
        # `set_bridge` hook), so a tool can persist through the node's key/value
        # store or signal siblings. Tools that don't declare it are unaffected.
        if hasattr(impl, "set_bridge"):
            try:
                impl.set_bridge(_BRIDGE)
            except Exception:  # noqa: BLE001 — never block dispatch on bridge wiring
                pass
        try:
            return _call_invoke(impl, function, payload)
        except Exception:
            return {"ok": False, "error": traceback.format_exc().splitlines()[-1]}

    # 2. Built-in fallback for well-known tools.
    handler = _BUILTINS.get(tool_id)
    if handler:
        try:
            return handler(payload)  # type: ignore[arg-type]
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # 3. Echo so unknown tools never hard-fail.
    return _h_echo(tool_id, payload)


def _extract_invoke(data: dict) -> dict:
    """Normalise the SIGNAL payload into an ``invoke`` packet.

    Two delivery shapes reach a serving tool, both over the signaling API:

    * **creature → creature** — a sibling creature (e.g. Davinci) calls
      ``signalUser`` with the invoke packet as the signal value, so ``data`` *is*
      the packet (``data["kind"] == "invoke"``).
    * **external client → creature** — a ``/creatures/signal`` (pvp) is wrapped by
      the node as ``StoresSend{action, user, data:"<json>", entityId}``; the real
      packet is the JSON string in ``data["data"]``.

    The external shape carries **one more layer**: a client (the Decillion
    backend) sends ``{programId, entity, payload:"<json>"}`` and the invoke
    packet — plus the correlation id the caller is waiting on — is that inner
    JSON string. This is the same double peel the wasm creatures do in
    ``unwrapSignal``, and without it the tool would be handed a *string* where
    it expects its arguments.
    """
    if not isinstance(data, dict):
        return {}
    packet = data
    if not (data.get("kind") == "invoke" or "tool_id" in data or "function" in data):
        inner = data.get("data")
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except Exception:  # noqa: BLE001
                return {}
        packet = inner if isinstance(inner, dict) else {}
    nested = packet.get("payload")
    if isinstance(nested, str):
        try:
            nested = json.loads(nested)
        except Exception:  # noqa: BLE001
            nested = None
        if isinstance(nested, dict):
            outer = {k: v for k, v in packet.items() if k != "payload"}
            packet = {**outer, **nested}
    return packet


# Keys a tool implementation commonly reads its primary free-text argument from.
# A chat command (``@tool command the rest is free text``) carries that free text
# as a single blob; the client sends it under `args`/`chat_text`, and we mirror it
# onto every alias below so any tool — whichever key it happens to read — picks it
# up. This is what lets an existing tool answer a chat command with no per-tool
# change: web_search reads `query`/`text`/`task`, github/sandbox read `text`/`input`.
_CHAT_TEXT_ALIASES = ("text", "query", "prompt", "task", "input", "message", "q")


_SYSTEM_OR_ROUTING_FUNCTIONS = {
    "invoke", "info", "status", "list", "list_dir", "read", "stop", "delete",
    "create", "provision", "start", "resume", "open", "logs", "help",
}


def _normalize_chat_args(function: str, payload: dict) -> None:
    """Spread a chat command's free-text argument across the alias keys tools read.

    Mutates ``payload`` in place. Only fills an alias that is missing/empty, so an
    explicit structured argument from an agent or a front-end is never clobbered.
    The originating command name (``function``) is also recorded under ``command``
    so a tool that wants to branch on it can."""
    if not isinstance(payload, dict):
        return
    fn_lower = str(function or "").strip().lower()
    if fn_lower and not payload.get("command") and fn_lower not in _SYSTEM_OR_ROUTING_FUNCTIONS:
        payload["command"] = function
    text = ""
    for src in ("args", "chat_text", "command_text", "text", "query", "prompt"):
        v = payload.get(src)
        if isinstance(v, str) and v.strip():
            text = v.strip()
            break
    if not text:
        return
    for alias in _CHAT_TEXT_ALIASES:
        cur = payload.get(alias)
        if not (isinstance(cur, str) and cur.strip()):
            payload[alias] = text


def _handle_invoke(bridge, packet: dict) -> None:
    """Run one tool invocation and signal the result back to the caller.

    Runs on a worker thread — never on the bridge reader thread — because the
    reply is a host call whose response is read by that same reader thread; doing
    it inline would deadlock.
    """
    tool_id = packet.get("tool_id") or TOOL_ID or "unknown"
    function = packet.get("function", "invoke")
    payload = packet.get("payload") or {}
    # Stamp the TRUSTED caller identity onto the payload from the signal envelope.
    # A caller's own arguments live under `payload`, so a guest could otherwise
    # forge an identity by adding e.g. `caller_id` to its args; we therefore strip
    # every caller-identity key the guest might have set and re-stamp `__caller_id`
    # from the envelope, which only the invoking creature sets and a guest cannot
    # influence. A tool that gates on the caller (github's per-member connection,
    # zapier's per-member Zapier account) reads `__caller_id`.
    if isinstance(payload, dict):
        for _k in ("__caller_id", "reply_to", "replyTo", "caller_id", "callerId", "user_id", "userId"):
            payload.pop(_k, None)
        # `caller_id` is the HUMAN an invoker is acting for, set only by the
        # trusted meter on the direct-tool path (from the billing quote's payer);
        # `reply_to` is the invoking *creature*, which is what the reply routes
        # back to. Prefer the person when one is named, so a tool that gates on
        # "the member who connected this" sees them rather than the meter — and
        # an agent's own tool call, which names no person, still resolves to the
        # backbone, i.e. not the owner.
        _caller = packet.get("caller_id") or packet.get("reply_to") or packet.get("userId")
        if isinstance(_caller, str) and _caller.strip():
            payload["__caller_id"] = _caller.strip()
        # A chat command delivers its argument as one free-text blob; spread it
        # across the alias keys tools read so any tool can answer a chat command.
        _normalize_chat_args(function, payload)
    print(f"TOOL_BOOT {json.dumps({'tool_id': tool_id, 'function': function, 'ts': time.time()})}", flush=True)
    try:
        result = _dispatch(tool_id, function, payload)
    except Exception:
        result = {"ok": False, "error": traceback.format_exc().splitlines()[-1]}
    response = {"tool_id": tool_id, "function": function, "result": result}
    print("TOOL_RESPONSE " + json.dumps(response, default=str), flush=True)
    reply_to = packet.get("reply_to") or payload.get("reply_to")
    correlation_id = packet.get("correlationId") or payload.get("correlationId")
    if bridge is not None and reply_to:
        try:
            bridge.signal_user(
                "creatures/signal", str(reply_to),
                {"kind": "tools/result", "correlationId": correlation_id, "result": response})
        except Exception as exc:  # noqa: BLE001
            print(f"TOOL_BRIDGE {json.dumps({'reply_error': repr(exc)[:160]})}", flush=True)


def _serve(bridge) -> str:
    """Serve one gateway session for a long-lived standalone creature.

    The tool VM is started once (via ``runEntity``) and then stays alive,
    receiving work purely as pushed signals over the docker-host gateway and
    replying over the same channel. It never reads a task file and is never
    cold-spawned per call — Davinci and other creatures reach it through the
    Caspar signaling API.

    Returns ``"reconnect"`` when the gateway link dropped (the caller should dial
    a fresh connection and serve again) or ``"exit"`` when the tool intentionally
    idled out.

    **Idle-exit is opt-in.** A serving creature that exits on mere inactivity is
    unreachable until something reboots it — which is exactly the "the sandbox
    went to sleep after a few idle minutes and never woke up" failure: the node
    has to notice the next signal is cold and resurrect the container, and any gap
    in that path leaves the caller hanging forever. So by default the creature
    stays warm and simply keeps serving. Set ``TOOL_SERVE_IDLE`` to a positive
    number of seconds only for a rarely-used tool whose container you want freed
    between bursts (the node cold-spawns it back on the next signal).
    """
    import threading

    tool_id = TOOL_ID or "unknown"
    state = {"last": time.time(), "served": 0}
    idle_timeout = float(os.environ.get("TOOL_SERVE_IDLE", "0") or "0")

    def on_signal(key: str, data) -> None:
        if key != "creatures/signal":
            return
        packet = _extract_invoke(data if isinstance(data, dict) else {})
        # Ignore our own result echoes and anything that isn't an invocation.
        if not packet or packet.get("kind") == "tools/result":
            return
        if not (packet.get("tool_id") or packet.get("function") or packet.get("payload")):
            return
        state["last"] = time.time()
        state["served"] += 1
        threading.Thread(target=_handle_invoke, args=(bridge, packet), daemon=True).start()

    bridge.on_signal(on_signal)
    print("TOOL_SERVE_READY " + json.dumps(
        {"tool_id": tool_id, "machine_id": getattr(bridge, "machine_id", ""),
         "program_id": getattr(bridge, "program_id", ""), "ts": time.time()}), flush=True)

    # Stay alive serving signals. Watch the gateway link: if it drops (node
    # restart, transient blip) reconnect rather than sleeping on unreachable.
    is_connected = getattr(bridge, "is_connected", None)
    while True:
        if callable(is_connected) and not is_connected():
            print("TOOL_SERVE_RECONNECT " + json.dumps(
                {"tool_id": tool_id, "served": state["served"], "ts": time.time()}), flush=True)
            return "reconnect"
        if idle_timeout > 0 and time.time() - state["last"] >= idle_timeout:
            print("TOOL_SERVE_EXIT " + json.dumps({"tool_id": tool_id, "served": state["served"]}), flush=True)
            return "exit"
        time.sleep(2)


def _run_once_offline() -> int:
    """One-shot fallback for offline/local execution with no gateway (unit tests):
    read a task file if present, dispatch once, print the response."""
    signal = _read_signal()
    tool_id = signal.get("tool_id") or TOOL_ID or "unknown"
    function = signal.get("function", "invoke")
    payload = signal.get("payload") or {}
    _normalize_chat_args(function, payload)
    print(f"TOOL_BOOT {json.dumps({'tool_id': tool_id, 'function': function, 'ts': time.time()})}", flush=True)
    try:
        result = _dispatch(tool_id, function, payload)
    except Exception:
        result = {"ok": False, "error": traceback.format_exc().splitlines()[-1]}
    response = {"tool_id": tool_id, "function": function, "result": result}
    print("TOOL_RESPONSE " + json.dumps(response, default=str), flush=True)
    return 0


def _run_http_server(handler, port: int) -> None:
    """Serve `handler` over plain HTTP on `0.0.0.0:port` in a daemon thread. The
    node's VM HTTP ingress proxies inbound requests
    (`{node}/{creatureId}/{programId}/{entityId}/{vmId}/{path}`) to this port, so a
    tool can answer a browser redirect (e.g. an OAuth callback) itself. `handler`
    is `(method, path, query{str:str}, headers{str:str}, body: bytes) ->
    (status:int, content_type:str, body: str|bytes)`."""
    import threading
    import urllib.parse
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class _Handler(BaseHTTPRequestHandler):
        def _serve(self, method: str) -> None:
            parsed = urllib.parse.urlparse(self.path)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else b""
            try:
                status, ctype, out = handler(method, parsed.path, query, dict(self.headers), body)
            except Exception as exc:  # noqa: BLE001 — never leak a stack to the browser
                status, ctype, out = 500, "text/plain; charset=utf-8", "internal error"
                print("TOOL_HTTP_HANDLER_ERROR " + json.dumps({"error": str(exc)}), flush=True)
            if isinstance(out, str):
                out = out.encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_GET(self):  # noqa: N802
            self._serve("GET")

        def do_POST(self):  # noqa: N802
            self._serve("POST")

        def log_message(self, *args):  # noqa: N802 — silence default stderr logging
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def _maybe_start_http_server() -> None:
    """If the tool module defines `http_handler`, serve it on CASPAR_VM_HTTP_PORT
    so the node's VM HTTP ingress can proxy inbound requests into the tool. Most
    tools define no handler and get no server."""
    try:
        port = int(os.environ.get("CASPAR_VM_HTTP_PORT") or 0)
    except ValueError:
        return
    if port <= 0:
        return
    try:
        impl = _load_tool_module()
    except Exception:  # noqa: BLE001
        impl = None
    handler = getattr(impl, "http_handler", None)
    if not callable(handler):
        return
    try:
        _run_http_server(handler, port)
        print("TOOL_HTTP_LISTENING " + json.dumps({"tool_id": TOOL_ID or "unknown", "port": port}), flush=True)
    except Exception as exc:  # noqa: BLE001
        print("TOOL_HTTP_ERROR " + json.dumps({"error": str(exc)}), flush=True)


def main() -> int:
    # The single gateway connection is the tool's only channel to the outside
    # world. When present, the tool runs as a long-lived standalone creature that
    # is driven purely through the signaling API. With no gateway (local/unit
    # tests) it falls back to a single offline dispatch.
    gateway_host = os.environ.get("CASPAR_GATEWAY_HOST", "").strip()
    # Announce the serve preconditions up front so the VM logs are conclusive
    # about *why* a tool did (or did not) reach the serve loop — a bare
    # "FAILED to serve" in the harness is otherwise un-actionable.
    print("TOOL_SERVE_BEGIN " + json.dumps({
        "tool_id": TOOL_ID or "unknown",
        "gateway_host": gateway_host or None,
        "gateway_port": os.environ.get("CASPAR_GATEWAY_PORT", "") or None,
        "bridge_module": _bridge_mod is not None,
    }), flush=True)
    bridge = _connect_bridge()
    # Start the optional inbound-HTTP server (e.g. the github tool's OAuth
    # callback) once the identity/env is up; it runs independently of the serve loop.
    _maybe_start_http_server()
    if bridge is not None:
        # Serve, reconnecting whenever the gateway link drops, so the creature
        # stays reachable across idle periods and transient blips instead of
        # going cold and hanging every caller until it is redeployed.
        global _BRIDGE
        while True:
            print(f"TOOL_BRIDGE {json.dumps({'connected': True, 'session': bridge.session_id})}", flush=True)
            outcome = _serve(bridge)
            try:
                bridge.close()
            except Exception:  # noqa: BLE001
                pass
            if outcome != "reconnect":
                return 0
            # Dial a fresh connection. Drop the cached (now-dead) handle first so
            # `_connect_bridge` reconnects instead of handing back the stale one.
            _BRIDGE = None
            bridge = _connect_bridge()
            if bridge is None:
                print("TOOL_SERVE_UNAVAILABLE " + json.dumps({
                    "tool_id": TOOL_ID or "unknown",
                    "reason": "gateway link dropped and could not be re-established — "
                              "exiting so the node cold-spawns a fresh container",
                }), flush=True)
                return 0
    # No live gateway bridge ⇒ we cannot serve. Without this marker the runtime
    # would silently drop to a one-shot offline dispatch that prints TOOL_RESPONSE
    # and exits, never emitting TOOL_SERVE_READY — which the harness can only
    # report as the opaque "FAILED to serve". State the reason explicitly.
    print("TOOL_SERVE_UNAVAILABLE " + json.dumps({
        "tool_id": TOOL_ID or "unknown",
        "gateway_host_set": bool(gateway_host),
        "bridge_module": _bridge_mod is not None,
        "reason": ("CASPAR_GATEWAY_HOST not present in container env — the node did "
                   "not inject the gateway address (not gateway-managed)"
                   if not gateway_host else
                   "gateway configured but the bridge could not connect/identify — "
                   "see the TOOL_BRIDGE connect_error line above"),
    }), flush=True)
    return _run_once_offline()


if __name__ == "__main__":
    sys.exit(main())
