#!/usr/bin/env node
/**
 * The `caspar` MCP server — how Grok employs the space's creatures.
 *
 * Grok spawns this process over stdio (it is the `[mcp_servers.caspar]` entry the
 * bridge writes into the run's config.toml) and speaks MCP
 * JSON-RPC to it. Every `tools/call` is forwarded to the runtime process over the
 * unix socket in `CASPAR_TOOL_SOCKET`, which signals the target creature through
 * the node's gateway and returns its reply. The tool list is likewise served by
 * the runtime, so it always reflects the catalog of the prompt being answered.
 *
 * JSON-RPC is hand-rolled (~1 file, no dependencies) on purpose: the creature
 * image should not need this repo's dependency tree to be installable, and the
 * three methods a tool-only server needs — `initialize`, `tools/list`,
 * `tools/call` — are small enough to implement exactly.
 *
 * Env:
 *   CASPAR_TOOL_SOCKET  unix socket of the runtime's tool bridge (required)
 */

import { ToolSocketClient } from "./toolSocket.mjs";

const SUPPORTED_PROTOCOL = "2024-11-05";
const SERVER_INFO = { name: "caspar", version: "1.0.0" };

const socketPath = (process.env.CASPAR_TOOL_SOCKET || "").trim();

const client = socketPath ? new ToolSocketClient(socketPath) : null;
let connected = false;

async function ensureConnected() {
  if (!client || connected) return connected;
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    process.stderr.write(`[caspar-mcp] cannot reach the runtime tool bridge: ${err?.message || err}\n`);
  }
  return connected;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

/** MCP `tools/call` results are content blocks; `isError` reports a failure. */
function toolContent(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: "text", text }], isError };
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      // Echo the client's protocol version when it names one, so we never claim a
      // revision the client cannot speak.
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : SUPPORTED_PROTOCOL;
      respond(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification: nothing to answer
    case "ping":
      if (!isNotification) respond(id, {});
      return;
    case "tools/list": {
      if (!(await ensureConnected())) {
        respond(id, { tools: [] });
        return;
      }
      const res = await client.request("list");
      respond(id, { tools: Array.isArray(res?.tools) ? res.tools : [] });
      return;
    }
    case "tools/call": {
      const name = String(params?.name || "");
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      if (!(await ensureConnected())) {
        respond(id, toolContent({ ok: false, error: "the creature's tool bridge is unavailable" }, true));
        return;
      }
      const res = await client.request("call", { name, args });
      if (!res?.ok) {
        respond(id, toolContent({ ok: false, error: res?.error || "tool call failed" }, true));
        return;
      }
      const result = res.result;
      const failed = result && typeof result === "object" && result.ok === false;
      respond(id, toolContent(result, Boolean(failed)));
      return;
    }
    // Tool-only server: declare nothing else, and answer the optional listings
    // empty rather than erroring, which some clients treat as a broken server.
    case "resources/list":
      if (!isNotification) respond(id, { resources: [] });
      return;
    case "prompts/list":
      if (!isNotification) respond(id, { prompts: [] });
      return;
    default:
      if (!isNotification) respondError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message).catch((err) => {
      if (message?.id !== undefined && message?.id !== null) {
        respondError(message.id, -32603, err?.message || String(err));
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));
