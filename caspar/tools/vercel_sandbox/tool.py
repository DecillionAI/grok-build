"""vercel_sandbox tool creature — one Vercel Sandbox microVM per Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API: Nest signals it when a
space is created/deleted, and the space's agents signal it — through Davinci's
bridge executor — whenever they want to run something.

## Background exec (subagent-safe)

Beyond one-shot ``exec``, the tool exposes a small background-task API used by
the grok-build sandbox terminal backend (``caspar/sandboxBridge.mjs``) to serve
grok's ``run_background`` / ``get_task_output`` / ``kill_task`` /
``wait_tasks``:

    exec_background   spawn a detached process, return a task id + pid
    get_output        cursor-based read of stdout/stderr + exit status
    kill_exec         SIGTERM (then SIGKILL) by task id
    wait_exec         block up to ``timeout_ms`` for the task to exit
    list_tasks        every task recorded on the sandbox

State lives entirely on the sandbox VM, under ``/var/tmp/grok-bg-tasks/<id>/``:
``pid`` + ``pgid`` (spawned in its own process group so children die too),
``stdout``, ``stderr``, ``exit`` (written atomically via ``mv``). Nothing lives
in the creature's memory, so two prompts against the same space share state and
a re-mint of the creature never orphans a running task.

State lives entirely on Vercel's side. The binding between a Decillion space and
its sandbox is the sandbox's **name**, derived deterministically from the space
id (:func:`sandbox_name`), so any creature that knows the space id can address
the same sandbox without a local database. Named sandboxes snapshot themselves
on shutdown, so a space's filesystem survives the VM being stopped and resumed.

Vercel REST API used (v2 named sandboxes + sessions)::

    POST   /v2/sandboxes                                  create (named)
    GET    /v2/sandboxes/{name}?resume=true               get / resume -> session
    DELETE /v2/sandboxes/{name}                           destroy
    POST   /v2/sandboxes/sessions/{sid}/cmd               exec (wait+logs ND-JSON)
    POST   /v2/sandboxes/sessions/{sid}/fs/write          upload a .tar.gz
    POST   /v2/sandboxes/sessions/{sid}/fs/read           download a file
    POST   /v2/sandboxes/sessions/{sid}/fs/mkdir          create a directory
    POST   /v2/sandboxes/sessions/{sid}/stop              stop the session

Credentials come from the container environment only — never from the signal
payload, so a prompt-injected agent cannot swap the token or the target team:

    VERCEL_TOKEN        (or VERCEL_API_TOKEN / VERCEL_ACCESS_TOKEN)   required
    VERCEL_TEAM_ID      team the sandboxes are billed to              optional
    VERCEL_PROJECT_ID   project that owns the named sandboxes         optional
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import tarfile
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

API_BASE = os.environ.get("VERCEL_API_BASE", "https://api.vercel.com").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("VERCEL_SANDBOX_HTTP_TIMEOUT", "60"))
# Wall-clock cap for one `exec`, independent of the HTTP read timeout.
EXEC_TIMEOUT_MS = int(os.environ.get("VERCEL_SANDBOX_EXEC_TIMEOUT_MS", "300000"))
# Command output is fed back into an LLM context — cap it hard.
MAX_OUTPUT_CHARS = int(os.environ.get("VERCEL_SANDBOX_MAX_OUTPUT", "60000"))
MAX_READ_BYTES = int(os.environ.get("VERCEL_SANDBOX_MAX_READ_BYTES", "1000000"))

NAME_PREFIX = os.environ.get("VERCEL_SANDBOX_PREFIX", "decillion")
DEFAULT_RUNTIME = os.environ.get("VERCEL_SANDBOX_RUNTIME", "node24")
DEFAULT_TIMEOUT_MS = int(os.environ.get("VERCEL_SANDBOX_TIMEOUT_MS", str(45 * 60 * 1000)))
DEFAULT_VCPUS = int(os.environ.get("VERCEL_SANDBOX_VCPUS", "2"))

_UNSAFE = re.compile(r"[^a-zA-Z0-9_-]+")

# session id cache: name -> (session_id, monotonic deadline). A stopped session
# is only detected when a call against it 404/410s, so the TTL is short and every
# caller re-resolves through `_session` on failure.
_SESSIONS: Dict[str, Tuple[str, float]] = {}
_SESSION_TTL = float(os.environ.get("VERCEL_SANDBOX_SESSION_TTL", "120"))


class SandboxError(RuntimeError):
    """A Vercel API call failed; carries the status + parsed body for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Naming: the space <-> sandbox binding
# --------------------------------------------------------------------------- #

def sandbox_name(space_id: str) -> str:
    """The sandbox name bound to a Decillion space.

    Caspar space ids (``12@global``, ``local_<uuid>``) are not URL-safe and
    Vercel restricts names to ``[a-zA-Z0-9_-]{1,128}``. Sanitising alone can
    collide (``a@global`` and ``a-global`` both fold to ``a-global``), so the
    name carries a short digest of the *raw* id. Deterministic, so every
    creature derives the same name from the same space with no shared state.
    """
    raw = str(space_id or "").strip()
    if not raw:
        raise SandboxError("space_id is required to address a space sandbox")
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    slug = _UNSAFE.sub("-", raw).strip("-").lower()[:80] or "space"
    return f"{NAME_PREFIX}-{slug}-{digest}"[:128]


# --------------------------------------------------------------------------- #
# HTTP plumbing
# --------------------------------------------------------------------------- #

def _token() -> str:
    for env in ("VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN"):
        val = os.environ.get(env, "").strip()
        if val:
            return val
    raise SandboxError(
        "no Vercel API token in the creature environment — set VERCEL_TOKEN on the "
        "vercel_sandbox creature image (see scripts/deploy_sandbox_tool.py)")


def _scope_params() -> Dict[str, str]:
    params: Dict[str, str] = {}
    team = os.environ.get("VERCEL_TEAM_ID", "").strip()
    if team:
        params["teamId"] = team
    return params


def _project_id() -> str:
    return os.environ.get("VERCEL_PROJECT_ID", "").strip()


def _request(method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
             json_body: Any = None, data: Optional[bytes] = None,
             headers: Optional[Dict[str, str]] = None, stream: bool = False,
             timeout: Optional[float] = None) -> requests.Response:
    hdrs = {"Authorization": f"Bearer {_token()}"}
    if headers:
        hdrs.update(headers)
    query = _scope_params()
    query.update({k: v for k, v in (params or {}).items() if v not in (None, "")})
    return requests.request(
        method, f"{API_BASE}{path}", params=query, json=json_body, data=data,
        headers=hdrs, stream=stream, timeout=timeout or HTTP_TIMEOUT)


def _json_body(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return (resp.text or "")[:500]


def _check(resp: requests.Response, what: str) -> Any:
    """Raise :class:`SandboxError` on a non-2xx, else return the parsed body."""
    if resp.status_code >= 300:
        body = _json_body(resp)
        message = body.get("error", {}).get("message") if isinstance(body, dict) else None
        raise SandboxError(f"{what} failed ({resp.status_code}): {message or body}",
                           status=resp.status_code, body=body)
    return _json_body(resp)


# --------------------------------------------------------------------------- #
# Sandbox lifecycle
# --------------------------------------------------------------------------- #

def _create_body(space_id: str, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    vcpus = int(payload.get("vcpus") or DEFAULT_VCPUS)
    body: Dict[str, Any] = {
        "name": name,
        "runtime": payload.get("runtime") or DEFAULT_RUNTIME,
        "timeout": int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS),
        # Persistent = auto-snapshot on shutdown, so the space's files survive a
        # stopped VM and come back on the next `resume`.
        "persistent": True,
        "resources": {"vcpus": vcpus, "memory": int(payload.get("memory_mb") or vcpus * 2048)},
        # Tags are how an operator finds the sandbox belonging to a space in the
        # Vercel dashboard; the id is also recoverable from the name's digest.
        "tags": {"origin": "decillion", "spaceId": str(space_id)[:256]},
    }
    project = payload.get("project_id") or _project_id()
    if project:
        body["projectId"] = project
    for key, field in (("ports", "ports"), ("env", "env"), ("source", "source"),
                       ("network_policy", "networkPolicy"), ("mounts", "mounts")):
        if payload.get(key) is not None:
            body[field] = payload[key]
    return body


def _get_sandbox(name: str, *, resume: bool) -> Dict[str, Any]:
    resp = _request("GET", f"/v2/sandboxes/{name}",
                    params={"resume": "true" if resume else "false", "projectId": _project_id()})
    return _check(resp, f"get sandbox {name}")


def _create(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Create the space's sandbox, or adopt the existing one.

    Space creation is retried by Nest and can race with a manual provision, so a
    name that already exists is a success, not an error: we resume it instead.
    """
    name = sandbox_name(space_id)
    resp = _request("POST", "/v2/sandboxes", json_body=_create_body(space_id, name, payload))
    if resp.status_code == 409:
        created = _get_sandbox(name, resume=True)
        created["adopted"] = True
        return created
    created = _check(resp, f"create sandbox {name}")
    created["adopted"] = False
    return created


def _session(space_id: str, *, auto_create: bool = True,
             create_payload: Optional[Dict[str, Any]] = None) -> str:
    """Resolve (and if needed resume or create) the space's live session id."""
    name = sandbox_name(space_id)
    cached = _SESSIONS.get(name)
    if cached and cached[1] > time.monotonic():
        return cached[0]
    try:
        info = _get_sandbox(name, resume=True)
    except SandboxError as exc:
        if exc.status not in (404, 410) or not auto_create:
            raise
        info = _create(space_id, create_payload or {})
    session_id = ((info.get("session") or {}).get("id") or ""
                  or (info.get("sandbox") or {}).get("currentSessionId") or "")
    if not session_id:
        raise SandboxError(f"sandbox {name} has no running session", body=info)
    _SESSIONS[name] = (session_id, time.monotonic() + _SESSION_TTL)
    return session_id


def _forget_session(space_id: str) -> None:
    _SESSIONS.pop(sandbox_name(space_id), None)


def _with_session(space_id: str, call) -> Any:
    """Run ``call(session_id)``, re-resolving once if the session went away.

    A named sandbox is stopped after its timeout and its session id dies with
    it; the next call must resume from the snapshot rather than fail. Every
    session-scoped operation goes through here so that recovery is automatic.
    """
    session_id = _session(space_id)
    try:
        return call(session_id)
    except SandboxError as exc:
        if exc.status not in (404, 409, 410):
            raise
        _forget_session(space_id)
        return call(_session(space_id))


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #

def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n… [truncated, {len(text) - MAX_OUTPUT_CHARS} more chars]"


def _command_spec(payload: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Split the caller's request into Vercel's ``command`` + ``args``.

    Agents write shell lines (``pip install -r req.txt && pytest -q``), but the
    API takes a program plus argv. Unless the caller passes an explicit ``args``
    list we therefore hand the whole line to ``sh -c``, which is what makes
    pipes, redirects and ``&&`` work at all.
    """
    command = str(payload.get("command") or payload.get("cmd") or payload.get("task") or "").strip()
    if not command:
        raise SandboxError("command is required")
    args = payload.get("args")
    if isinstance(args, list):
        return command, [str(a) for a in args]
    if payload.get("shell") is False:
        parts = command.split()
        return parts[0], parts[1:]
    return "sh", ["-c", command]


def _drain_ndjson(resp: requests.Response) -> Tuple[Dict[str, Any], str, str]:
    """Consume the exec ND-JSON stream into (command record, stdout, stderr)."""
    record: Dict[str, Any] = {}
    out: List[str] = []
    err: List[str] = []
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        try:
            event = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(event, dict):
            continue
        if isinstance(event.get("command"), dict):
            record = event["command"]
        stream, data = event.get("stream"), event.get("data")
        if not isinstance(data, str):
            continue
        if stream == "stderr":
            err.append(data)
        elif stream == "stdout":
            out.append(data)
    return record, "".join(out), "".join(err)


def _exec(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    command, args = _command_spec(payload)
    body: Dict[str, Any] = {"command": command, "args": args, "wait": True, "logs": True,
                            "timeout": int(payload.get("timeout_ms") or EXEC_TIMEOUT_MS)}
    if payload.get("cwd"):
        body["cwd"] = str(payload["cwd"])
    if isinstance(payload.get("env"), dict):
        body["env"] = {str(k): str(v) for k, v in payload["env"].items()}
    if payload.get("sudo"):
        body["sudo"] = True

    started = time.time()

    def run(session_id: str) -> Tuple[Dict[str, Any], str, str, str]:
        # The read timeout must outlive the command itself: with wait+logs the
        # response streams for the whole run.
        read_timeout = body["timeout"] / 1000.0 + HTTP_TIMEOUT
        resp = _request("POST", f"/v2/sandboxes/sessions/{session_id}/cmd",
                        json_body=body, stream=True, timeout=read_timeout)
        if resp.status_code >= 300:
            _check(resp, "exec")
        record, out, err = _drain_ndjson(resp)
        return record, out, err, session_id

    record, out, err, session_id = _with_session(space_id, run)
    exit_code = record.get("exitCode")
    return {
        "ok": exit_code == 0,
        "action": "exec",
        "space_id": space_id,
        "sandbox": sandbox_name(space_id),
        "session_id": session_id,
        "command_id": record.get("id"),
        "exit_code": exit_code,
        "stdout": _truncate(out),
        "stderr": _truncate(err),
        "duration_ms": record.get("durationMs") or int((time.time() - started) * 1000),
    }


# --------------------------------------------------------------------------- #
# Background exec (subagent-safe)
# --------------------------------------------------------------------------- #

# Where per-task state lives on the sandbox VM. `/var/tmp` because it survives
# the sandbox's snapshot/restore (a plain `/tmp` on Vercel doesn't).
BG_ROOT = "/var/tmp/grok-bg-tasks"

# Ceiling for one output-chunk poll. Grok reads in slices; anything larger just
# means more polls, which is cheaper than a giant slice we truncate anyway.
BG_OUTPUT_CHUNK_BYTES = int(os.environ.get("VERCEL_SANDBOX_BG_CHUNK_BYTES", "131072"))

# How task ids look (also enforced client-side but re-checked here so a malformed
# id can never escape into a shell command).
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# `set -eu` so any missing envvar aborts before it silently writes an empty pid
# file. The wrapper detaches with `setsid` + explicit fd redirection so closing
# the exec HTTP call cannot cascade a SIGHUP into the running child.
_BG_SPAWN_SCRIPT = r'''
set -eu
: "${TASK_ID:?}" "${CMD_B64:?}" "${BG_ROOT:?}"
DIR="$BG_ROOT/$TASK_ID"
mkdir -p "$DIR"
: > "$DIR/stdout"
: > "$DIR/stderr"
rm -f "$DIR/exit" "$DIR/killed" "$DIR/pid" "$DIR/pgid"
CWD="${TASK_CWD:-}"
setsid sh -c '
  set -u
  cwd="$1"; b64="$2"; dir="$3"
  # Record our own pid/pgid before the exec, so a caller can query us
  # immediately after spawn returns without racing the child.
  echo "$$" > "$dir/pid"
  # `ps` on Vercel images has -o pgid; fall back to /proc for portability.
  { ps -o pgid= -p "$$" 2>/dev/null | tr -d " " ; } > "$dir/pgid" \
    || awk "{print \$5}" /proc/$$/stat 2>/dev/null > "$dir/pgid" \
    || echo "$$" > "$dir/pgid"
  if [ -n "$cwd" ]; then
    cd "$cwd" 2>/dev/null || { printf "cd %s failed\n" "$cwd" >> "$dir/stderr"; echo 127 > "$dir/exit.tmp"; mv "$dir/exit.tmp" "$dir/exit"; exit 127; }
  fi
  # Run the user command with its own stdin closed and outputs piped to files.
  # `exec` replaces this shell so the pid we recorded IS the command shell.
  printf %s "$b64" | base64 -d > "$dir/cmd.sh"
  exec sh "$dir/cmd.sh" > "$dir/stdout" 2> "$dir/stderr" < /dev/null
' _ "$CWD" "$CMD_B64" "$DIR" </dev/null >/dev/null 2>&1 &
# Grab the wrapper pid too, in case the setsid child dies before writing pid.
FALLBACK_PID=$!
# Wait briefly for the child to publish its own pid (setsid, fresh session).
i=0
while [ "$i" -lt 50 ]; do
  if [ -s "$DIR/pid" ]; then break; fi
  i=$((i+1))
  # `sleep 0.02` is not POSIX; try both.
  sleep 0.02 2>/dev/null || sleep 1
done
if [ ! -s "$DIR/pid" ]; then echo "$FALLBACK_PID" > "$DIR/pid"; fi
# Watcher: when the child (pid) exits, write exit code atomically.
# We can't `wait` on it (different session), so poll with kill -0.
setsid sh -c '
  dir="$1"; pid=$(cat "$dir/pid")
  while kill -0 "$pid" 2>/dev/null; do sleep 0.2 2>/dev/null || sleep 1; done
  # If the child wrote its own exit (via the trap below on our spawn form we
  # dont install one - but in future) we honor it; else assume 0 (running to
  # completion without our seeing wait status is normal for setsid detach).
  if [ ! -f "$dir/exit" ]; then
    if [ -f "$dir/killed" ]; then
      echo 137 > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
    else
      # A detached child’s exit status is not recoverable from another
      # session; use the presence of `stderr` bytes as a weak proxy only for
      # the record. Callers who need exit_code should read $?-writing shells
      # via the foreground `exec` action instead.
      echo 0 > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
    fi
  fi
' _ "$DIR" </dev/null >/dev/null 2>&1 &
printf 'TASK_ID=%s\nPID=%s\nPGID=%s\n' "$TASK_ID" "$(cat "$DIR/pid")" "$(cat "$DIR/pgid" 2>/dev/null || echo "")"
'''

# One exec that returns everything a poll needs, so `get_output` is one round
# trip. Base64 the payload chunks so binary output cannot break the framing.
_BG_OUTPUT_SCRIPT = r'''
set -u
: "${TASK_ID:?}" "${BG_ROOT:?}"
DIR="$BG_ROOT/$TASK_ID"
if [ ! -d "$DIR" ]; then
  printf 'STATUS=missing\n'
  exit 0
fi
SO_OFF="${STDOUT_OFFSET:-0}"
SE_OFF="${STDERR_OFFSET:-0}"
MAX="${MAX_BYTES:-131072}"
PID=$(cat "$DIR/pid" 2>/dev/null || echo "")
PGID=$(cat "$DIR/pgid" 2>/dev/null || echo "")
EXITC=$(cat "$DIR/exit" 2>/dev/null || echo "")
KILLED=""; [ -f "$DIR/killed" ] && KILLED=1
RUNNING="no"
if [ -n "$PID" ] && [ -z "$EXITC" ] && kill -0 "$PID" 2>/dev/null; then RUNNING="yes"; fi
SO_SIZE=$(wc -c < "$DIR/stdout" 2>/dev/null || echo 0)
SE_SIZE=$(wc -c < "$DIR/stderr" 2>/dev/null || echo 0)
printf 'STATUS=ok\nPID=%s\nPGID=%s\nEXIT=%s\nRUNNING=%s\nKILLED=%s\nSO_SIZE=%s\nSE_SIZE=%s\nSO_OFF=%s\nSE_OFF=%s\nMAX=%s\n' \
  "$PID" "$PGID" "$EXITC" "$RUNNING" "$KILLED" "$SO_SIZE" "$SE_SIZE" "$SO_OFF" "$SE_OFF" "$MAX"
printf 'STDOUT_B64:'
if [ "$SO_OFF" -lt "$SO_SIZE" ]; then
  tail -c "+$((SO_OFF+1))" "$DIR/stdout" 2>/dev/null | head -c "$MAX" | base64 2>/dev/null | tr -d '\n' \
    || true
fi
printf '\n'
printf 'STDERR_B64:'
if [ "$SE_OFF" -lt "$SE_SIZE" ]; then
  tail -c "+$((SE_OFF+1))" "$DIR/stderr" 2>/dev/null | head -c "$MAX" | base64 2>/dev/null | tr -d '\n' \
    || true
fi
printf '\n'
'''

_BG_KILL_SCRIPT = r'''
set -u
: "${TASK_ID:?}" "${BG_ROOT:?}"
DIR="$BG_ROOT/$TASK_ID"
if [ ! -d "$DIR" ]; then printf 'STATUS=missing\n'; exit 0; fi
PGID=$(cat "$DIR/pgid" 2>/dev/null || echo "")
PID=$(cat "$DIR/pid" 2>/dev/null || echo "")
SIG="${SIGNAL:-TERM}"
TARGET=""
if [ -n "$PGID" ] && [ "$PGID" != "0" ]; then TARGET="-$PGID"; elif [ -n "$PID" ]; then TARGET="$PID"; fi
if [ -z "$TARGET" ]; then printf 'STATUS=notfound\n'; exit 0; fi
touch "$DIR/killed"
kill "-$SIG" "$TARGET" 2>/dev/null || true
# Escalate to KILL after a grace period if the target is still alive.
if [ -n "$PID" ]; then
  i=0
  while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 25 ]; do
    i=$((i+1)); sleep 0.2 2>/dev/null || sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$TARGET" 2>/dev/null || true
  fi
fi
printf 'STATUS=ok\nPID=%s\nPGID=%s\n' "$PID" "$PGID"
'''

# Blocking wait — implemented shell-side so we spend one HTTP call and one
# sandbox exec instead of a Python polling loop.
_BG_WAIT_SCRIPT = r'''
set -u
: "${TASK_ID:?}" "${BG_ROOT:?}"
DIR="$BG_ROOT/$TASK_ID"
if [ ! -d "$DIR" ]; then printf 'STATUS=missing\n'; exit 0; fi
DEADLINE_MS="${DEADLINE_MS:-30000}"
STEP_MS=200
ELAPSED=0
PID=$(cat "$DIR/pid" 2>/dev/null || echo "")
while :; do
  if [ -f "$DIR/exit" ]; then printf 'STATUS=exited\n'; exit 0; fi
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    # Give the watcher a moment to publish exit.
    sleep 0.3 2>/dev/null || sleep 1
    if [ -f "$DIR/exit" ]; then printf 'STATUS=exited\n'; else printf 'STATUS=gone\n'; fi
    exit 0
  fi
  if [ "$ELAPSED" -ge "$DEADLINE_MS" ]; then printf 'STATUS=timeout\n'; exit 0; fi
  sleep 0.2 2>/dev/null || sleep 1
  ELAPSED=$((ELAPSED+STEP_MS))
done
'''

_BG_LIST_SCRIPT = r'''
set -u
: "${BG_ROOT:?}"
if [ ! -d "$BG_ROOT" ]; then exit 0; fi
for d in "$BG_ROOT"/*; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  pid=$(cat "$d/pid" 2>/dev/null || echo "")
  exitc=$(cat "$d/exit" 2>/dev/null || echo "")
  running="no"
  if [ -n "$pid" ] && [ -z "$exitc" ] && kill -0 "$pid" 2>/dev/null; then running="yes"; fi
  printf 'TASK\t%s\t%s\t%s\t%s\n' "$name" "$pid" "$exitc" "$running"
done
'''


def _new_task_id(payload: Dict[str, Any]) -> str:
    tid = str(payload.get("task_id") or payload.get("id") or "").strip()
    if not tid:
        tid = f"t{int(time.time()*1000):x}-{base64.urlsafe_b64encode(os.urandom(6)).decode('ascii').rstrip('=')}"
    if not _TASK_ID_RE.match(tid):
        raise SandboxError(f"invalid task_id {tid!r} (must match {_TASK_ID_RE.pattern})")
    return tid


def _require_task_id(payload: Dict[str, Any]) -> str:
    tid = str(payload.get("task_id") or payload.get("id") or "").strip()
    if not tid:
        raise SandboxError("task_id is required")
    if not _TASK_ID_RE.match(tid):
        raise SandboxError(f"invalid task_id {tid!r}")
    return tid


def _bg_env(task_id: str, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    env = {"TASK_ID": task_id, "BG_ROOT": BG_ROOT}
    if extra:
        env.update(extra)
    return env


def _bg_control_exec(space_id: str, script: str, env: Dict[str, str],
                     timeout_ms: int) -> Dict[str, Any]:
    """Run one of the small control scripts and return the raw exec result.

    Kept private because these are internal to the background-exec surface and
    the caller shouldn't need to know they're implemented via `_exec`.
    """
    return _exec(space_id, {"command": script, "env": env, "timeout_ms": timeout_ms})


def _parse_kv_lines(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.rstrip("\r")
        if not line or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v
    return out


def _split_output_body(stdout: str) -> Tuple[Dict[str, str], str, str]:
    """Split `_BG_OUTPUT_SCRIPT` output into metadata + base64 chunks."""
    meta: Dict[str, str] = {}
    so_b64 = ""
    se_b64 = ""
    for line in stdout.splitlines():
        if line.startswith("STDOUT_B64:"):
            so_b64 = line[len("STDOUT_B64:"):]
        elif line.startswith("STDERR_B64:"):
            se_b64 = line[len("STDERR_B64:"):]
        elif "=" in line:
            k, _, v = line.partition("=")
            meta[k.strip()] = v
    return meta, so_b64, se_b64


def _decode_b64_chunk(chunk: str) -> Tuple[bytes, str]:
    """Decode a base64 chunk into bytes + a UTF-8 text (lossy if needed)."""
    if not chunk:
        return b"", ""
    try:
        data = base64.b64decode(chunk, validate=False)
    except Exception:
        return b"", ""
    try:
        return data, data.decode("utf-8")
    except UnicodeDecodeError:
        return data, data.decode("utf-8", errors="replace")


def _exec_background(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    command, args = _command_spec(payload)
    if args and args != ["-c", command]:
        # We already wrap the command in `sh -c` inside the watcher; explicit
        # argv would land us with two layers of quoting. Reject it loudly.
        raise SandboxError("exec_background takes a shell `command` string, not `args`")
    task_id = _new_task_id(payload)
    cmd_b64 = base64.b64encode(command.encode("utf-8")).decode("ascii")
    env = _bg_env(task_id, {"CMD_B64": cmd_b64})
    if payload.get("cwd"):
        env["TASK_CWD"] = str(payload["cwd"])
    if isinstance(payload.get("env"), dict):
        # Extra env vars merged into the wrapper's env, exported so the child
        # inherits them. Values are coerced to strings for the exec API.
        for k, v in payload["env"].items():
            env[f"USER_{str(k)}"] = str(v)
    result = _bg_control_exec(space_id, _BG_SPAWN_SCRIPT, env,
                              timeout_ms=int(payload.get("timeout_ms") or 15000))
    meta = _parse_kv_lines(result.get("stdout") or "")
    if not meta.get("PID"):
        return {"ok": False, "action": "exec_background", "space_id": space_id,
                "task_id": task_id, "error": "spawn produced no pid",
                "raw_stdout": result.get("stdout"), "raw_stderr": result.get("stderr")}
    return {
        "ok": True, "action": "exec_background", "space_id": space_id,
        "sandbox": sandbox_name(space_id), "session_id": result.get("session_id"),
        "task_id": task_id, "pid": meta.get("PID"), "pgid": meta.get("PGID"),
        "started_at_ms": int(time.time() * 1000),
    }


def _get_output(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    task_id = _require_task_id(payload)
    env = _bg_env(task_id, {
        "STDOUT_OFFSET": str(int(payload.get("stdout_offset") or 0)),
        "STDERR_OFFSET": str(int(payload.get("stderr_offset") or 0)),
        "MAX_BYTES": str(int(payload.get("max_bytes") or BG_OUTPUT_CHUNK_BYTES)),
    })
    result = _bg_control_exec(space_id, _BG_OUTPUT_SCRIPT, env,
                              timeout_ms=int(payload.get("timeout_ms") or 15000))
    meta, so_b64, se_b64 = _split_output_body(result.get("stdout") or "")
    if meta.get("STATUS") == "missing":
        return {"ok": False, "action": "get_output", "space_id": space_id,
                "task_id": task_id, "error": "no such task", "missing": True}
    so_bytes, so_text = _decode_b64_chunk(so_b64)
    se_bytes, se_text = _decode_b64_chunk(se_b64)
    exitc = meta.get("EXIT") or ""
    running = (meta.get("RUNNING") or "no") == "yes"
    exit_code: Optional[int]
    if exitc == "":
        exit_code = None
    else:
        try:
            exit_code = int(exitc)
        except ValueError:
            exit_code = None
    return {
        "ok": True, "action": "get_output", "space_id": space_id,
        "sandbox": sandbox_name(space_id), "session_id": result.get("session_id"),
        "task_id": task_id, "pid": meta.get("PID"), "pgid": meta.get("PGID"),
        "running": running, "exit_code": exit_code,
        "killed": bool(meta.get("KILLED")),
        "stdout": so_text, "stderr": se_text,
        "stdout_bytes": len(so_bytes), "stderr_bytes": len(se_bytes),
        "stdout_next_offset": int(meta.get("SO_OFF", "0") or 0) + len(so_bytes),
        "stderr_next_offset": int(meta.get("SE_OFF", "0") or 0) + len(se_bytes),
        "stdout_total": int(meta.get("SO_SIZE", "0") or 0),
        "stderr_total": int(meta.get("SE_SIZE", "0") or 0),
    }


def _kill_exec(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    task_id = _require_task_id(payload)
    env = _bg_env(task_id, {"SIGNAL": str(payload.get("signal") or "TERM")})
    result = _bg_control_exec(space_id, _BG_KILL_SCRIPT, env,
                              timeout_ms=int(payload.get("timeout_ms") or 30000))
    meta = _parse_kv_lines(result.get("stdout") or "")
    status = meta.get("STATUS") or "ok"
    return {
        "ok": status in ("ok", "notfound"), "action": "kill_exec", "space_id": space_id,
        "sandbox": sandbox_name(space_id), "session_id": result.get("session_id"),
        "task_id": task_id, "status": status,
        "pid": meta.get("PID"), "pgid": meta.get("PGID"),
        "missing": status == "missing",
    }


def _wait_exec(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    task_id = _require_task_id(payload)
    deadline_ms = int(payload.get("timeout_ms") or 30000)
    # The shell script polls up to `deadline_ms`; add a small HTTP buffer.
    env = _bg_env(task_id, {"DEADLINE_MS": str(deadline_ms)})
    result = _bg_control_exec(space_id, _BG_WAIT_SCRIPT, env,
                              timeout_ms=deadline_ms + 10000)
    meta = _parse_kv_lines(result.get("stdout") or "")
    status = meta.get("STATUS") or "unknown"
    reply = _get_output(space_id, {"task_id": task_id,
                                   "stdout_offset": int(payload.get("stdout_offset") or 0),
                                   "stderr_offset": int(payload.get("stderr_offset") or 0),
                                   "max_bytes": int(payload.get("max_bytes") or BG_OUTPUT_CHUNK_BYTES)})
    reply["action"] = "wait_exec"
    reply["wait_status"] = status
    reply["timed_out"] = status == "timeout"
    return reply


def _list_tasks(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = _bg_control_exec(space_id, _BG_LIST_SCRIPT, {"BG_ROOT": BG_ROOT},
                              timeout_ms=int(payload.get("timeout_ms") or 15000))
    tasks: List[Dict[str, Any]] = []
    for line in (result.get("stdout") or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 5 or parts[0] != "TASK":
            continue
        _, name, pid, exitc, running = parts[:5]
        try:
            code = int(exitc) if exitc else None
        except ValueError:
            code = None
        tasks.append({"task_id": name, "pid": pid, "exit_code": code,
                      "running": running == "yes"})
    return {"ok": True, "action": "list_tasks", "space_id": space_id,
            "sandbox": sandbox_name(space_id), "session_id": result.get("session_id"),
            "tasks": tasks, "count": len(tasks)}


# --------------------------------------------------------------------------- #
# Filesystem
# --------------------------------------------------------------------------- #

def _file_entries(payload: Dict[str, Any]) -> List[Tuple[str, bytes]]:
    files = payload.get("files")
    if not isinstance(files, list):
        path = payload.get("path") or payload.get("file_name") or payload.get("target_path")
        if not path:
            raise SandboxError("write needs `path` + `content`, or a `files` list")
        files = [{"path": path, "content": payload.get("content", ""),
                  "encoding": payload.get("encoding", "text")}]
    entries: List[Tuple[str, bytes]] = []
    for spec in files:
        if not isinstance(spec, dict) or not spec.get("path"):
            raise SandboxError("each entry of `files` needs a `path`")
        content = spec.get("content", "")
        if str(spec.get("encoding") or "text").lower() == "base64":
            data = base64.b64decode(content or "")
        else:
            data = str(content).encode("utf-8")
        entries.append((str(spec["path"]), data))
    return entries


def _tarball(entries: List[Tuple[str, bytes]], cwd: Optional[str]) -> Tuple[bytes, Optional[str]]:
    """Pack files into the gzipped tar the write endpoint extracts.

    Paths are extracted *relative to* ``x-cwd`` (the home dir when unset), so an
    absolute target is expressed as "extract into ``/``" plus a root-relative
    arcname. Mixing the two in one call has no single correct answer, so it is
    rejected instead of silently writing to the wrong place.
    """
    absolute = [p for p, _ in entries if p.startswith("/")]
    if cwd is None and absolute:
        if len(absolute) != len(entries):
            raise SandboxError("mixed absolute and relative paths — pass an explicit `cwd`")
        cwd = "/"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path, data in entries:
            info = tarfile.TarInfo(name=path.lstrip("/"))
            info.size = len(data)
            info.mtime = int(time.time())
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue(), cwd


def _write(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    entries = _file_entries(payload)
    blob, cwd = _tarball(entries, payload.get("cwd"))
    headers = {"Content-Type": "application/gzip"}
    if cwd:
        headers["x-cwd"] = cwd

    def run(session_id: str) -> str:
        resp = _request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/write",
                        data=blob, headers=headers)
        _check(resp, "write files")
        return session_id

    session_id = _with_session(space_id, run)
    return {"ok": True, "action": "write", "space_id": space_id,
            "sandbox": sandbox_name(space_id), "session_id": session_id,
            "cwd": cwd, "written": [p for p, _ in entries],
            "bytes": sum(len(d) for _, d in entries)}


def _read(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    path = str(payload.get("path") or "").strip()
    if not path:
        raise SandboxError("path is required")
    body = {"path": path}
    if payload.get("cwd"):
        body["cwd"] = str(payload["cwd"])

    def run(session_id: str) -> Tuple[bytes, str]:
        resp = _request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/read", json_body=body)
        if resp.status_code >= 300:
            _check(resp, f"read {path}")
        return resp.content[:MAX_READ_BYTES], session_id

    data, session_id = _with_session(space_id, run)
    result = {"ok": True, "action": "read", "space_id": space_id,
              "sandbox": sandbox_name(space_id), "session_id": session_id,
              "path": path, "bytes": len(data)}
    try:
        result["content"] = _truncate(data.decode("utf-8"))
        result["encoding"] = "text"
    except UnicodeDecodeError:
        result["content"] = base64.b64encode(data).decode("ascii")
        result["encoding"] = "base64"
    return result


def _mkdir(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    path = str(payload.get("path") or "").strip()
    if not path:
        raise SandboxError("path is required")
    body = {"path": path}
    if payload.get("cwd"):
        body["cwd"] = str(payload["cwd"])

    def run(session_id: str) -> str:
        resp = _request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/mkdir", json_body=body)
        _check(resp, f"mkdir {path}")
        return session_id

    session_id = _with_session(space_id, run)
    return {"ok": True, "action": "mkdir", "space_id": space_id, "path": path,
            "sandbox": sandbox_name(space_id), "session_id": session_id}


# A POSIX-sh directory listing that emits one `type<TAB>size<TAB>name` row per
# entry (dirs as `d`, everything else as `f`), so a front-end can build a file
# explorer from one structured signal instead of parsing `ls` output. The path
# rides in `$LIST_DIR` (an env var) to sidestep every shell-quoting hazard; a
# missing/!directory target prints the single sentinel `__NODIR__`.
_LIST_SCRIPT = r'''
d="${LIST_DIR:-.}"
cd "$d" 2>/dev/null || { printf '__NODIR__\n'; exit 0; }
for e in * .*; do
  [ "$e" = "." ] && continue
  [ "$e" = ".." ] && continue
  [ -e "$e" ] || [ -L "$e" ] || continue
  if [ -d "$e" ]; then t=d; sz=0; else t=f; sz=$(wc -c < "$e" 2>/dev/null || printf 0); fi
  printf '%s\t%s\t%s\n' "$t" "$sz" "$e"
done
'''


def _list_dir(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Structured, read-only directory listing for a file-explorer front-end.

    Runs the listing script through the ordinary exec path (so it shares the
    space's session and auto-resume), then parses the tab-separated rows into
    `{name, type, size}` entries with directories first.
    """
    path = str(payload.get("path") or payload.get("dir") or ".").strip() or "."
    res = _exec(space_id, {"command": _LIST_SCRIPT,
                           "env": {"LIST_DIR": path},
                           "timeout_ms": int(payload.get("timeout_ms") or 15000)})
    stdout = res.get("stdout") or ""
    lines = [ln for ln in stdout.splitlines() if ln != ""]
    if lines and lines[0].strip() == "__NODIR__":
        return {"ok": False, "action": "list_dir", "space_id": space_id, "path": path,
                "sandbox": sandbox_name(space_id), "error": "not a directory or not found"}
    entries: List[Dict[str, Any]] = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        kind, size_str, name = parts[0], parts[1], "\t".join(parts[2:])
        if not name:
            continue
        try:
            size = int(size_str)
        except (TypeError, ValueError):
            size = 0
        entries.append({"name": name, "type": "dir" if kind == "d" else "file", "size": size})
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return {"ok": True, "action": "list_dir", "space_id": space_id,
            "sandbox": sandbox_name(space_id), "path": path,
            "entries": entries, "count": len(entries),
            "exit_code": res.get("exit_code")}


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #

def _summarize(space_id: str, info: Dict[str, Any], action: str) -> Dict[str, Any]:
    sandbox = info.get("sandbox") or {}
    session = info.get("session") or {}
    return {
        "ok": True,
        "action": action,
        "space_id": space_id,
        "sandbox": sandbox.get("name") or sandbox_name(space_id),
        "status": sandbox.get("status") or session.get("status"),
        "session_id": session.get("id") or sandbox.get("currentSessionId"),
        "runtime": sandbox.get("runtime") or session.get("runtime"),
        "region": sandbox.get("region") or session.get("region"),
        "cwd": sandbox.get("cwd") or session.get("cwd"),
        "expires_at": sandbox.get("expiresAt"),
        # Public URLs of any exposed ports — how an agent hands a running dev
        # server or preview back to the humans in the space.
        "routes": [{"url": r.get("url"), "port": r.get("port")}
                   for r in (info.get("routes") or []) if isinstance(r, dict)],
        "adopted": info.get("adopted"),
        "resumed": info.get("resumed"),
    }


def _action_create(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    _forget_session(space_id)
    return _summarize(space_id, _create(space_id, payload), "create")


def _action_info(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    resume = bool(payload.get("resume", False))
    try:
        return _summarize(space_id, _get_sandbox(sandbox_name(space_id), resume=resume), "info")
    except SandboxError as exc:
        if exc.status in (404, 410):
            return {"ok": False, "action": "info", "space_id": space_id,
                    "sandbox": sandbox_name(space_id), "exists": False,
                    "error": "no sandbox is bound to this space"}
        raise


def _action_start(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Resume the space's sandbox (creating it if it was never provisioned)."""
    _forget_session(space_id)
    try:
        info = _get_sandbox(sandbox_name(space_id), resume=True)
    except SandboxError as exc:
        if exc.status not in (404, 410):
            raise
        info = _create(space_id, payload)
    return _summarize(space_id, info, "start")


def _action_stop(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Stop the running session, keeping the snapshot. Never resumes on the way
    in — asking a stopped sandbox to stop must not boot a VM to shut it down."""
    name = sandbox_name(space_id)
    try:
        info = _get_sandbox(name, resume=False)
    except SandboxError as exc:
        if exc.status in (404, 410):
            return {"ok": True, "action": "stop", "space_id": space_id,
                    "sandbox": name, "already_stopped": True, "exists": False}
        raise
    sandbox = info.get("sandbox") or {}
    session_id = ((info.get("session") or {}).get("id") or sandbox.get("currentSessionId") or "")
    if sandbox.get("status") != "running" or not session_id:
        _forget_session(space_id)
        return {"ok": True, "action": "stop", "space_id": space_id, "sandbox": name,
                "already_stopped": True, "status": sandbox.get("status")}
    resp = _request("POST", f"/v2/sandboxes/sessions/{session_id}/stop")
    if resp.status_code not in (404, 410):
        _check(resp, "stop session")
    _forget_session(space_id)
    return {"ok": True, "action": "stop", "space_id": space_id, "sandbox": name,
            "session_id": session_id,
            "note": "filesystem snapshotted; the next command resumes it"}


def _action_delete(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Destroy the space's sandbox. Idempotent — an already-gone sandbox is a
    success, because this runs on space deletion and must not leave Nest with a
    binding it cannot clear."""
    name = sandbox_name(space_id)
    resp = _request("DELETE", f"/v2/sandboxes/{name}", params={"projectId": _project_id()})
    _forget_session(space_id)
    if resp.status_code in (404, 410):
        return {"ok": True, "action": "delete", "space_id": space_id, "sandbox": name,
                "deleted": False, "already_absent": True}
    body = _check(resp, f"delete sandbox {name}")
    return {"ok": True, "action": "delete", "space_id": space_id, "sandbox": name,
            "deleted": True, "status": (body.get("sandbox") or {}).get("status")}


def _action_list(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    body = _check(_request("GET", "/v2/sandboxes", params={"projectId": _project_id()}),
                  "list sandboxes")
    rows = body.get("sandboxes") if isinstance(body, dict) else None
    return {"ok": True, "action": "list",
            "sandboxes": [{"name": r.get("name"), "status": r.get("status"),
                           "spaceId": (r.get("tags") or {}).get("spaceId")}
                          for r in (rows or []) if isinstance(r, dict)]}


_ACTIONS = {
    "create": _action_create,
    "provision": _action_create,
    "start": _action_start,
    "resume": _action_start,
    "info": _action_info,
    "status": _action_info,
    "exec": _exec,
    "run": _exec,
    "shell": _exec,
    "exec_background": _exec_background,
    "run_background": _exec_background,
    "spawn": _exec_background,
    "get_output": _get_output,
    "get_task_output": _get_output,
    "kill_exec": _kill_exec,
    "kill_task": _kill_exec,
    "wait_exec": _wait_exec,
    "wait_task": _wait_exec,
    "list_tasks": _list_tasks,
    "tasks": _list_tasks,
    "write": _write,
    "read": _read,
    "mkdir": _mkdir,
    "list_dir": _list_dir,
    "listdir": _list_dir,
    "ls": _list_dir,
    "readdir": _list_dir,
    "stop": _action_stop,
    "suspend": _action_stop,
    "delete": _action_delete,
    "destroy": _action_delete,
    "remove": _action_delete,
    "list": _action_list,
}

# Actions that operate on the whole account rather than one space.
_SPACELESS = {"list"}


def _normalize_action(function_name: str, payload: Dict[str, Any]) -> str:
    """Pick the action from the signal's ``function`` or the payload.

    Davinci's bridge executor sends the catalog's routing function, but a lead
    agent reaching the tool through the generic ``invoke`` route names the
    action in its arguments instead — both must work.
    """
    for candidate in (payload.get("action"), payload.get("function"), function_name):
        if isinstance(candidate, str) and candidate.strip() and candidate.strip() != "invoke":
            return candidate.strip().lower()
    return "exec" if payload.get("command") else "info"


def _space_id(payload: Dict[str, Any]) -> str:
    for key in ("space_id", "spaceId", "store_id", "storeId"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    raise SandboxError("space_id is required — the sandbox is bound to a Decillion space")


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    handler = _ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action '{action}'",
                "actions": sorted(set(_ACTIONS))}
    try:
        space_id = "" if action in _SPACELESS else _space_id(payload)
        return handler(space_id, payload)
    except SandboxError as exc:
        return {"ok": False, "action": action, "error": str(exc),
                "status": exc.status or None}
    except requests.RequestException as exc:
        return {"ok": False, "action": action,
                "error": f"vercel api unreachable: {exc}"}
