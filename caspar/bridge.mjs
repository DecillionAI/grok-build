/**
 * Docker-host bridge gateway client.
 *
 * When this container runs as a Caspar `docker` creature it is sandboxed on the
 * gateway docker network with **no other route to the outside world**. Its only
 * channel is a single long-lived TCP connection to the node's *docker-host
 * bridge gateway*. Over that one connection the container performs every
 * interaction with the node — persisting through DB ops, making outbound HTTP
 * calls, signalling sibling creatures — and receives pushed signals from other
 * creatures.
 *
 * This module implements the gateway's chunked wire protocol (mirroring the Rust
 * node's `drivers/vmm/network/docker_host`) and a small, thread-safe client:
 *
 *   [u32 BE frame_len][frame body]
 *   frame body = [u8 op][u64 BE msg_id][u64 BE corr_id][u32 BE seq][u32 BE total][chunk]
 *
 * A logical message larger than `MAX_CHUNK` is split across several frames that
 * share `msg_id` and are reassembled by the receiver.
 *
 * The container declares NOTHING about its identity and holds no secret: the
 * node resolves the identity from the connection's docker-network source IP and
 * reports it back in the WELCOME handshake. Dependency-free (node built-ins).
 */

import net from "node:net";

// ── Opcodes (must match the node) ────────────────────────────────────────────
export const OP_HELLO = 0x01;
export const OP_WELCOME = 0x02;
export const OP_REQUEST = 0x10;
export const OP_RESPONSE = 0x11;
export const OP_SIGNAL = 0x20;
export const OP_PING = 0x30;
export const OP_PONG = 0x31;
export const OP_ERROR = 0x40;

export const HEADER_LEN = 1 + 8 + 8 + 4 + 4; // op + msg_id + corr_id + seq + total
export const MAX_CHUNK = 64 * 1024;
export const MAX_FRAME = 32 * 1024 * 1024;

export class BridgeError extends Error {}

/** Encode one logical message as the frames that carry it. */
export function encodeFrames(opcode, corrId, value) {
  const payload =
    value === undefined || value === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), "utf-8");
  const total = Math.max(1, Math.ceil(payload.length / MAX_CHUNK));
  const frames = [];
  // One id for the whole logical message: it is what the receiver reassembles the
  // chunks by, so every frame of this message must carry the same one.
  const msgId = nextMessageId();
  for (let seq = 0; seq < total; seq++) {
    const chunk = payload.subarray(seq * MAX_CHUNK, (seq + 1) * MAX_CHUNK);
    const body = Buffer.alloc(HEADER_LEN + chunk.length);
    body.writeUInt8(opcode, 0);
    body.writeBigUInt64BE(BigInt(msgId), 1);
    body.writeBigUInt64BE(BigInt(corrId), 9);
    body.writeUInt32BE(seq, 17);
    body.writeUInt32BE(total, 21);
    chunk.copy(body, HEADER_LEN);
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    frames.push(frame);
  }
  return frames;
}

let _messageId = 1;
function nextMessageId() {
  return _messageId++;
}

/**
 * Client for the docker-host bridge gateway.
 *
 * Inbound frames are reassembled into logical messages; RESPONSE/WELCOME/PONG/
 * ERROR messages resolve the caller waiting on their correlation id, and SIGNAL
 * messages are delivered to every registered listener.
 */
export class CasparBridgeClient {
  constructor(host, port, { timeoutMs = 60000 } = {}) {
    this.host = host;
    this.port = Number(port);
    this.timeoutMs = timeoutMs;

    // Node-assigned (authoritative) identity, adopted from WELCOME.
    this.vmId = "";
    this.machineId = "";
    this.programId = "";
    this.creatureId = "";
    this.sessionId = null;

    this._socket = null;
    this._nextCorr = 1;
    this._pending = new Map(); // corrId -> {resolve, timer}
    this._partials = new Map(); // msgId -> {total, chunks, op, corr}
    this._listeners = new Set();
    // Signals received before any listener is registered are buffered here and
    // replayed to the first listener. The node flushes packets it queued while
    // the container was cold right after WELCOME, and those can be read in the
    // same batch — before the serve loop subscribes — so without this they would
    // be dropped and the caller would hang.
    this._earlySignals = [];
    this._earlySignalsCap = 512;
    this._buffer = Buffer.alloc(0);
    this._closed = false;
    // Liveness: `true` between a successful handshake and the socket dropping.
    // A serving creature watches this (and `onClose`) so it can reconnect when
    // the gateway link dies instead of staying alive but unreachable forever.
    this._connected = false;
    this._closeListeners = new Set();
  }

  // -- lifecycle ------------------------------------------------------------
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const onError = (err) => {
        socket.destroy();
        reject(new BridgeError(`gateway connect failed: ${err.message}`));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this._socket = socket;
        socket.on("data", (chunk) => this._onData(chunk));
        socket.on("error", () => this._handleDisconnect());
        socket.on("close", () => this._handleDisconnect());
        resolve();
      });
    });
    await this._handshake();
    this._connected = true;
    return this;
  }

  /** True while the gateway link is live (handshaken and not dropped/closed). */
  isConnected() {
    return this._connected && !this._closed && this._socket != null;
  }

  /**
   * Register a callback fired once when the gateway link drops **unexpectedly**
   * (socket error/close), not on an intentional `close()`. Lets a serving
   * creature wake immediately and reconnect. Returns an unsubscribe function.
   */
  onClose(cb) {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

  /** Socket dropped: fail in-flight calls and, if unexpected, notify watchers once. */
  _handleDisconnect() {
    this._failAllPending();
    if (this._closed || !this._connected) return; // intentional close, or never up
    this._connected = false;
    for (const cb of [...this._closeListeners]) {
      try {
        cb();
      } catch {
        /* a broken watcher must not break disconnect handling */
      }
    }
  }

  async _handshake() {
    // HELLO carries no identity — the node resolves it from our source IP.
    const res = await this._exchange(OP_HELLO, {}, this.timeoutMs, "handshake");
    if (!res || typeof res !== "object" || res.ok !== true) {
      throw new BridgeError(`handshake rejected: ${JSON.stringify(res)}`);
    }
    this.sessionId = res.sessionId ?? null;
    this.vmId = res.vmId || "";
    this.machineId = res.machineId || "";
    this.programId = res.programId || "";
    this.creatureId = res.creatureId || "";
    return res;
  }

  close() {
    this._closed = true;
    this._connected = false;
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this._failAllPending();
  }

  // -- signal handling ------------------------------------------------------
  /**
   * Register a listener invoked as `listener(key, data)` for every pushed
   * signal. Returns an unsubscribe function — unlike a single-handler slot,
   * concurrent consumers (the task capturer and a running tool invoker) coexist
   * without overwriting each other.
   */
  onSignal(listener) {
    const wasEmpty = this._listeners.size === 0;
    this._listeners.add(listener);
    // Replay anything that arrived before a listener existed, in order, to the
    // listener that just registered.
    if (wasEmpty && this._earlySignals.length) {
      const buffered = this._earlySignals;
      this._earlySignals = [];
      for (const [key, data] of buffered) {
        try {
          listener(key, data);
        } catch {
          // A broken listener must never break replay.
        }
      }
    }
    return () => this._listeners.delete(listener);
  }

  // -- host calls -----------------------------------------------------------
  /**
   * Invoke a node host function and return its parsed JSON result.
   *
   * `op` is any of the node's unified host-function names (`dbOp`,
   * `httpRequest`, `signal`, `signalUser`, `runVm`, …). The node stamps the
   * connection's verified identity onto the request, so callers never pass
   * `vmId`/`programId` themselves.
   */
  call(op, input = {}, { timeoutMs } = {}) {
    return this._exchange(OP_REQUEST, { op, input: input || {} }, timeoutMs ?? this.timeoutMs, `host call '${op}'`);
  }

  /** Push a `key` signal carrying `packet` onto another creature's connection. */
  signalUser(key, userId, packet, opts = {}) {
    return this.call(
      "signalUser",
      { key, userId, packet: typeof packet === "string" ? packet : JSON.stringify(packet) },
      opts,
    );
  }

  signalGroup(key, groupId, packet, exceptIds = [], opts = {}) {
    return this.call(
      "signalGroup",
      {
        key,
        groupId,
        packet: typeof packet === "string" ? packet : JSON.stringify(packet),
        except: exceptIds,
      },
      opts,
    );
  }

  dbPut(key, val, extra = {}) {
    return this.call("dbOp", { op: "put", key, val, ...extra });
  }

  dbGet(key, extra = {}) {
    return this.call("dbOp", { op: "get", key, ...extra });
  }

  dbDel(key, extra = {}) {
    return this.call("dbOp", { op: "del", key, ...extra });
  }

  /** Make an outbound HTTP request *through the node*. */
  httpRequest(url, { method = "GET", headers, body, timeoutMs } = {}) {
    const payload = { url, method };
    if (headers) payload.headers = headers;
    if (body !== undefined) payload.body = body;
    return this.call("httpRequest", payload, { timeoutMs });
  }

  ping({ timeoutMs } = {}) {
    return this._exchange(OP_PING, {}, timeoutMs ?? this.timeoutMs, "ping");
  }

  // -- internals ------------------------------------------------------------
  _exchange(opcode, value, timeoutMs, label) {
    if (!this._socket) return Promise.reject(new BridgeError("not connected"));
    const corr = this._nextCorr++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(corr);
        reject(new BridgeError(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // `unref` keeps a pending host call from holding the event loop open on
      // shutdown; the serve loop's own lifetime governs the process.
      if (typeof timer.unref === "function") timer.unref();
      this._pending.set(corr, { resolve, reject, timer });
      try {
        for (const frame of encodeFrames(opcode, corr, value)) this._socket.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(corr);
        reject(new BridgeError(`${label} write failed: ${err.message}`));
      }
    });
  }

  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    for (;;) {
      if (this._buffer.length < 4) return;
      const frameLen = this._buffer.readUInt32BE(0);
      if (frameLen === 0) {
        // Zero-length keep-alive frame.
        this._buffer = this._buffer.subarray(4);
        continue;
      }
      if (frameLen > MAX_FRAME || frameLen < HEADER_LEN) {
        // Unparseable stream: drop the connection rather than desynchronise.
        this.close();
        return;
      }
      if (this._buffer.length < 4 + frameLen) return;
      const body = this._buffer.subarray(4, 4 + frameLen);
      this._buffer = this._buffer.subarray(4 + frameLen);
      this._dispatchFrame(body);
    }
  }

  _dispatchFrame(body) {
    const opcode = body.readUInt8(0);
    const msgId = Number(body.readBigUInt64BE(1));
    const corr = Number(body.readBigUInt64BE(9));
    const seq = body.readUInt32BE(17);
    const total = body.readUInt32BE(21);
    const chunk = body.subarray(HEADER_LEN);
    if (total <= 1) {
      this._onMessage(opcode, corr, chunk);
      return;
    }
    let part = this._partials.get(msgId);
    if (!part) {
      part = { total, chunks: new Map() };
      this._partials.set(msgId, part);
    }
    part.chunks.set(seq, Buffer.from(chunk));
    if (part.chunks.size < total) return;
    this._partials.delete(msgId);
    const ordered = [];
    for (let i = 0; i < total; i++) ordered.push(part.chunks.get(i) ?? Buffer.alloc(0));
    this._onMessage(opcode, corr, Buffer.concat(ordered));
  }

  _onMessage(opcode, corr, payload) {
    let value = null;
    if (payload.length) {
      const text = payload.toString("utf-8");
      try {
        value = JSON.parse(text);
      } catch {
        value = { raw: text };
      }
    }
    if (opcode === OP_RESPONSE || opcode === OP_WELCOME || opcode === OP_PONG || opcode === OP_ERROR) {
      const waiter = this._pending.get(corr);
      if (waiter) {
        this._pending.delete(corr);
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
      return;
    }
    if (opcode === OP_SIGNAL && value && typeof value === "object") {
      const key = value.key ?? "";
      const data = value.data;
      if (this._listeners.size === 0) {
        // No listener yet: buffer for replay on the first `onSignal`, bounded so a
        // misbehaving peer cannot grow it without limit.
        if (this._earlySignals.length < this._earlySignalsCap) this._earlySignals.push([key, data]);
        return;
      }
      for (const listener of [...this._listeners]) {
        try {
          listener(key, data);
        } catch {
          // A broken listener must never kill the read path.
        }
      }
    }
  }

  /** Wake every waiter so a dropped connection fails fast instead of hanging. */
  _failAllPending() {
    for (const [corr, waiter] of [...this._pending]) {
      this._pending.delete(corr);
      clearTimeout(waiter.timer);
      waiter.reject(new BridgeError("gateway connection closed"));
    }
  }
}

/**
 * Build a client from the env the node injects at container start.
 *
 * The node provides only the gateway address; the container's identity is
 * resolved server-side from the connection's docker-network source IP. Returns
 * `null` when `CASPAR_GATEWAY_HOST` is unset (i.e. not running as a
 * gateway-managed docker creature), so callers can fall back gracefully.
 */
export async function bridgeFromEnv({ connect = true, timeoutMs = 60000, env = process.env } = {}) {
  const host = (env.CASPAR_GATEWAY_HOST || "").trim();
  if (!host) return null;
  const port = Number((env.CASPAR_GATEWAY_PORT || "8079").trim() || "8079");
  const client = new CasparBridgeClient(host, port, { timeoutMs });
  if (connect) await client.connect();
  return client;
}
