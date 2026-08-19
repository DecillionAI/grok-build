/**
 * The grok ⇄ per-space sandbox bridge.
 *
 * Grok's built-in terminal + filesystem tools (`bash`, `read_file`, `edit`,
 * `list_dir`, `glob`, `grep`, `task`/`get_task_output`/`kill_task`, …) all
 * route through two Rust traits inside the CLI — `TerminalBackend` and
 * `AsyncFileSystem` — and normally hit the container the CLI itself runs in.
 * For Decillion agents that container is private and ephemeral, so we swap the
 * backend for one that forwards every call to the space's shared cloud sandbox
 * (the `sandbox` creature). Then `bash /app/build.sh` in one subagent
 * and `pytest -q` in another are just two POSTs to the same VM — no per-agent
 * workspace magic, no shell replacement.
 *
 * This module is the JS half of that swap:
 *
 *   grok binary (Rust `CasparSandboxTerminalBackend` / `CasparSandboxFileSystem`)
 *      │  NDJSON over unix socket
 *      ▼
 *   sandboxBridge.mjs  ── ToolInvoker (Caspar signal) ──▶ sandbox creature
 *                                                            │
 *                                                            ▼
 *                                                     Modal / Vercel microVM
 *
 * The socket path (see `SandboxBridgeServer.socketPath`) is set on the grok
 * child as `GROK_SANDBOX_SOCKET`; the Rust backend connects on first use.
 *
 * Wire (newline-delimited JSON, one request per line):
 *
 *   → { "id": 1, "op": "exec",           "args": { "command": "ls", … } }
 *   → { "id": 2, "op": "exec_background","args": { "command": "npm test" } }
 *   → { "id": 3, "op": "get_output",     "args": { "task_id": "…", "stdout_offset": 4096 } }
 *   → { "id": 4, "op": "kill_task",      "args": { "task_id": "…" } }
 *   → { "id": 5, "op": "wait_completion","args": { "task_id": "…", "timeout_ms": 60000 } }
 *   → { "id": 6, "op": "read",           "args": { "path": "src/app.ts" } }
 *   → { "id": 7, "op": "write",          "args": { "path": "src/app.ts", "content": "…" } }
 *   → { "id": 8, "op": "list_dir",       "args": { "path": "src" } }
 *   → { "id": 9, "op": "mkdir",          "args": { "path": "build" } }
 *   → { "id":10, "op": "list_tasks" }
 *
 *   ← { "id": 1, "ok": true,  "result": { … creature response … } }
 *   ← { "id": 2, "ok": false, "error": "no sandbox creature bound to this space" }
 *
 * Every op maps 1:1 onto a `sandbox` action (see its tool.py). The
 * platform pins `space_id` into every call through the catalog's `defaults`,
 * so an agent can never reach another space's sandbox by naming a different
 * id — same guarantee as `caspar__sandbox` reached via MCP.
 *
 * Cancellation: closing the client socket kills all pending requests for that
 * connection. The grok CLI cancels a turn by dropping the socket, which is why
 * we don't need per-request cancel tokens on the wire.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** Ops the Rust backend is allowed to invoke. */
const ALLOWED_OPS = new Set([
  "exec",
  "exec_background",
  "get_output",
  "kill_task",
  "wait_completion",
  "list_tasks",
  "read",
  "write",
  "mkdir",
  "list_dir",
  "info",
]);

/**
 * Map an incoming op to the `function` field on the creature signal. Grok's
 * backend uses `wait_completion`/`kill_task` (mirroring the `TerminalBackend`
 * trait it implements), while the sandbox creature exposes them as
 * `wait_exec`/`kill_exec`. The two vocabularies converge here.
 */
const OP_TO_FUNCTION = {
  exec: "exec",
  exec_background: "exec_background",
  get_output: "get_output",
  kill_task: "kill_exec",
  wait_completion: "wait_exec",
  list_tasks: "list_tasks",
  read: "read",
  write: "write",
  mkdir: "mkdir",
  list_dir: "list_dir",
  info: "info",
};

/**
 * Pick the space's sandbox creature out of the tool catalog. Matches the
 * heuristic runtime.mjs uses for the "shared environment" system-prompt hint:
 * `category === "execution"` or a sandbox-shaped `name` — no hardcoded
 * program id, so a rename or a re-mint doesn't require code changes here.
 *
 * Returns the MCP tool NAME (the key the invoker resolves through `byName`)
 * or `null` when no sandbox is attached (nothing to swap the backend for).
 */
export function detectSandboxTool(toolDefs, byName) {
  for (const t of toolDefs || []) {
    const entry = byName?.get(t.name) || {};
    const category = String(entry.category || "").toLowerCase();
    const name = String(entry.name || t.name || "").toLowerCase();
    if (category === "execution" || /sandbox/.test(name)) return t.name;
  }
  return null;
}

export class SandboxBridgeServer {
  /**
   * @param socketPath  where to bind (a unix domain socket path)
   * @param invoker     a live `ToolInvoker`
   * @param toolName    the MCP name of the sandbox tool (from `detectSandboxTool`)
   */
  constructor(socketPath, invoker, toolName) {
    this.socketPath = socketPath;
    this.invoker = invoker;
    this.toolName = toolName;
    this.server = null;
    this.sockets = new Set();
    this.pending = new Set(); // in-flight ops we can drain on stop
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this._onConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    // Never keep the runtime alive on an idle sandbox socket — the whole point
    // is that the grok child owns the lifetime.
    this.server.unref();
    return this;
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        // Dispatch each request as a detached promise so a slow op does not
        // block the next line on the same connection — grok issues many
        // read/exec calls in parallel and expects them to overlap.
        this._dispatch(socket, request);
      }
    });
  }

  _dispatch(socket, request) {
    const id = request?.id ?? null;
    const inflight = this._handle(request).then(
      (response) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...response })}\n`);
      },
      (err) => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify({ id, ok: false, error: err?.message || String(err) })}\n`);
        }
      },
    );
    this.pending.add(inflight);
    inflight.finally(() => this.pending.delete(inflight));
  }

  async _handle(request) {
    const op = String(request?.op || "");
    if (!ALLOWED_OPS.has(op)) return { ok: false, error: `unknown op ${op}` };
    if (!this.toolName) return { ok: false, error: "no sandbox creature bound to this space" };
    const args = request?.args && typeof request.args === "object" ? { ...request.args } : {};
    // The catalog entry's routing `function` is honoured only when the caller
    // didn't specify one; grok's backend calls with the op it knows, so we
    // stamp the mapped function here rather than relying on the model to.
    args.function = OP_TO_FUNCTION[op] || op;
    let reply;
    try {
      reply = await this.invoker.invoke(this.toolName, args);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
    // ToolInvoker.invoke returns `{ ok: false, error }` on a routing/timeout
    // failure and `{ ok: true, response }` on success — where `response` is
    // whatever the creature signalled back. Unwrap so the Rust backend sees a
    // stable envelope regardless of failure layer.
    if (!reply || reply.ok === false) {
      return { ok: false, error: reply?.error || "sandbox invocation failed", ack: reply?.ack };
    }
    return { ok: true, result: reply.response };
  }

  async stop() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    // Give in-flight ops a chance to reply before we tear the socket down;
    // grok's Rust backend is fine with a socket close after the write.
    if (this.pending.size) {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}
