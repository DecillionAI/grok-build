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

/**
 * Default reply window for a tool signal, raised to comfortably exceed the
 * longest a served tool can legitimately take to answer.
 *
 * This is the waiter on the backbone→tool hop. It MUST be longer than the
 * tool's own internal work budget, or the invoker gives up while the tool is
 * still running and the model sees a dead call. The per-space sandbox is the
 * binding case: its `exec` runs up to SANDBOX_EXEC_TIMEOUT_MS (300s)
 * with an HTTP read timeout of exec+HTTP_TIMEOUT (~360s), so a 240s waiter was
 * shorter than the work — `npm install` / a build / a large push would stall.
 * A catalog entry may still shorten (or lengthen) this per tool via
 * `max_exec_seconds`.
 */
const DEFAULT_TIMEOUT_SECONDS = creatureNumber("TOOL_TIMEOUT", 420);

/** Greppable one-line trace of a tool call's lifecycle, for the VM logs. */
function traceToolCall(event) {
  try {
    process.stdout.write(`GROK_TOOL_CALL ${JSON.stringify(event)}\n`);
  } catch {
    /* logging must never break a tool call */
  }
}

export class ToolInvoker {
  /**
   * @param bridge   connected `CasparBridgeClient`
   * @param byName   MCP tool name → catalog entry (from `buildToolDefinitions`)
   * @param selfId   this creature's node-assigned id, used as `reply_to`
   */
  constructor(bridge, byName, selfId, options = {}) {
    this.bridge = bridge;
    this.byName = byName;
    this.selfId = selfId;
    this.waiters = new Map(); // correlationId -> resolve
    this.usage = [];
    this.authorizedToolIds = options.authorizedToolIds
      ? new Set(options.authorizedToolIds.map(String))
      : null;
    this.unsubscribe = bridge.onSignal((key, data) => this._onSignal(key, data));
  }

  usageSnapshot() {
    return this.usage.map((row) => ({ ...row }));
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
  async invoke(name, args, options = {}) {
    const entry = this.byName.get(name);
    if (!entry) return { ok: false, error: `unknown tool creature ${name}` };
    const target = entry.program_id || entry.programId || entry.machine_id || entry.tool_id || entry.creature_id || "";
    if (!target) return { ok: false, error: `no target machine for tool ${name}` };
    if (this.authorizedToolIds && !this.authorizedToolIds.has(String(target))) {
      return { ok: false, error: `tool ${name} is not authorized by this billing quote` };
    }

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
    const startedAt = Date.now();
    // Trace at start: which tool, which function, the waiter budget, the target.
    // A run that stalls on a tool call is now pinpointed from the VM logs — the
    // matching GROK_TOOL_CALL "done"/"timeout" line (same correlationId) shows
    // whether the tool replied and how long it took, instead of guessing.
    traceToolCall({ phase: "start", tool: name, function: String(fn), target: String(target), timeoutMs, correlationId });
    const settled = new Promise((resolve) => this.waiters.set(correlationId, resolve));
    let ack;
    try {
      ack = await this.bridge.signalUser("creatures/signal", String(target), packet);
    } catch (err) {
      this.waiters.delete(correlationId);
      traceToolCall({ phase: "signal_failed", tool: name, correlationId, ms: Date.now() - startedAt, error: String(err?.message || err) });
      return { ok: false, error: `bridge signal failed: ${err.message}` };
    }
    if (ack && typeof ack === "object" && ack.ok === false) {
      this.waiters.delete(correlationId);
      traceToolCall({ phase: "node_rejected", tool: name, correlationId, ms: Date.now() - startedAt });
      return { ok: false, error: "node rejected the tool signal", ack };
    }

    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const result = await Promise.race([settled, timedOut]);
      if (result === TIMED_OUT) {
        if (options.billable !== false) {
          this.usage.push({
            resourceId: String(target),
            calls: 1,
            runtimeMs: Date.now() - startedAt,
            outcome: "timeout",
          });
        }
        this.waiters.delete(correlationId);
        traceToolCall({ phase: "timeout", tool: name, function: String(fn), correlationId, ms: Date.now() - startedAt });
        return { ok: false, error: `tool creature ${name} did not reply within ${timeoutMs / 1000}s` };
      }
      if (options.billable !== false) {
        this.usage.push({
          resourceId: String(target),
          calls: 1,
          runtimeMs: Date.now() - startedAt,
          outcome: result && typeof result === "object" && result.ok === false ? "error" : "ok",
        });
      }
      traceToolCall({ phase: "done", tool: name, function: String(fn), correlationId, ms: Date.now() - startedAt });
      return { ok: true, tool: name, function: String(fn), response: result };
    } finally {
      clearTimeout(timer);
    }
  }
}

const TIMED_OUT = Symbol("tool-timeout");
