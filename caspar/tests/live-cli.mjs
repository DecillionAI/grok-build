#!/usr/bin/env node
/**
 * Live smoke check against a REAL Grok Build CLI.
 *
 * The offline checks (`checks.mjs`) use a fake CLI so they are fast and
 * deterministic. This one answers the other half of the question: does the real
 * CLI accept the flags this bridge passes, and does it actually connect to the
 * `caspar` MCP server and see the space's creatures? It reads the CLI's own
 * `system/init` message, which reports every MCP server and its status — so it is
 * meaningful even without API credentials (an unauthenticated run still boots,
 * connects its MCP servers, and then fails on the model call).
 *
 * Run: node caspar/tests/live-cli.mjs        (needs `grok` on PATH, or GROK_BIN)
 *      XAI_API_KEY=… node caspar/tests/live-cli.mjs   (also checks a real answer)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildToolDefinitions } from "../catalog.mjs";
import { runGrok } from "../grokRunner.mjs";
import { TrajectoryMapper } from "../events.mjs";
import { buildResult } from "../result.mjs";
import { ToolSocketServer } from "../toolSocket.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "caspar-live-"));
const socketPath = path.join(workspace, "tools.sock");

// One catalog entry, answered locally: no node, no tool creature, but the exact
// path a real employment takes (CLI → MCP server → unix socket → invoker).
const { tools } = buildToolDefinitions([
  {
    name: "space notebook",
    tool_id: "31@global",
    program_id: "31@global",
    entity_id: "notebook",
    description: "the project's shared notebook",
    arg_schema: { text: { type: "string", description: "what to write" } },
    required: ["text"],
    function: "write",
  },
]);

const employed = [];
const server = await new ToolSocketServer(socketPath, {
  list: () => tools,
  call: (name, args) => {
    employed.push({ name, args });
    return { ok: true, response: { written: args?.text ?? "" } };
  },
}).start();

const mcpServers = {
  caspar: { command: process.execPath, args: [path.join(HERE, "..", "mcpStdioServer.mjs")], env: { CASPAR_TOOL_SOCKET: socketPath }, startupTimeoutSec: 60 },
};

const mapper = new TrajectoryMapper();
const started = Date.now();
const run = await runGrok({
  // Space creatures are reached through Grok's `use_tool` meta-tool, so the prompt
  // names the qualified MCP tool the way the runtime's system prompt does.
  prompt: 'Write the words "caspar bridge lives" into the space notebook by calling use_tool with tool_name "caspar__space_notebook", then reply with just the word DONE.',
  systemPrompt: "You are a Decillion space agent under test. Be terse.",
  cwd: workspace,
  mcpServers,
  threadSlug: "live-smoke",
  maxWallSeconds: Number(process.env.GROK_LIVE_TIMEOUT || 180),
  onMessage: (message) => {
    for (const event of mapper.map(message)) console.log(`  [${event.channel}] ${event.message}`);
  },
});
await server.stop();

const init = run.messages.find((m) => m?.type === "system" && m.subtype === "init");
const result = buildResult("live smoke", run.result, mapper, {
  durationMs: Date.now() - started,
  timedOut: run.timedOut,
  exitCode: run.exitCode,
  stderr: run.stderr,
  initMessage: init,
  warnings: run.warnings,
});

console.log("\nargv:", run.argv.join(" ").slice(0, 400));
console.log("mcp servers:", JSON.stringify(init?.mcp_servers ?? null));
console.log("MCP meta-tools visible to the agent:", (init?.tools ?? []).filter((t) => ["use_tool", "search_tool"].includes(String(t))).join(", ") || "(none)");
console.log("employed:", JSON.stringify(employed));
console.log("result:", JSON.stringify({ success: result.success, answer: result.answer.slice(0, 200), usage: result.usage, model: result.model, error: result.error }));
fs.rmSync(workspace, { recursive: true, force: true });

if (!init) {
  console.log("\nFAIL: the CLI never emitted a system/init message — check `grok` is installed and the flags are accepted");
  process.exit(1);
}
// `system/init` may still say "pending" (MCP servers connect asynchronously), so
// the real proof is that the agent could see and employ the creature.
if (!employed.length) {
  console.log("\nFAIL: the agent never employed the space's creature through the caspar MCP server");
  process.exit(1);
}
console.log("\nPASS: the real CLI employed a space creature through the caspar MCP server");
if (!result.success) {
  console.log(`(the run itself did not succeed: ${result.error})`);
}
process.exit(0);
