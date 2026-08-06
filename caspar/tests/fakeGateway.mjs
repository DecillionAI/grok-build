/**
 * A fake docker-host bridge gateway — the node's side of `caspar/bridge.mjs`.
 *
 * It speaks the real chunked wire protocol (HELLO/WELCOME, REQUEST/RESPONSE,
 * SIGNAL, PING/PONG) so the checks exercise the actual framing, chunk reassembly
 * and correlation logic instead of a mock. Host calls are recorded, and the test
 * can push signals at the creature exactly as the node would.
 */

import net from "node:net";

import { HEADER_LEN, MAX_CHUNK, OP_HELLO, OP_PING, OP_PONG, OP_REQUEST, OP_RESPONSE, OP_SIGNAL, OP_WELCOME } from "../bridge.mjs";

let messageId = 1;

function encode(opcode, corr, value) {
  const payload = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), "utf-8");
  const total = Math.max(1, Math.ceil(payload.length / MAX_CHUNK));
  const frames = [];
  const id = messageId++;
  for (let seq = 0; seq < total; seq++) {
    const chunk = payload.subarray(seq * MAX_CHUNK, (seq + 1) * MAX_CHUNK);
    const body = Buffer.alloc(HEADER_LEN + chunk.length);
    body.writeUInt8(opcode, 0);
    body.writeBigUInt64BE(BigInt(id), 1);
    body.writeBigUInt64BE(BigInt(corr), 9);
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

export class FakeGateway {
  /**
   * @param identity what WELCOME reports back (the node resolves it by source IP)
   * @param onCall   optional `(op, input) => result | Promise<result>` override
   */
  constructor({ identity = {}, onCall } = {}) {
    this.identity = { vmId: "vm-1", machineId: "7@global", programId: "7@global", creatureId: "6@global", ...identity };
    this.onCall = onCall;
    this.calls = [];
    this.sockets = new Set();
    this.server = net.createServer((socket) => this._onConnection(socket));
    this.port = 0;
  }

  /** @param host bind address — `0.0.0.0` when a container has to reach it. */
  async listen({ host = "127.0.0.1", port = 0 } = {}) {
    await new Promise((resolve) => this.server.listen(port, host, resolve));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Deliver a pushed signal to every connected creature. */
  pushSignal(key, data) {
    for (const socket of this.sockets) {
      for (const frame of encode(OP_SIGNAL, 0, { key, data })) socket.write(frame);
    }
  }

  /** Every `signalUser` host call made by the creature, in order. */
  signals() {
    return this.calls.filter((c) => c.op === "signalUser").map((c) => ({ ...c.input, packet: JSON.parse(c.input.packet) }));
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    const partials = new Map();
    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) return;
        const body = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        const opcode = body.readUInt8(0);
        const msgId = Number(body.readBigUInt64BE(1));
        const corr = Number(body.readBigUInt64BE(9));
        const seq = body.readUInt32BE(17);
        const total = body.readUInt32BE(21);
        const piece = body.subarray(HEADER_LEN);
        let payload = piece;
        if (total > 1) {
          let part = partials.get(msgId);
          if (!part) {
            part = { chunks: new Map(), total };
            partials.set(msgId, part);
          }
          part.chunks.set(seq, Buffer.from(piece));
          if (part.chunks.size < total) continue;
          partials.delete(msgId);
          payload = Buffer.concat([...Array(total).keys()].map((i) => part.chunks.get(i)));
        }
        await this._onMessage(socket, opcode, corr, payload);
      }
    });
  }

  async _onMessage(socket, opcode, corr, payload) {
    const value = payload.length ? JSON.parse(payload.toString("utf-8")) : {};
    if (opcode === OP_HELLO) {
      for (const frame of encode(OP_WELCOME, corr, { ok: true, sessionId: 42, ...this.identity })) socket.write(frame);
      return;
    }
    if (opcode === OP_PING) {
      for (const frame of encode(OP_PONG, corr, { ok: true })) socket.write(frame);
      return;
    }
    if (opcode !== OP_REQUEST) return;
    const { op, input } = value;
    this.calls.push({ op, input });
    let result = { ok: true };
    if (this.onCall) {
      try {
        result = (await this.onCall(op, input, this)) ?? { ok: true };
      } catch (err) {
        result = { ok: false, error: err?.message || String(err) };
      }
    }
    for (const frame of encode(OP_RESPONSE, corr, result)) socket.write(frame);
  }
}
