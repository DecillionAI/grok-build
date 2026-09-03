"""sandbox tool creature — one cloud microVM per Decillion space.

Deployed as its own Caspar ``docker`` creature (like every other Davinci tool)
and driven purely through the Caspar signalling API: Nest signals it when a
space is created/deleted, and the space's agents signal it — through Davinci's
bridge executor — whenever they want to run something.

## Dual backbone (Modal or Vercel)

The tool speaks to one of two sandbox providers, chosen at runtime from the
credentials baked into the creature image:

* **Modal** — used when a Modal API key is present (``MODAL_TOKEN_ID`` +
  ``MODAL_TOKEN_SECRET``, or a combined ``MODAL_API_KEY`` in ``id:secret``
  form). Modal has **no public REST API** for sandboxes, so this backend drives
  the official Modal Python SDK (gRPC under the hood). A space's machine is a
  ``modal.Sandbox`` whose filesystem persists on a named ``modal.Volume``
  mounted at the workspace, and whose binding to a space is a tag derived from
  the space id.
* **Vercel** — used when only a Vercel token is present (``VERCEL_TOKEN`` /
  ``VERCEL_API_TOKEN`` / ``VERCEL_ACCESS_TOKEN``). This backend calls Vercel's
  REST API directly. A space's machine is a persistent *named* Vercel Sandbox.

Modal takes precedence when both are configured. Everything above the backend —
the background-task API, the directory listing, the signalling contract — is
provider-agnostic: it is expressed entirely in terms of the small ``Backend``
interface (``exec`` / ``write`` / ``read`` / ``mkdir`` / lifecycle), so the two
providers share one behaviour.

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

State lives entirely on the sandbox VM, under ``<bg_root>/<id>/``: ``pid`` +
``pgid`` (spawned in its own process group so children die too), ``stdout``,
``stderr``, ``exit`` (written atomically via ``mv``). Nothing lives in the
creature's memory, so two prompts against the same space share state and a
re-mint of the creature never orphans a running task. The background root is
provider-specific (see each backend's ``bg_root``) so it lands on storage that
survives the VM being stopped and resumed.

The binding between a Decillion space and its sandbox is the sandbox's **name**,
derived deterministically from the space id (:func:`sandbox_name`), so any
creature that knows the space id can address the same sandbox without a local
database.

Credentials come from the container environment only — never from the signal
payload, so a prompt-injected agent cannot swap the token or the target team::

    MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (or MODAL_API_KEY)   -> Modal backend
    VERCEL_TOKEN (or VERCEL_API_TOKEN / VERCEL_ACCESS_TOKEN)  -> Vercel backend
    VERCEL_TEAM_ID / VERCEL_PROJECT_ID                        Vercel scope (optional)
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import posixpath
import re
import shlex
import tarfile
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

# --------------------------------------------------------------------------- #
# Shared configuration
# --------------------------------------------------------------------------- #

HTTP_TIMEOUT = float(os.environ.get("SANDBOX_HTTP_TIMEOUT",
                                    os.environ.get("VERCEL_SANDBOX_HTTP_TIMEOUT", "60")))
# Wall-clock cap for one `exec`, independent of the HTTP read timeout.
EXEC_TIMEOUT_MS = int(os.environ.get("SANDBOX_EXEC_TIMEOUT_MS",
                                     os.environ.get("VERCEL_SANDBOX_EXEC_TIMEOUT_MS", "300000")))
# Command output is fed back into an LLM context — cap it hard.
MAX_OUTPUT_CHARS = int(os.environ.get("SANDBOX_MAX_OUTPUT",
                                      os.environ.get("VERCEL_SANDBOX_MAX_OUTPUT", "60000")))
MAX_READ_BYTES = int(os.environ.get("SANDBOX_MAX_READ_BYTES",
                                    os.environ.get("VERCEL_SANDBOX_MAX_READ_BYTES", "1000000")))

NAME_PREFIX = os.environ.get("SANDBOX_PREFIX",
                             os.environ.get("VERCEL_SANDBOX_PREFIX", "decillion"))
DEFAULT_TIMEOUT_MS = int(os.environ.get("SANDBOX_TIMEOUT_MS",
                                        os.environ.get("VERCEL_SANDBOX_TIMEOUT_MS", str(45 * 60 * 1000))))
# Modal bills per second while a Sandbox is alive, including idle. Stop it after
# this many ms with no exec and no open tunnel (preview URL / computer VNC).
# Files stay on the Volume. Default 5 minutes.
DEFAULT_IDLE_TIMEOUT_MS = int(os.environ.get("SANDBOX_IDLE_TIMEOUT_MS", str(5 * 60 * 1000)))
DEFAULT_VCPUS = int(os.environ.get("SANDBOX_VCPUS",
                                   os.environ.get("VERCEL_SANDBOX_VCPUS", "2")))
# Ports tunneled only when expose/preview asks — always-open tunnels prevent
# Modal idle-stop (5 min unused) because they count as activity.
DEFAULT_PREVIEW_PORTS = [3000, 3001, 4173, 5173, 8000, 8080]

_UNSAFE = re.compile(r"[^a-zA-Z0-9_-]+")

# Gateway bridge (set by tool_runtime). Used to read Admin Settings so idle
# stop and max lifetime can change without baking new env into the image.
_BRIDGE = None
_SETTINGS_AT = 0.0
_SETTINGS: Dict[str, Any] = {}
_SETTINGS_TTL_S = 45.0


def set_bridge(bridge) -> None:  # noqa: ANN001 — runtime hook
    global _BRIDGE
    _BRIDGE = bridge


def _host_json_data(resp: Any) -> Any:
    if not isinstance(resp, dict):
        return None
    data = resp.get("data")
    if isinstance(data, dict):
        return data
    for k in ("obj", "result"):
        v = resp.get(k)
        if isinstance(v, dict) and isinstance(v.get("data"), dict):
            return v.get("data")
    return None


def _platform_settings() -> Dict[str, Any]:
    """Admin Settings `config` blob (`Json::CreatureNamespace::settings`)."""
    global _SETTINGS_AT, _SETTINGS
    now = time.time()
    if _SETTINGS and (now - _SETTINGS_AT) < _SETTINGS_TTL_S:
        return _SETTINGS
    if _BRIDGE is None:
        return _SETTINGS
    try:
        resp = _BRIDGE.call(
            "getJson",
            {"key": "Json::CreatureNamespace::settings", "path": "config"},
            timeout=10,
        )
        data = _host_json_data(resp)
        if isinstance(data, dict):
            _SETTINGS = data
            _SETTINGS_AT = now
    except Exception:  # noqa: BLE001 — env defaults still work
        pass
    return _SETTINGS


def _cfg_number(cfg: Dict[str, Any], key: str, default: float) -> float:
    raw = cfg.get(key)
    if raw is None or raw == "":
        return default
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    return n


def machine_timeouts_ms() -> Tuple[int, int]:
    """Idle-stop and max-lifetime from Settings, else env defaults.

    Historically there was *no* idle timeout — only ``SANDBOX_TIMEOUT_MS``
    (45 minutes) as a hard session cap.
    """
    cfg = _platform_settings()
    idle_min = _cfg_number(cfg, "sandboxIdleTimeoutMinutes", DEFAULT_IDLE_TIMEOUT_MS / 60_000)
    max_min = _cfg_number(cfg, "sandboxMaxLifetimeMinutes", DEFAULT_TIMEOUT_MS / 60_000)
    idle_min = max(1.0, min(120.0, idle_min))
    max_min = max(5.0, min(24 * 60.0, max_min))
    if idle_min >= max_min:
        idle_min = max(1.0, max_min - 1.0)
    return int(idle_min * 60_000), int(max_min * 60_000)


def apply_machine_policy(payload: Dict[str, Any]) -> Dict[str, Any]:
    idle_ms, max_ms = machine_timeouts_ms()
    out = dict(payload)
    out["timeout_ms"] = max_ms
    out["idle_timeout_ms"] = idle_ms
    return out


class SandboxError(RuntimeError):
    """A backend call failed; carries the status + parsed body for the reply."""

    def __init__(self, message: str, *, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# Naming: the space <-> sandbox binding (shared by both backends)
# --------------------------------------------------------------------------- #

def sandbox_name(space_id: str) -> str:
    """The sandbox name bound to a Decillion space.

    Caspar space ids (``12@global``, ``local_<uuid>``) are not URL-safe and both
    providers restrict names to ``[a-zA-Z0-9_-]``. Sanitising alone can collide
    (``a@global`` and ``a-global`` both fold to ``a-global``), so the name
    carries a short digest of the *raw* id. Deterministic, so every creature
    derives the same name from the same space with no shared state.
    """
    raw = str(space_id or "").strip()
    if not raw:
        raise SandboxError("space_id is required to address a space sandbox")
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    slug = _UNSAFE.sub("-", raw).strip("-").lower()[:80] or "space"
    return f"{NAME_PREFIX}-{slug}-{digest}"[:128]


# --------------------------------------------------------------------------- #
# Shared command / output helpers
# --------------------------------------------------------------------------- #

def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n… [truncated, {len(text) - MAX_OUTPUT_CHARS} more chars]"


def _command_spec(payload: Dict[str, Any]) -> Tuple[str, List[str]]:
    """Split the caller's request into a program + argv.

    Agents write shell lines (``pip install -r req.txt && pytest -q``), but the
    APIs take a program plus argv. Unless the caller passes an explicit ``args``
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


def _shell_line(command: str, args: List[str]) -> str:
    """Collapse a (program, argv) pair back into a single ``sh -c`` line.

    ``_command_spec`` yields ``("sh", ["-c", line])`` for the common shell case,
    which we unwrap so we don't nest a second shell; anything else is quoted.
    """
    if command == "sh" and len(args) == 2 and args[0] == "-c":
        return args[1]
    return " ".join(shlex.quote(p) for p in ([command] + list(args)))


# --------------------------------------------------------------------------- #
# Background exec (subagent-safe) — provider-agnostic shell scripts
# --------------------------------------------------------------------------- #

# Ceiling for one output-chunk poll. Grok reads in slices; anything larger just
# means more polls, which is cheaper than a giant slice we truncate anyway.
BG_OUTPUT_CHUNK_BYTES = int(os.environ.get("SANDBOX_BG_CHUNK_BYTES",
                                           os.environ.get("VERCEL_SANDBOX_BG_CHUNK_BYTES", "131072")))

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
  # `ps` on the image has -o pgid; fall back to /proc for portability.
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
    env = {"TASK_ID": task_id, "BG_ROOT": backend().bg_root}
    if extra:
        env.update(extra)
    return env


def _bg_control_exec(space_id: str, script: str, env: Dict[str, str],
                     timeout_ms: int) -> Dict[str, Any]:
    """Run one of the small control scripts through the active backend's exec.

    Kept private because these are internal to the background-exec surface and
    the caller shouldn't need to know they're implemented via ``exec``.
    """
    return backend().exec(space_id, {"command": script, "env": env, "timeout_ms": timeout_ms})


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
    # The spawn wrapper already runs the command through `sh` (it base64-decodes
    # it into `cmd.sh` and execs `sh cmd.sh`), so background exec takes a shell
    # `command` string only — explicit argv (or `shell: False`) would land us
    # with two layers of quoting, so reject it loudly.
    if isinstance(payload.get("args"), list) or payload.get("shell") is False:
        raise SandboxError("exec_background takes a shell `command` string, not `args`")
    command = str(payload.get("command") or payload.get("cmd") or payload.get("task") or "").strip()
    if not command:
        raise SandboxError("command is required")
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
    result = _bg_control_exec(space_id, _BG_LIST_SCRIPT, {"BG_ROOT": backend().bg_root},
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


def _list_dir(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Structured, read-only directory listing for a file-explorer front-end.

    Runs the listing script through the ordinary exec path (so it shares the
    space's session and auto-resume), then parses the tab-separated rows into
    `{name, type, size}` entries with directories first.
    """
    path = str(payload.get("path") or payload.get("dir") or ".").strip() or "."
    res = backend().exec(space_id, {"command": _LIST_SCRIPT,
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
# File packing helper (shared: Vercel tars, Modal writes byte entries)
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


def _preview_ports(payload: Dict[str, Any]) -> List[int]:
    raw = payload.get("ports")
    if raw is None and payload.get("port") is not None:
        raw = [payload.get("port")]
    ports: List[int] = []
    if isinstance(raw, list):
        for item in raw:
            try:
                ports.append(int(item))
            except (TypeError, ValueError):
                continue
    elif raw is not None:
        try:
            ports.append(int(raw))
        except (TypeError, ValueError):
            pass
    for port in DEFAULT_PREVIEW_PORTS:
        if port not in ports:
            ports.append(port)
    return [p for p in ports if 1 <= p <= 65535]


def _preview_start_command(names: set[str], prefix: str = "") -> Optional[str]:
    cwd = f"cd {prefix} && " if prefix else ""
    if "server.py" in names:
        return f"{cwd}python3 server.py"
    if "app.py" in names:
        return f"{cwd}python3 app.py"
    if "package.json" in names:
        return f"{cwd}npm start"
    if "index.html" in names:
        return f"{cwd}python3 -m http.server 8000"
    return None


def _restart_preview_server(space_id: str) -> Optional[str]:
    listing = _list_dir(space_id, {"path": "."})
    entries = [e for e in (listing.get("entries") or []) if isinstance(e, dict)]
    names = {str(e.get("name") or "") for e in entries}
    command = _preview_start_command(names)
    if not command:
        dirs = [str(e.get("name") or "") for e in entries if e.get("type") == "dir"]
        for folder in dirs[:12]:
            if folder in {".", "..", ".git", "node_modules", "__pycache__", ".venv"}:
                continue
            nested = _list_dir(space_id, {"path": folder})
            nested_names = {str(e.get("name") or "") for e in (nested.get("entries") or []) if isinstance(e, dict)}
            command = _preview_start_command(nested_names, folder)
            if command:
                break
    if not command:
        return None
    _exec_background(space_id, {"command": command})
    return command


def _expose(space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Re-open the sandbox with public tunnels and restart a common web server.

    Modal/Vercel only bind tunnels at create time. Agents often start
    ``python3 server.py`` on localhost without those ports declared — this is
    how a person in the app gets a URL they can actually open.
    """
    ports = _preview_ports(payload)
    b = backend()
    try:
        b.stop(space_id, payload)
    except Exception:  # noqa: BLE001
        pass
    created = b.create(space_id, {**payload, "ports": ports})
    restarted = _restart_preview_server(space_id)
    time.sleep(2)
    try:
        info = b.info(space_id, {"resume": True})
    except Exception:  # noqa: BLE001
        info = created if isinstance(created, dict) else {}
    routes = info.get("routes") if isinstance(info, dict) else None
    if not routes and isinstance(created, dict):
        routes = created.get("routes")
    out = dict(info) if isinstance(info, dict) else {"ok": True}
    out.update({
        "ok": True,
        "action": "expose",
        "space_id": space_id,
        "ports": ports,
        "routes": routes or [],
        "restarted": restarted,
    })
    return out


# =========================================================================== #
# Backend abstraction
# =========================================================================== #

class Backend:
    """The provider-agnostic surface the action layer talks to.

    A backend owns the *lifecycle* of a space's sandbox and the four primitives
    everything else (background tasks, directory listing) is built on: ``exec``,
    ``write``, ``read`` and ``mkdir``. It also names the ``bg_root`` directory —
    the storage that survives the VM stopping — so background state lands
    somewhere durable on each provider.
    """

    name = "backend"
    bg_root = "/var/tmp/grok-bg-tasks"

    def exec(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def write(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def read(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def mkdir(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def create(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def info(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def start(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def stop(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def delete(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]: ...
    def list(self, payload: Dict[str, Any]) -> Dict[str, Any]: ...


def _env_first(*names: str) -> str:
    for name in names:
        val = os.environ.get(name, "").strip()
        if val:
            return val
    return ""


def _modal_configured() -> bool:
    if _env_first("MODAL_TOKEN_ID") and _env_first("MODAL_TOKEN_SECRET"):
        return True
    # A single combined key, `id:secret`, is accepted as `modal_api_key`.
    return bool(_env_first("MODAL_API_KEY", "MODAL_KEY"))


def _vercel_configured() -> bool:
    return bool(_env_first("VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN"))


_BACKEND: Optional[Backend] = None


def backend() -> Backend:
    """Select (once) and return the configured sandbox backend.

    Modal wins when a Modal API key is present; otherwise Vercel. Selecting
    lazily keeps the module importable (and the built-in fallbacks usable in
    tests) even with no credentials at all.
    """
    global _BACKEND
    if _BACKEND is None:
        if _modal_configured():
            _BACKEND = ModalBackend()
        elif _vercel_configured():
            _BACKEND = VercelBackend()
        else:
            raise SandboxError(
                "no sandbox backend is configured — set a Modal API key "
                "(MODAL_TOKEN_ID + MODAL_TOKEN_SECRET, or MODAL_API_KEY) to use Modal "
                "sandboxes, or VERCEL_TOKEN to use Vercel sandboxes")
    return _BACKEND


# =========================================================================== #
# Vercel backend (REST)
# =========================================================================== #

V_API_BASE = os.environ.get("VERCEL_API_BASE", "https://api.vercel.com").rstrip("/")
V_DEFAULT_RUNTIME = os.environ.get("VERCEL_SANDBOX_RUNTIME", "node24")
_V_SESSION_TTL = float(os.environ.get("VERCEL_SANDBOX_SESSION_TTL", "120"))


class VercelBackend(Backend):
    """Drives Vercel's REST API (v2 named sandboxes + sessions).

    REST endpoints used::

        POST   /v2/sandboxes                                  create (named)
        GET    /v2/sandboxes/{name}?resume=true               get / resume -> session
        DELETE /v2/sandboxes/{name}                           destroy
        POST   /v2/sandboxes/sessions/{sid}/cmd               exec (wait+logs ND-JSON)
        POST   /v2/sandboxes/sessions/{sid}/fs/write          upload a .tar.gz
        POST   /v2/sandboxes/sessions/{sid}/fs/read           download a file
        POST   /v2/sandboxes/sessions/{sid}/fs/mkdir          create a directory
        POST   /v2/sandboxes/sessions/{sid}/stop              stop the session
    """

    name = "vercel"
    # `/var/tmp` survives the named sandbox's snapshot/restore (a plain `/tmp`
    # on Vercel doesn't).
    bg_root = "/var/tmp/grok-bg-tasks"

    def __init__(self) -> None:
        # session id cache: name -> (session_id, monotonic deadline). A stopped
        # session is only detected when a call against it 404/410s, so the TTL
        # is short and every caller re-resolves through `_session` on failure.
        self._sessions: Dict[str, Tuple[str, float]] = {}

    # ------------------------------------------------------------------ HTTP #

    def _token(self) -> str:
        val = _env_first("VERCEL_TOKEN", "VERCEL_API_TOKEN", "VERCEL_ACCESS_TOKEN")
        if val:
            return val
        raise SandboxError(
            "no Vercel API token in the creature environment — set VERCEL_TOKEN on the "
            "sandbox creature image (see scripts/deploy_sandbox_tool.py)")

    def _scope_params(self) -> Dict[str, str]:
        params: Dict[str, str] = {}
        team = os.environ.get("VERCEL_TEAM_ID", "").strip()
        if team:
            params["teamId"] = team
        return params

    def _project_id(self) -> str:
        return os.environ.get("VERCEL_PROJECT_ID", "").strip()

    def _request(self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
                 json_body: Any = None, data: Optional[bytes] = None,
                 headers: Optional[Dict[str, str]] = None, stream: bool = False,
                 timeout: Optional[float] = None) -> requests.Response:
        hdrs = {"Authorization": f"Bearer {self._token()}"}
        if headers:
            hdrs.update(headers)
        query = self._scope_params()
        query.update({k: v for k, v in (params or {}).items() if v not in (None, "")})
        return requests.request(
            method, f"{V_API_BASE}{path}", params=query, json=json_body, data=data,
            headers=hdrs, stream=stream, timeout=timeout or HTTP_TIMEOUT)

    @staticmethod
    def _json_body(resp: requests.Response) -> Any:
        try:
            return resp.json()
        except ValueError:
            return (resp.text or "")[:500]

    def _check(self, resp: requests.Response, what: str) -> Any:
        """Raise :class:`SandboxError` on a non-2xx, else return the parsed body."""
        if resp.status_code >= 300:
            body = self._json_body(resp)
            message = body.get("error", {}).get("message") if isinstance(body, dict) else None
            raise SandboxError(f"{what} failed ({resp.status_code}): {message or body}",
                               status=resp.status_code, body=body)
        return self._json_body(resp)

    # -------------------------------------------------------------- lifecycle #

    def _create_body(self, space_id: str, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        vcpus = int(payload.get("vcpus") or DEFAULT_VCPUS)
        body: Dict[str, Any] = {
            "name": name,
            "runtime": payload.get("runtime") or V_DEFAULT_RUNTIME,
            "timeout": int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS),
            # Persistent = auto-snapshot on shutdown, so the space's files survive
            # a stopped VM and come back on the next `resume`.
            "persistent": True,
            "resources": {"vcpus": vcpus, "memory": int(payload.get("memory_mb") or vcpus * 2048)},
            # Tags are how an operator finds the sandbox belonging to a space in
            # the Vercel dashboard; the id is also recoverable from the name's digest.
            "tags": {"origin": "decillion", "spaceId": str(space_id)[:256]},
        }
        project = payload.get("project_id") or self._project_id()
        if project:
            body["projectId"] = project
        if payload.get("ports") is not None:
            body["ports"] = payload.get("ports")
        for key, field in (("env", "env"), ("source", "source"),
                           ("network_policy", "networkPolicy"), ("mounts", "mounts")):
            if payload.get(key) is not None:
                body[field] = payload[key]
        return body

    def _get_sandbox(self, name: str, *, resume: bool) -> Dict[str, Any]:
        resp = self._request("GET", f"/v2/sandboxes/{name}",
                             params={"resume": "true" if resume else "false",
                                     "projectId": self._project_id()})
        return self._check(resp, f"get sandbox {name}")

    def _create(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Create the space's sandbox, or adopt the existing one.

        Space creation is retried by Nest and can race with a manual provision,
        so a name that already exists is a success, not an error: we resume it.
        """
        name = sandbox_name(space_id)
        resp = self._request("POST", "/v2/sandboxes",
                             json_body=self._create_body(space_id, name, payload))
        if resp.status_code == 409:
            created = self._get_sandbox(name, resume=True)
            created["adopted"] = True
            return created
        created = self._check(resp, f"create sandbox {name}")
        created["adopted"] = False
        return created

    def _session(self, space_id: str, *, auto_create: bool = True,
                 create_payload: Optional[Dict[str, Any]] = None) -> str:
        """Resolve (and if needed resume or create) the space's live session id."""
        name = sandbox_name(space_id)
        cached = self._sessions.get(name)
        if cached and cached[1] > time.monotonic():
            return cached[0]
        try:
            info = self._get_sandbox(name, resume=True)
        except SandboxError as exc:
            if exc.status not in (404, 410) or not auto_create:
                raise
            info = self._create(space_id, create_payload or {})
        session_id = ((info.get("session") or {}).get("id") or ""
                      or (info.get("sandbox") or {}).get("currentSessionId") or "")
        if not session_id:
            raise SandboxError(f"sandbox {name} has no running session", body=info)
        self._sessions[name] = (session_id, time.monotonic() + _V_SESSION_TTL)
        return session_id

    def _forget_session(self, space_id: str) -> None:
        self._sessions.pop(sandbox_name(space_id), None)

    def _with_session(self, space_id: str, call) -> Any:
        """Run ``call(session_id)``, re-resolving once if the session went away.

        A named sandbox is stopped after its timeout and its session id dies
        with it; the next call must resume from the snapshot rather than fail.
        Every session-scoped operation goes through here so recovery is automatic.
        """
        session_id = self._session(space_id)
        try:
            return call(session_id)
        except SandboxError as exc:
            if exc.status not in (404, 409, 410):
                raise
            self._forget_session(space_id)
            return call(self._session(space_id))

    # ---------------------------------------------------------------- exec #

    @staticmethod
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

    def exec(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
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
            # The read timeout must outlive the command itself: with wait+logs
            # the response streams for the whole run.
            read_timeout = body["timeout"] / 1000.0 + HTTP_TIMEOUT
            resp = self._request("POST", f"/v2/sandboxes/sessions/{session_id}/cmd",
                                 json_body=body, stream=True, timeout=read_timeout)
            if resp.status_code >= 300:
                self._check(resp, "exec")
            record, out, err = self._drain_ndjson(resp)
            return record, out, err, session_id

        record, out, err, session_id = self._with_session(space_id, run)
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

    # ------------------------------------------------------------ filesystem #

    @staticmethod
    def _tarball(entries: List[Tuple[str, bytes]], cwd: Optional[str]) -> Tuple[bytes, Optional[str]]:
        """Pack files into the gzipped tar the write endpoint extracts.

        Paths are extracted *relative to* ``x-cwd`` (the home dir when unset), so
        an absolute target is expressed as "extract into ``/``" plus a
        root-relative arcname. Mixing the two in one call has no single correct
        answer, so it is rejected instead of silently writing to the wrong place.
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

    def write(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        entries = _file_entries(payload)
        blob, cwd = self._tarball(entries, payload.get("cwd"))
        headers = {"Content-Type": "application/gzip"}
        if cwd:
            headers["x-cwd"] = cwd

        def run(session_id: str) -> str:
            resp = self._request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/write",
                                 data=blob, headers=headers)
            self._check(resp, "write files")
            return session_id

        session_id = self._with_session(space_id, run)
        return {"ok": True, "action": "write", "space_id": space_id,
                "sandbox": sandbox_name(space_id), "session_id": session_id,
                "cwd": cwd, "written": [p for p, _ in entries],
                "bytes": sum(len(d) for _, d in entries)}

    def read(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        path = str(payload.get("path") or "").strip()
        if not path:
            raise SandboxError("path is required")
        body = {"path": path}
        if payload.get("cwd"):
            body["cwd"] = str(payload["cwd"])

        def run(session_id: str) -> Tuple[bytes, str]:
            resp = self._request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/read",
                                 json_body=body)
            if resp.status_code >= 300:
                self._check(resp, f"read {path}")
            return resp.content[:MAX_READ_BYTES], session_id

        data, session_id = self._with_session(space_id, run)
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

    def mkdir(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        path = str(payload.get("path") or "").strip()
        if not path:
            raise SandboxError("path is required")
        body = {"path": path}
        if payload.get("cwd"):
            body["cwd"] = str(payload["cwd"])

        def run(session_id: str) -> str:
            resp = self._request("POST", f"/v2/sandboxes/sessions/{session_id}/fs/mkdir",
                                 json_body=body)
            self._check(resp, f"mkdir {path}")
            return session_id

        session_id = self._with_session(space_id, run)
        return {"ok": True, "action": "mkdir", "space_id": space_id, "path": path,
                "sandbox": sandbox_name(space_id), "session_id": session_id}

    # -------------------------------------------------------------- actions #

    def _summarize(self, space_id: str, info: Dict[str, Any], action: str) -> Dict[str, Any]:
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

    def create(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._forget_session(space_id)
        return self._summarize(space_id, self._create(space_id, payload), "create")

    def info(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        resume = bool(payload.get("resume", False))
        try:
            return self._summarize(space_id, self._get_sandbox(sandbox_name(space_id), resume=resume), "info")
        except SandboxError as exc:
            if exc.status in (404, 410):
                return {"ok": False, "action": "info", "space_id": space_id,
                        "sandbox": sandbox_name(space_id), "exists": False,
                        "error": "no sandbox is bound to this space"}
            raise

    def start(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Resume the space's sandbox (creating it if it was never provisioned)."""
        self._forget_session(space_id)
        try:
            info = self._get_sandbox(sandbox_name(space_id), resume=True)
        except SandboxError as exc:
            if exc.status not in (404, 410):
                raise
            info = self._create(space_id, payload)
        return self._summarize(space_id, info, "start")

    def stop(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Stop the running session, keeping the snapshot. Never resumes on the
        way in — asking a stopped sandbox to stop must not boot a VM to shut it
        down."""
        name = sandbox_name(space_id)
        try:
            info = self._get_sandbox(name, resume=False)
        except SandboxError as exc:
            if exc.status in (404, 410):
                return {"ok": True, "action": "stop", "space_id": space_id,
                        "sandbox": name, "already_stopped": True, "exists": False}
            raise
        sandbox = info.get("sandbox") or {}
        session_id = ((info.get("session") or {}).get("id") or sandbox.get("currentSessionId") or "")
        if sandbox.get("status") != "running" or not session_id:
            self._forget_session(space_id)
            return {"ok": True, "action": "stop", "space_id": space_id, "sandbox": name,
                    "already_stopped": True, "status": sandbox.get("status")}
        resp = self._request("POST", f"/v2/sandboxes/sessions/{session_id}/stop")
        if resp.status_code not in (404, 410):
            self._check(resp, "stop session")
        self._forget_session(space_id)
        return {"ok": True, "action": "stop", "space_id": space_id, "sandbox": name,
                "session_id": session_id,
                "note": "filesystem snapshotted; the next command resumes it"}

    def delete(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Destroy the space's sandbox. Idempotent — an already-gone sandbox is a
        success, because this runs on space deletion and must not leave Nest with
        a binding it cannot clear."""
        name = sandbox_name(space_id)
        resp = self._request("DELETE", f"/v2/sandboxes/{name}", params={"projectId": self._project_id()})
        self._forget_session(space_id)
        if resp.status_code in (404, 410):
            return {"ok": True, "action": "delete", "space_id": space_id, "sandbox": name,
                    "deleted": False, "already_absent": True}
        body = self._check(resp, f"delete sandbox {name}")
        return {"ok": True, "action": "delete", "space_id": space_id, "sandbox": name,
                "deleted": True, "status": (body.get("sandbox") or {}).get("status")}

    def list(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = self._check(self._request("GET", "/v2/sandboxes", params={"projectId": self._project_id()}),
                           "list sandboxes")
        rows = body.get("sandboxes") if isinstance(body, dict) else None
        return {"ok": True, "action": "list",
                "sandboxes": [{"name": r.get("name"), "status": r.get("status"),
                               "spaceId": (r.get("tags") or {}).get("spaceId")}
                              for r in (rows or []) if isinstance(r, dict)]}


# =========================================================================== #
# Modal backend (Python SDK)
# =========================================================================== #

# The Modal App the sandboxes are grouped under (any string; created on demand).
MODAL_APP_NAME = os.environ.get("MODAL_SANDBOX_APP", "decillion-sandbox")
# Persistent workspace: a named Volume is mounted here per space so files survive
# the sandbox being stopped, and this is the sandbox's default working directory.
MODAL_WORKDIR = os.environ.get("MODAL_SANDBOX_WORKDIR", "/workspace")
# Base image for a space's sandbox. A registry ref (`org/img:tag`) uses
# from_registry; the default is a Debian slim with the usual build basics.
MODAL_IMAGE = os.environ.get("MODAL_SANDBOX_IMAGE", "").strip()
# The tag key that binds a Modal sandbox to a Decillion space (value = sandbox_name).
MODAL_SPACE_TAG = "decillion-space"
_M_SESSION_TTL = float(os.environ.get("MODAL_SANDBOX_SESSION_TTL", "120"))


def _volume_name(space_id: str) -> str:
    """Deterministic Volume name for a space (Modal names allow `[a-zA-Z0-9-_.]`)."""
    return f"{sandbox_name(space_id)}-vol"[:64]


class ModalBackend(Backend):
    """Drives Modal sandboxes through the official ``modal`` Python SDK.

    Modal exposes no public REST API for sandboxes, so — unlike Vercel — this
    backend cannot be reduced to HTTP calls: it uses the SDK, which speaks gRPC
    to Modal's control plane. Because of that this whole tool stays a docker
    creature (a TinyGo WASM creature could only reach a REST endpoint over the
    node's HTTP host bridge, which Modal does not offer).

    A space's machine is a ``modal.Sandbox`` tagged with the space's
    :func:`sandbox_name`, mounting a per-space named ``modal.Volume`` at
    :data:`MODAL_WORKDIR`. The sandbox is discovered by that tag, so — like the
    Vercel named-sandbox binding — no local database is needed; the Volume is
    what makes a stopped-and-recreated sandbox come back with its files.
    """

    name = "modal"
    # On Modal the ephemeral filesystem is lost when a sandbox is recreated;
    # only the mounted Volume persists. Background-task state therefore lives
    # under the workspace Volume so a stop/start keeps running-task records.
    bg_root = f"{MODAL_WORKDIR}/.grok-bg-tasks"

    def __init__(self) -> None:
        self._modal = self._import_modal()
        self._app = None
        # space_id -> (sandbox_object_id, monotonic deadline)
        self._sandboxes: Dict[str, Tuple[str, float]] = {}

    @staticmethod
    def _import_modal():
        # `MODAL_API_KEY` (`id:secret`) is a convenience the tool accepts; the
        # SDK itself reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET, so split it in.
        combined = _env_first("MODAL_API_KEY", "MODAL_KEY")
        if combined and not (_env_first("MODAL_TOKEN_ID") and _env_first("MODAL_TOKEN_SECRET")):
            token_id, sep, token_secret = combined.partition(":")
            if sep and token_id and token_secret:
                os.environ.setdefault("MODAL_TOKEN_ID", token_id.strip())
                os.environ.setdefault("MODAL_TOKEN_SECRET", token_secret.strip())
        try:
            import modal  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise SandboxError(f"the Modal SDK is not importable in the creature image: {exc}")
        return modal

    # ------------------------------------------------------------ resources #

    def _get_app(self):
        if self._app is None:
            self._app = self._modal.App.lookup(MODAL_APP_NAME, create_if_missing=True)
        return self._app

    def _app_id(self) -> str:
        app = self._get_app()
        # Modal has spelled this `.app_id` and `.object_id` across versions.
        return getattr(app, "app_id", None) or getattr(app, "object_id", "")

    def _image(self, payload: Dict[str, Any]):
        ref = str(payload.get("image") or MODAL_IMAGE or "").strip()
        modal = self._modal
        if ref:
            return modal.Image.from_registry(ref)
        # A general-purpose default: Debian with the toolchains agents reach for.
        return (modal.Image.debian_slim()
                .apt_install("git", "curl", "ca-certificates", "procps", "tar", "gzip"))

    def _volume(self, space_id: str):
        return self._modal.Volume.from_name(_volume_name(space_id), create_if_missing=True)

    def _resources(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        vcpus = float(payload.get("vcpus") or DEFAULT_VCPUS)
        memory_mb = int(payload.get("memory_mb") or vcpus * 2048)
        # Modal timeouts are in seconds.
        timeout_s = max(60, int(int(payload.get("timeout_ms") or DEFAULT_TIMEOUT_MS) / 1000))
        idle_timeout_s = max(60, int(int(payload.get("idle_timeout_ms") or DEFAULT_IDLE_TIMEOUT_MS) / 1000))
        return {"cpu": vcpus, "memory": memory_mb, "timeout": timeout_s, "idle_timeout": idle_timeout_s}

    # -------------------------------------------------------------- discovery #

    def _list_space_sandboxes(self, space_id: str) -> List[Any]:
        want = sandbox_name(space_id)
        try:
            return list(self._modal.Sandbox.list(
                app_id=self._app_id(), tags={MODAL_SPACE_TAG: want}))
        except TypeError:
            # Older SDKs take no tag filter — list all and filter by our tag.
            out = []
            for sb in self._modal.Sandbox.list(app_id=self._app_id()):
                try:
                    tags = sb.get_tags()
                except Exception:  # noqa: BLE001
                    tags = {}
                if tags.get(MODAL_SPACE_TAG) == want:
                    out.append(sb)
            return out

    @staticmethod
    def _is_running(sb: Any) -> bool:
        try:
            return sb.poll() is None
        except Exception:  # noqa: BLE001
            return False

    def _find_running(self, space_id: str) -> Optional[Any]:
        for sb in self._list_space_sandboxes(space_id):
            if self._is_running(sb):
                return sb
        return None

    def _create_sandbox(self, space_id: str, payload: Dict[str, Any]) -> Any:
        modal = self._modal
        app = self._get_app()
        res = self._resources(payload)
        ports = payload.get("ports")
        encrypted_ports = [int(p) for p in (ports or []) if str(p).strip().isdigit()]
        kwargs: Dict[str, Any] = {
            "app": app,
            "image": self._image(payload),
            "volumes": {MODAL_WORKDIR: self._volume(space_id)},
            "workdir": MODAL_WORKDIR,
            "cpu": res["cpu"],
            "memory": res["memory"],
            "timeout": res["timeout"],
            "idle_timeout": res["idle_timeout"],
        }
        if encrypted_ports:
            kwargs["encrypted_ports"] = encrypted_ports
        try:
            sb = modal.Sandbox.create(**kwargs)
        except TypeError:
            kwargs.pop("idle_timeout", None)
            sb = modal.Sandbox.create(**kwargs)
        try:
            sb.set_tags({MODAL_SPACE_TAG: sandbox_name(space_id),
                         "origin": "decillion", "spaceId": str(space_id)[:256]})
        except Exception:  # noqa: BLE001 — tags are best-effort discovery aid
            pass
        return sb

    def _sandbox(self, space_id: str, *, auto_create: bool = True,
                 create_payload: Optional[Dict[str, Any]] = None) -> Any:
        cached = self._sandboxes.get(space_id)
        if cached and cached[1] > time.monotonic():
            try:
                sb = self._modal.Sandbox.from_id(cached[0])
                if self._is_running(sb):
                    return sb
            except Exception:  # noqa: BLE001
                pass
            self._sandboxes.pop(space_id, None)
        sb = self._find_running(space_id)
        if sb is None:
            if not auto_create:
                raise SandboxError(f"no running sandbox for space {space_id}", status=404)
            sb = self._create_sandbox(space_id, create_payload or {})
        self._sandboxes[space_id] = (sb.object_id, time.monotonic() + _M_SESSION_TTL)
        return sb

    def _forget(self, space_id: str) -> None:
        self._sandboxes.pop(space_id, None)

    # ---------------------------------------------------------------- exec #

    def exec(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        command, args = _command_spec(payload)
        shell_line = _shell_line(command, args)
        env = payload.get("env") if isinstance(payload.get("env"), dict) else {}
        cwd = payload.get("cwd")
        timeout_ms = int(payload.get("timeout_ms") or EXEC_TIMEOUT_MS)
        timeout_s = max(1, int(timeout_ms / 1000))

        # Modal's exec takes env at sandbox creation, not per-command, so we fold
        # the caller's env (and optional cwd) into the shell line itself.
        prefix = "".join(f"export {shlex.quote(str(k))}={shlex.quote(str(v))}\n"
                         for k, v in env.items())
        if cwd:
            prefix += f"cd {shlex.quote(str(cwd))} || exit 127\n"
        full = prefix + shell_line

        started = time.time()

        def run(sb: Any) -> Tuple[str, str, Optional[int], str]:
            proc = sb.exec("sh", "-c", full, timeout=timeout_s)
            out = proc.stdout.read()
            err = proc.stderr.read()
            proc.wait()
            code = getattr(proc, "returncode", None)
            return out or "", err or "", code, sb.object_id

        out, err, code, sid = self._with_sandbox(space_id, run)
        return {
            "ok": code == 0,
            "action": "exec",
            "space_id": space_id,
            "sandbox": sandbox_name(space_id),
            "session_id": sid,
            "command_id": None,
            "exit_code": code,
            "stdout": _truncate(out),
            "stderr": _truncate(err),
            "duration_ms": int((time.time() - started) * 1000),
        }

    def _with_sandbox(self, space_id: str, call) -> Any:
        """Run ``call(sandbox)``, re-resolving once if the sandbox went away."""
        sb = self._sandbox(space_id)
        try:
            return call(sb)
        except SandboxError:
            raise
        except Exception:  # noqa: BLE001 — a terminated sandbox: recreate once
            self._forget(space_id)
            sb = self._sandbox(space_id)
            return call(sb)

    # ------------------------------------------------------------ filesystem #

    def _abs(self, path: str, cwd: Optional[str] = None) -> str:
        path = str(path)
        if path.startswith("/"):
            return path
        base = str(cwd) if cwd else MODAL_WORKDIR
        # The new Modal FS API rejects relative paths, so always resolve to an
        # absolute path (under the workspace by default).
        return posixpath.normpath(posixpath.join(base, path))

    # Modal removed the legacy handle-based FS API (`sb.open`, `sb.mkdir`, …);
    # the supported surface is the path-oriented `sb.filesystem` namespace
    # (`write_bytes` / `read_bytes` / `make_directory` / `list_files`). These
    # helpers use it, and fall back to `sb.exec` (always available) when a given
    # version doesn't expose the method — so the tool works across Modal
    # releases and never depends on the removed handle API.

    def _fs_mkdir(self, sb: Any, path: str) -> None:
        fs = getattr(sb, "filesystem", None)
        if fs is not None and hasattr(fs, "make_directory"):
            try:
                fs.make_directory(path, create_parents=True)
            except TypeError:  # older signature without the kwarg
                fs.make_directory(path)
            return
        sb.exec("sh", "-c", f"mkdir -p {shlex.quote(path)}").wait()

    def _fs_write_bytes(self, sb: Any, path: str, data: bytes) -> None:
        parent = posixpath.dirname(path)
        if parent and parent != "/":
            self._fs_mkdir(sb, parent)
        fs = getattr(sb, "filesystem", None)
        if fs is not None and hasattr(fs, "write_bytes"):
            try:
                fs.write_bytes(data, path)   # documented order: (data, remote_path)
            except TypeError:                # tolerate the opposite argument order
                fs.write_bytes(path, data)
            return
        # Fallback: pipe base64 through the shell (binary-safe).
        b64 = base64.b64encode(data).decode("ascii")
        sb.exec("sh", "-c",
                f"printf %s {shlex.quote(b64)} | base64 -d > {shlex.quote(path)}").wait()

    def _fs_read_bytes(self, sb: Any, path: str) -> bytes:
        fs = getattr(sb, "filesystem", None)
        if fs is not None and hasattr(fs, "read_bytes"):
            data = fs.read_bytes(path)
            if not isinstance(data, (bytes, bytearray)):
                data = str(data).encode("utf-8")
            return bytes(data[:MAX_READ_BYTES])
        proc = sb.exec("sh", "-c", f"head -c {MAX_READ_BYTES} {shlex.quote(path)} | base64")
        out = proc.stdout.read() or ""
        proc.wait()
        try:
            return base64.b64decode(out)
        except Exception:  # noqa: BLE001
            return b""

    def write(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        entries = _file_entries(payload)
        cwd = payload.get("cwd")

        def run(sb: Any) -> str:
            for path, data in entries:
                self._fs_write_bytes(sb, self._abs(path, cwd), data)
            return sb.object_id

        sid = self._with_sandbox(space_id, run)
        return {"ok": True, "action": "write", "space_id": space_id,
                "sandbox": sandbox_name(space_id), "session_id": sid,
                "cwd": cwd, "written": [p for p, _ in entries],
                "bytes": sum(len(d) for _, d in entries)}

    def read(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        path = str(payload.get("path") or "").strip()
        if not path:
            raise SandboxError("path is required")
        target = self._abs(path, payload.get("cwd"))

        def run(sb: Any) -> Tuple[bytes, str]:
            return self._fs_read_bytes(sb, target), sb.object_id

        data, sid = self._with_sandbox(space_id, run)
        result = {"ok": True, "action": "read", "space_id": space_id,
                  "sandbox": sandbox_name(space_id), "session_id": sid,
                  "path": path, "bytes": len(data)}
        try:
            result["content"] = _truncate(data.decode("utf-8"))
            result["encoding"] = "text"
        except UnicodeDecodeError:
            result["content"] = base64.b64encode(data).decode("ascii")
            result["encoding"] = "base64"
        return result

    def mkdir(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        path = str(payload.get("path") or "").strip()
        if not path:
            raise SandboxError("path is required")
        target = self._abs(path, payload.get("cwd"))

        def run(sb: Any) -> str:
            self._fs_mkdir(sb, target)
            return sb.object_id

        sid = self._with_sandbox(space_id, run)
        return {"ok": True, "action": "mkdir", "space_id": space_id, "path": path,
                "sandbox": sandbox_name(space_id), "session_id": sid}

    # -------------------------------------------------------------- actions #

    def _summarize(self, space_id: str, sb: Optional[Any], action: str,
                   *, adopted: Optional[bool] = None) -> Dict[str, Any]:
        status = "stopped"
        session_id = None
        routes: List[Dict[str, Any]] = []
        if sb is not None:
            session_id = getattr(sb, "object_id", None)
            status = "running" if self._is_running(sb) else "stopped"
            # Do not call tunnels() on idle peeks — opening tunnels resets
            # Modal's idle timer and keeps a unused VM billed.
            if action not in ("info", "create", "status"):
                try:
                    for port, tunnel in (sb.tunnels() or {}).items():
                        routes.append({"url": getattr(tunnel, "url", None), "port": port})
                except Exception:  # noqa: BLE001 — no exposed ports / not supported
                    pass
        return {
            "ok": True,
            "action": action,
            "space_id": space_id,
            "sandbox": sandbox_name(space_id),
            "status": status,
            "session_id": session_id,
            "runtime": "modal",
            "region": None,
            "cwd": MODAL_WORKDIR,
            "expires_at": None,
            "routes": routes,
            "adopted": adopted,
            "resumed": adopted,
        }

    def create(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Ensure the space's Volume exists. Do not boot a VM — first exec/start does."""
        self._forget(space_id)
        self._volume(space_id)
        existing = self._find_running(space_id)
        if existing is not None:
            self._sandboxes[space_id] = (existing.object_id, time.monotonic() + _M_SESSION_TTL)
            return self._summarize(space_id, existing, "create", adopted=True)
        return self._summarize(space_id, None, "create", adopted=False)

    def info(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        sb = self._find_running(space_id)
        if sb is None and bool(payload.get("resume", False)):
            sb = self._sandbox(space_id)
        if sb is None:
            # A stopped-but-provisioned space still has its Volume; report absence
            # of a running VM without claiming the space was never provisioned.
            has_volume = self._volume_exists(space_id)
            return {"ok": bool(has_volume), "action": "info", "space_id": space_id,
                    "sandbox": sandbox_name(space_id), "exists": has_volume,
                    "status": "stopped" if has_volume else None,
                    "error": None if has_volume else "no sandbox is bound to this space"}
        return self._summarize(space_id, sb, "info")

    def _volume_exists(self, space_id: str) -> bool:
        try:
            self._modal.Volume.from_name(_volume_name(space_id), create_if_missing=False)
            return True
        except Exception:  # noqa: BLE001
            return False

    def start(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._forget(space_id)
        sb = self._sandbox(space_id, create_payload=payload)
        return self._summarize(space_id, sb, "start")

    def stop(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Terminate the running sandbox. The Volume keeps the filesystem, so the
        next command recreates a sandbox that mounts the same files."""
        name = sandbox_name(space_id)
        self._forget(space_id)
        stopped = 0
        for sb in self._list_space_sandboxes(space_id):
            if self._is_running(sb):
                try:
                    sb.terminate()
                    stopped += 1
                except Exception:  # noqa: BLE001
                    pass
        return {"ok": True, "action": "stop", "space_id": space_id, "sandbox": name,
                "already_stopped": stopped == 0, "terminated": stopped,
                "note": "filesystem kept on the space volume; the next command recreates it"}

    def delete(self, space_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Terminate the sandbox and delete its Volume. Idempotent."""
        name = sandbox_name(space_id)
        self._forget(space_id)
        terminated = 0
        for sb in self._list_space_sandboxes(space_id):
            try:
                sb.terminate()
                terminated += 1
            except Exception:  # noqa: BLE001
                pass
        deleted_volume = False
        try:
            self._modal.Volume.delete(_volume_name(space_id))
            deleted_volume = True
        except Exception:  # noqa: BLE001 — already gone / unsupported
            pass
        return {"ok": True, "action": "delete", "space_id": space_id, "sandbox": name,
                "deleted": terminated > 0 or deleted_volume,
                "terminated": terminated, "deleted_volume": deleted_volume}

    def list(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rows: List[Dict[str, Any]] = []
        try:
            sandboxes = list(self._modal.Sandbox.list(app_id=self._app_id()))
        except Exception as exc:  # noqa: BLE001
            raise SandboxError(f"list sandboxes failed: {exc}")
        for sb in sandboxes:
            try:
                tags = sb.get_tags()
            except Exception:  # noqa: BLE001
                tags = {}
            if tags.get("origin") and tags.get("origin") != "decillion":
                continue
            rows.append({"name": tags.get(MODAL_SPACE_TAG) or getattr(sb, "object_id", None),
                         "status": "running" if self._is_running(sb) else "stopped",
                         "spaceId": tags.get("spaceId")})
        return {"ok": True, "action": "list", "sandboxes": rows}


# =========================================================================== #
# Dispatch
# =========================================================================== #

# Actions handled provider-agnostically on top of the backend's primitives.
_SHARED_ACTIONS = {
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
    "list_dir": _list_dir,
    "listdir": _list_dir,
    "ls": _list_dir,
    "readdir": _list_dir,
    "expose": _expose,
    "expose_port": _expose,
    "tunnel": _expose,
}

# Actions that map onto a backend method name (resolved on the active backend).
_BACKEND_ACTIONS = {
    "create": "create",
    "provision": "create",
    "start": "start",
    "resume": "start",
    "info": "info",
    "status": "info",
    "exec": "exec",
    "run": "exec",
    "shell": "exec",
    "write": "write",
    "read": "read",
    "mkdir": "mkdir",
    "stop": "stop",
    "suspend": "stop",
    "delete": "delete",
    "destroy": "delete",
    "remove": "delete",
    "list": "list",
}

# Actions that operate on the whole account rather than one space.
_SPACELESS = {"list"}

_ALL_ACTIONS = sorted(set(_SHARED_ACTIONS) | set(_BACKEND_ACTIONS))


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


_LIFECYCLE_TIMEOUT_ACTIONS = {"create", "provision", "start", "resume"}


def invoke(function_name: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = dict(payload or {})
    action = _normalize_action(function_name, payload)
    if action not in _SHARED_ACTIONS and action not in _BACKEND_ACTIONS:
        return {"ok": False, "error": f"unknown action '{action}'", "actions": _ALL_ACTIONS}
    try:
        if action in _LIFECYCLE_TIMEOUT_ACTIONS:
            payload = apply_machine_policy(payload)
        if action in _SPACELESS:
            return backend().list(payload)
        space_id = _space_id(payload)
        if action in _SHARED_ACTIONS:
            return _SHARED_ACTIONS[action](space_id, payload)
        method = getattr(backend(), _BACKEND_ACTIONS[action])
        return method(space_id, payload)
    except SandboxError as exc:
        return {"ok": False, "action": action, "error": str(exc),
                "status": exc.status or None}
    except requests.RequestException as exc:
        return {"ok": False, "action": action, "error": f"sandbox api unreachable: {exc}"}
