/**
 * Employing a sibling tool creature — purely over the gateway.
 *
 * To invoke a tool this creature pushes a `creatures/signal` to the tool's
 * machine (`signalUser`); the node delivers it to the tool's container over *its*
 * gateway connection, cold-spawning the container when no live one exists. The
 * tool runs and signals its result back on the same key, which the node pushes
 * onto our connection. Requests and replies are paired by `correlationId`.
 *
 * The invoke envelope matches the tool runtime the davinci tool creatures use:
 *
 *     { kind: "invoke", entityId, correlationId, reply_to, tool_id, function, payload }
 *
 * and the reply is `{ kind: "tools/result", correlationId, result }`.
 *
 * `entityId` is REQUIRED for a cold spawn: with no live tool connection the
 * node's machine listener resolves the per-entity docker image via
 * `vmEntityPath::<machine>::<entityId>`. Without it the spawn falls back to the
 * program default, the image is never located, and the caller just times out.
 */

import crypto from "node:crypto";

import { mergeArgs } from "./catalog.mjs";

/** Default reply window: a cold spawn under gVisor routinely takes >1 min. */
import { creatureNumber } from "./env.mjs";

const DEFAULT_TIMEOUT_SECONDS = creatureNumber("TOOL_TIMEOUT", 240);

export class ToolInvoker {
  /**
   * @param bridge   connected `CasparBridgeClient`
   * @param byName   MCP tool name → catalog entry (from `buildToolDefinitions`)
   * @param selfId   this creature's node-assigned id, used as `reply_to`
   */
  constructor(bridge, byName, selfId) {
    this.bridge = bridge;
    this.byName = byName;
    this.selfId = selfId;
    this.waiters = new Map(); // correlationId -> resolve
    this.unsubscribe = bridge.onSignal((key, data) => this._onSignal(key, data));
  }

  _onSignal(key, data) {
    if (key !== "creatures/signal") return;
    // A tool result may arrive as the packet itself or wrapped in a StoresSend
    // whose `data` is the packet's JSON string.
    let packet = data;
    if (packet && typeof packet === "object" && typeof packet.data === "string") {
      try {
        packet = JSON.parse(packet.data);
      } catch {
        return;
      }
    }
    if (!packet || typeof packet !== "object" || packet.kind !== "tools/result") return;
    const cid = String(packet.correlationId || "");
    const resolve = this.waiters.get(cid);
    if (!resolve) return;
    this.waiters.delete(cid);
    resolve(packet.result);
  }

  dispose() {
    if (this.unsubscribe) this.unsubscribe();
    for (const resolve of this.waiters.values()) resolve({ ok: false, error: "runtime shut down" });
    this.waiters.clear();
  }

  /**
   * Invoke a catalog tool by its MCP name. Never throws: a failed employment is
   * returned as `{ ok: false, error }` so the model sees the failure and can
   * react, exactly as it would for any tool error.
   */
  async invoke(name, args) {
    const entry = this.byName.get(name);
    if (!entry) return { ok: false, error: `unknown tool creature ${name}` };
    const target = entry.program_id || entry.programId || entry.machine_id || entry.tool_id || entry.creature_id || "";
    if (!target) return { ok: false, error: `no target machine for tool ${name}` };

    const payload = mergeArgs(entry, args);
    const entityId = entry.entity_id || entry.entityId || entry.tool_id || name;
    // The model may name a function for a multi-function creature; the catalog's
    // routing function is the default.
    const fn = payload.function || entry.function || "invoke";
    const correlationId = crypto.randomBytes(16).toString("hex");
    const packet = {
      kind: "invoke",
      entityId,
      correlationId,
      reply_to: this.selfId,
      tool_id: entry.tool_id || entry.programId || target,
      function: String(fn),
      payload,
    };

    const timeoutMs = Number(entry.max_exec_seconds || entry.maxExecSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
    const settled = new Promise((resolve) => this.waiters.set(correlationId, resolve));
    let ack;
    try {
      ack = await this.bridge.signalUser("creatures/signal", String(target), packet);
    } catch (err) {
      this.waiters.delete(correlationId);
      return { ok: false, error: `bridge signal failed: ${err.message}` };
    }
    if (ack && typeof ack === "object" && ack.ok === false) {
      this.waiters.delete(correlationId);
      return { ok: false, error: "node rejected the tool signal", ack };
    }

    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const result = await Promise.race([settled, timedOut]);
      if (result === TIMED_OUT) {
        this.waiters.delete(correlationId);
        return { ok: false, error: `tool creature ${name} did not reply within ${timeoutMs / 1000}s` };
      }
      return { ok: true, tool: name, function: String(fn), response: result };
    } finally {
      clearTimeout(timer);
    }
  }
}

const TIMED_OUT = Symbol("tool-timeout");
