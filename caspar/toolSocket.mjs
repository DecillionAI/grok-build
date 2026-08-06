/**
 * The runtime ↔ MCP-server channel.
 *
 * Grok reaches the space's creatures through an MCP server, and that MCP
 * server has to run as its own process (Grok spawns it over stdio). But
 * the *gateway connection* — the container's single channel to the node — is
 * owned by this runtime process, and a second connection would be a second
 * identity claim on the same container. So the MCP server does not talk to the
 * node at all: it forwards each `tools/call` to this runtime over a unix socket,
 * and the runtime does the signalling.
 *
 * The wire is newline-delimited JSON, one request per line:
 *
 *   → { "id": 1, "op": "list" }                    ← { "id": 1, "ok": true, "tools": [...] }
 *   → { "id": 2, "op": "call", "name": …, "args": … } ← { "id": 2, "ok": true, "result": … }
 *
 * The socket lives in a private per-run directory, so it is reachable only from
 * inside this container.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export class ToolSocketServer {
  /**
   * @param socketPath where to bind (a unix domain socket path)
   * @param handlers   `{ list(): tools[], call(name, args): Promise<any> }`
   */
  constructor(socketPath, handlers) {
    this.socketPath = socketPath;
    this.handlers = handlers;
    this.server = null;
    this.sockets = new Set();
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
    // A stray socket file must never keep the runtime alive.
    this.server.unref();
    return this;
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    let buffer = "";
    socket.on("data", async (chunk) => {
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
        const response = await this._handle(request);
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  }

  async _handle(request) {
    const id = request?.id ?? null;
    try {
      if (request?.op === "list") return { id, ok: true, tools: this.handlers.list() };
      if (request?.op === "call") {
        const result = await this.handlers.call(String(request.name || ""), request.args || {});
        return { id, ok: true, result };
      }
      return { id, ok: false, error: `unknown op ${request?.op}` };
    } catch (err) {
      return { id, ok: false, error: err?.message || String(err) };
    }
  }

  async stop() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
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

/** Minimal client for the socket above (used by the MCP server process). */
export class ToolSocketClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        this.socket = socket;
        socket.on("data", (chunk) => this._onData(chunk));
        socket.on("close", () => this._failAll("tool socket closed"));
        socket.on("error", () => this._failAll("tool socket error"));
        resolve();
      });
    });
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf-8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      waiter(message);
    }
  }

  _failAll(reason) {
    for (const waiter of this.pending.values()) waiter({ ok: false, error: reason });
    this.pending.clear();
  }

  request(op, extra = {}) {
    if (!this.socket) return Promise.resolve({ ok: false, error: "not connected" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    });
  }
}
