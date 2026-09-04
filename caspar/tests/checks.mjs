#!/usr/bin/env node
process.env.NODE_ENV = "test";
process.env.GROK_CREATURE_TEST_UNBILLED = "1";

/**
 * Checks for the Caspar signaling bridge.
 *
 * These drive the REAL modules against a fake node gateway (which speaks the real
 * wire protocol) and a fake Grok CLI (which speaks the real Messages `stream-json`
 * lines Grok emits), so
 * every invariant the Decillion platform depends on is asserted end to end
 * without a node, a container or an LLM:
 *
 *   • the handshake adopts the node-assigned identity; large messages chunk and
 *     reassemble correctly;
 *   • a proxy-relayed prompt is decoded — skill, history, roster, correlation —
 *     and non-task signals are ignored;
 *   • the agent's skill, the group-chat context and the thread's history all
 *     reach the CLI, and the per-agent LLM override reaches its environment;
 *   • every step is streamed as `davinci/step` on the right channel, and exactly
 *     one terminal `davinci/result` is sent, through the proxy;
 *   • the result carries the answer, billable token usage and a non-array plan;
 *   • the space's creatures are employable over MCP, with platform-pinned
 *     arguments winning over the model's, and a tool added to a space appears on
 *     the next prompt (the catalog is per-prompt, not baked in);
 *   • a prompt delivered while another is being served is queued, not dropped;
 *   • a failed run, a run that never finishes, and a crashed CLI all still reply.
 *
 * Run: node caspar/tests/checks.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bridgeFromEnv } from "../bridge.mjs";
import { buildToolDefinitions, mergeArgs } from "../catalog.mjs";
import { renderConfigToml } from "../grokConfig.mjs";
import { applyLlmOverride, buildChildEnv, defaultLlm } from "../grokRunner.mjs";
import { resolveSpaceId } from "../discovery.mjs";
import { TrajectoryMapper } from "../events.mjs";
import { ProviderMediaGenerator } from "../mediaGeneration.mjs";
import { OutboundMediaCollector } from "../outboundMedia.mjs";
import { readUniversalInstruction, resetUniversalInstructionCache } from "../platformInstruction.mjs";
import {
  assignmentPreamble,
  buildSystemPrompt,
  buildUserPrompt,
  compactConversationBlock,
  planPreamble,
  teamDeltaBlock,
} from "../prompt.mjs";
import { fetchTeamActivitySince } from "../spaceHistory.mjs";
import { buildResult, normalizeUsage } from "../result.mjs";
import { buildHistoryTurns, fetchSpaceConversation, postSpaceSignal, readSpaceSignals, KIND } from "../spaceHistory.mjs";
import { decodeTaskSignal, sessionSlug, taskObjective, threadSessionId } from "../taskSignal.mjs";
import { ToolInvoker } from "../toolInvoker.mjs";
import { ToolSocketServer } from "../toolSocket.mjs";
import { FakeGateway } from "./fakeGateway.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAKE_CLI = path.join(HERE, "fakeGrok.mjs");
const MCP_SERVER = path.join(HERE, "..", "mcpStdioServer.mjs");

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let passed = 0;
const failures = [];
const cleanups = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`${GREEN}✓${NC} ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`${RED}✗${NC} ${name}\n  ${String(err?.stack || err).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A prompt exactly as the Decillion backend + node proxy deliver it. */
function proxyDelivery({ prompt = "What is the status of the deploy?", skill = "You are Tina, the release manager.", tools = [], history = [], correlationId = "corr-1", streamTo = "9@global", replyTo = "8@global", extra = {}, store = undefined } = {}) {
  const inner = {
    prompt,
    objective: prompt,
    streamTo,
    history,
    groupChat: true,
    self: { id: "res-tina", name: "Tina", handle: "tina" },
    roster: [
      { id: "res-tina", name: "Tina", handle: "tina", kind: "agent" },
      { id: "res-bob", name: "Bob", handle: "bob", kind: "agent" },
      { id: "u-1", name: "Shayan", handle: "shayan", kind: "user" },
    ],
    sessionId: "space:space-1:res-tina",
    spaceId: "space-1",
    config: { tools },
    ...extra,
    // stamped by the node's proxy entity on the way through
    skill,
    correlationId,
    replyTo,
    proxyProgramId: replyTo,
    proxyEntityId: "agent",
  };
  const envelope = { user: { id: replyTo }, action: "single", entityId: "davinci", correlationId, data: JSON.stringify(inner) };
  // The node stamps the originating store on the envelope (`store.id`); the
  // proxy relay carries it through untouched. Present only when the caller asks.
  if (store !== undefined) envelope.store = store;
  return { key: "creatures/signal", data: envelope };
}

function scenarioFile(scenario) {
  const dir = tempDir("caspar-scenario-");
  const file = path.join(dir, "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario));
  return { file, record: path.join(dir, "record.json") };
}

/** stream-json messages for a normal run: think → plan → act → observe → answer. */
function successScenario(answer = "The deploy is green.") {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "grok-build", cwd: "/w", tools: ["run_terminal_cmd", "read_file"], mcp_servers: [{ name: "caspar", status: "connected" }], permissionMode: "bypassPermissions", apiKeySource: "user" },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "They want the deploy status." }] }, session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "todo_write", input: { todos: [{ content: "check CI", status: "in_progress" }, { content: "report", status: "pending" }] } }] }, session_id: "sess-1" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "todos updated" }] }, session_id: "sess-1" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "run_terminal_cmd", input: { command: "git log -1" } }] }, session_id: "sess-1" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "abc123 fix the thing" }] }, session_id: "sess-1" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: answer,
        duration_ms: 1234,
        duration_api_ms: 1000,
        num_turns: 3,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 },
        modelUsage: { "grok-build": { inputTokens: 100 } },
        permission_denials: [],
        session_id: "sess-1",
      },
    ],
  };
}

// ── unit-level checks ────────────────────────────────────────────────────────

await check("a proxy-relayed prompt decodes into a task with its envelope intact", () => {
  const { key, data } = proxyDelivery();
  const decoded = decodeTaskSignal(key, data);
  assert.ok(decoded, "the delivery should decode as a task");
  assert.equal(decoded.correlationId, "corr-1");
  assert.equal(decoded.replyTo, "8@global");
  assert.equal(decoded.streamTo, "9@global");
  assert.equal(taskObjective(decoded.task), "What is the status of the deploy?");
  assert.equal(decoded.task.skill, "You are Tina, the release manager.");
  assert.equal(threadSessionId(decoded.task), "space:space-1:res-tina");
  assert.equal(sessionSlug("space:space-1:res-tina"), "space-space-1-res-tina");
});

await check("a payload-string envelope (the CLI convention) unwraps, keeping proxy keys", () => {
  const inner = { payload: JSON.stringify({ objective: "ship it", config: { tools: [] } }), skill: "persona", correlationId: "c9", replyTo: "8@global" };
  const decoded = decodeTaskSignal("creatures/signal", { data: JSON.stringify(inner) });
  assert.equal(taskObjective(decoded.task), "ship it");
  assert.equal(decoded.task.skill, "persona");
  assert.equal(decoded.correlationId, "c9");
});

await check("a direct tool delivery preserves arguments and trusts the envelope space", () => {
  const packet = {
    kind: "direct_tool",
    toolProgramId: "tool-1",
    function: "list",
    payload: { path: "/client-value", space_id: "forged-space" },
    billingAuthorization: { holdId: "h", payerUserId: "u", quoteId: "q" },
    correlationId: "tool-correlation",
    reply_to: "user-1",
    spaceId: "forged-space",
  };
  const decoded = decodeTaskSignal("creatures/signal", {
    data: JSON.stringify(packet),
    correlationId: "tool-correlation",
    store: { id: "real-space" },
  });
  assert.ok(decoded);
  assert.equal(decoded.task.kind, "direct_tool");
  assert.deepEqual(decoded.task.payload, packet.payload, "tool arguments are not unwrapped as a task");
  assert.equal(decoded.task.spaceId, "real-space", "the node envelope overrides the client space");
  assert.equal(decoded.correlationId, "tool-correlation");
  assert.equal(decoded.replyTo, "user-1");
});

await check("the agent's injected config.llm (proxy inject) survives the payload-string unwrap", () => {
  // The real wire shape: the app/Nest send the prompt double-wrapped — the inner
  // task travels as a JSON *string* under `payload` — and the node's proxy entity
  // deep-merges the agent's stored `inject` (`{config:{llm:{provider,model,apiKey}}}`)
  // onto the OUTER envelope, because it cannot reach inside the string. The inner
  // prompt itself carries no config.llm (the on-chain prompt path relies entirely
  // on the inject). The backbone must carry that injected config across the unwrap.
  const inner = {
    prompt: "summarize the repo",
    objective: "summarize the repo",
    config: { tools: ["caspar__sandbox"] }, // caller's own config — no llm here
  };
  const wrapper = {
    programId: "prog-agent",
    entity: "agent",
    payload: JSON.stringify(inner),
    // stamped by the node's proxy entity on the way through:
    skill: "You are Tina.",
    correlationId: "corr-llm",
    replyTo: "8@global",
    proxyProgramId: "8@global",
    proxyEntityId: "agent",
    // deep-merged from the agent's proxy.inject onto the outer envelope:
    config: { llm: { provider: "openai", models: ["gpt-5"], api_key: "sk-AGENT" } },
  };
  const decoded = decodeTaskSignal("creatures/signal", { data: JSON.stringify(wrapper) });
  assert.ok(decoded, "the delivery should decode as a task");
  assert.equal(decoded.task.config?.llm?.provider, "openai", "injected provider reaches the task");
  assert.equal(decoded.task.config?.llm?.models?.[0], "gpt-5", "injected model reaches the task");
  assert.equal(decoded.task.config?.llm?.api_key, "sk-AGENT", "the agent's own key reaches the task");
  assert.equal(decoded.task.config?.tools?.[0], "caspar__sandbox", "the caller's tools are preserved");
  assert.equal(decoded.task.skill, "You are Tina.", "the skill still rides the envelope");
});

await check("the injected config.llm wins over a caller-supplied one", () => {
  // A client cannot forge another provider/key: the proxy's injected config wins.
  const inner = { prompt: "hi", config: { llm: { provider: "attacker", api_key: "sk-FORGED" }, tools: ["t1"] } };
  const wrapper = {
    payload: JSON.stringify(inner),
    correlationId: "c",
    config: { llm: { provider: "openai", models: ["gpt-5"], api_key: "sk-AGENT" } },
  };
  const decoded = decodeTaskSignal("creatures/signal", { data: JSON.stringify(wrapper) });
  assert.equal(decoded.task.config.llm.provider, "openai", "agent provider wins");
  assert.equal(decoded.task.config.llm.api_key, "sk-AGENT", "agent key wins");
  assert.equal(decoded.task.config.tools[0], "t1", "caller's other config fields are kept");
});

await check("signals that are not prompts are ignored", () => {
  assert.equal(decodeTaskSignal("creatures/signal", { data: JSON.stringify({ kind: "tools/result", correlationId: "x", result: {} }) }), null);
  assert.equal(decodeTaskSignal("creatures/signal", { data: JSON.stringify({ kind: "davinci/step", correlationId: "x" }) }), null);
  assert.equal(decodeTaskSignal("other/key", { data: "{}" }), null);
  assert.equal(decodeTaskSignal("creatures/signal", { data: "not json" }), null);
});

await check("the store the signal came from is the authoritative space, overriding the payload", () => {
  // The requester embeds spaceId "space-1" in the payload, but the node stamps
  // the real originating store on the envelope — that store is what the creature
  // must scope to, so a payload spaceId can neither override nor forge it.
  const { key, data } = proxyDelivery({ store: { id: "store-real" } });
  const decoded = decodeTaskSignal(key, data);
  assert.equal(decoded.task.spaceId, "store-real", "the envelope store overrides the client spaceId");
  assert.equal(resolveSpaceId(decoded.task), "store-real", "discovery scopes to the store, not the payload");
  // A flat `storeId` on the envelope is accepted as a fallback.
  const flat = proxyDelivery({ store: undefined });
  flat.data.storeId = "store-flat";
  assert.equal(decodeTaskSignal(flat.key, flat.data).task.spaceId, "store-flat");
  // With no store on the envelope, the payload's own spaceId is kept.
  const bare = proxyDelivery();
  assert.equal(decodeTaskSignal(bare.key, bare.data).task.spaceId, "space-1");
});

await check("the system prompt carries the persona and the group-chat protocol", () => {
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery()));
  const system = buildSystemPrompt(task);
  assert.match(system, /YOUR PERSONA/);
  assert.match(system, /Tina, the release manager/);
  assert.match(system, /GROUP CHAT/);
  assert.match(system, /@handle is @tina/);
  assert.match(system, /Bob — @bob \(agent\)/);
  assert.match(system, /Shayan — @shayan \(person\)/);
  // The agent must never be listed among the other participants.
  assert.equal(/• Tina/.test(system), false, "the agent should not be in its own roster");
});

await check("the platform's universal instruction is concatenated with the agent's own", async () => {
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery()));
  // No universal prompt set: the system prompt is exactly what it was before.
  assert.equal(buildSystemPrompt(task), buildSystemPrompt(task, { universalInstruction: "   " }));

  const withUniversal = buildSystemPrompt(task, { universalInstruction: "Always answer in metric units." });
  assert.match(withUniversal, /PLATFORM INSTRUCTIONS \(every agent\)/);
  assert.match(withUniversal, /Always answer in metric units\./);
  // Both instructions are present, and the agent's own persona comes last so it
  // remains the authority on identity.
  assert.match(withUniversal, /Tina, the release manager/);
  assert.ok(
    withUniversal.indexOf("PLATFORM INSTRUCTIONS") < withUniversal.indexOf("YOUR PERSONA"),
    "the platform instruction is prepended to the agent's own system instruction",
  );

  // Read at execution time from the settings creature's own document — never
  // from `config`, which also holds the platform provider keys.
  const calls = [];
  const bridge = {
    call: async (op, input) => {
      calls.push({ op, input });
      return { ok: true, data: { text: "  Always answer in metric units.  " } };
    },
  };
  resetUniversalInstructionCache();
  assert.equal(await readUniversalInstruction(bridge, { now: 1 }), "Always answer in metric units.");
  assert.deepEqual(calls[0].input, { key: "Json::CreatureNamespace::settings", path: "universalPrompt" });

  // A read failure never stops an agent from answering.
  resetUniversalInstructionCache();
  const broken = { call: async () => { throw new Error("node unreachable"); } };
  assert.equal(await readUniversalInstruction(broken, { now: 2 }), "");
  // Unset on the platform → empty, so nothing is added to the prompt.
  resetUniversalInstructionCache();
  assert.equal(await readUniversalInstruction({ call: async () => ({ ok: true, data: {} }) }, { now: 3 }), "");
  resetUniversalInstructionCache();
});

await check("a new agent session gets a compact room transcript, not the full history", () => {
  const history = [
    { role: "user", content: "hey team", from: "Shayan", to: [] },
    { role: "assistant", content: "on it", from: "Bob", to: [{ name: "Shayan" }] },
    { role: "user", content: "@tina what's the status?", from: "Shayan", to: [{ name: "Tina" }], directedToMe: true },
  ];
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery({ history })));
  const prompt = buildUserPrompt(task, { objective: "what's the status?", attachments: [], workspace: "/w" });
  assert.match(prompt, /RECENT CHAT \(compact\)/);
  assert.match(prompt, /Shayan: hey team/);
  assert.match(prompt, /what's the status\?/);
  assert.doesNotMatch(prompt, /CONVERSATION SO FAR/);
  const resumed = buildUserPrompt(task, {
    objective: "what's the status?",
    attachments: [],
    workspace: "/w",
    includeHistory: false,
  });
  assert.equal(resumed, "what's the status?");
  const compact = compactConversationBlock(history);
  assert.ok(compact.length < 800);
});

await check("a RESUMED agent is still told what the team did while it was away", async () => {
  // The failure this check exists for: an agent's engine session is resumed from
  // its second turn onward, and the room transcript was skipped exactly then —
  // so it planned as if the project were where it left it and rebuilt what a
  // teammate had already built. The delta is included either way.
  const { task } = decodeTaskSignal(...Object.values(proxyDelivery({})));
  const delta = {
    lines: ["Builder: landing page is live", "Builder used sandbox: npm run build"],
    truncated: false,
  };
  const resumed = buildUserPrompt(task, {
    objective: "what's the status?",
    attachments: [],
    workspace: "/w",
    includeHistory: false,
    teamDelta: delta,
  });
  assert.match(resumed, /WHAT THE TEAM DID SINCE YOUR LAST TURN/);
  assert.match(resumed, /landing page is live/);
  assert.match(resumed, /Read what it produced before you write anything/);
  // Nothing to report is still nothing shown.
  assert.equal(teamDeltaBlock([]), "");
});

await check("the delta is bounded by this agent's own last turn, and includes tool calls", async () => {
  const rows = [
    { id: "5", time: 50, tags: ["kind=toolcall"], data: { agentName: "Builder", tool: "sandbox", command: "npm run build" } },
    { id: "4", time: 40, tags: ["kind=answer"], data: { agentName: "Builder", text: "page is live", agentProgramId: "b" } },
    { id: "3", time: 30, tags: ["kind=answer"], data: { agentName: "Tina", text: "here is the copy", agentProgramId: "tina-prog" } },
    { id: "2", time: 20, tags: ["kind=message"], data: { fromName: "Shayan", text: "make a landing page" } },
  ];
  const bridge = {
    async call(op) {
      if (op === "readSignals") return { ok: true, signals: rows.map((r) => ({ ...r, data: JSON.stringify(r.data) })) };
      return { ok: true };
    },
  };
  const delta = await fetchTeamActivitySince(bridge, {
    spaceId: "space-1",
    threadId: "main",
    self: { programId: "tina-prog", name: "Tina" },
  });
  assert.equal(delta.cutoff, 30, "the cutoff is this agent's own most recent answer");
  assert.deepEqual(delta.lines, ["Builder: page is live", "Builder used sandbox: npm run build"]);
  assert.ok(!delta.lines.some((l) => l.includes("here is the copy")), "an agent is not told its own turn back");
});

await check("the plan section says what exists and what to do about it", () => {
  const block = planPreamble("=== PROJECT PLAN ===\nOUTCOME: ship it\n=== END PROJECT PLAN ===\n");
  assert.match(block, /OUTCOME: ship it/);
  assert.match(block, /Call `read_plan` before you start/);
  assert.match(block, /never recreate a teammate's artifact/);
  assert.match(block, /prefer `assign_task`/);
  // A run with no project gets neither the content nor the rules.
  assert.equal(planPreamble("", { hasPlanTools: false }), "");
});

await check("an assigned agent is told which part of the message is its job", () => {
  assert.equal(assignmentPreamble({}), "");
  const text = assignmentPreamble({
    assignment: { planTaskId: "p1", objective: "Build the page from copy.md", fromName: "Lead" },
  });
  assert.match(text, /Lead handed you this piece of work/);
  assert.match(text, /task p1 in the project plan/);
  assert.match(text, /Build the page from copy\.md/);
  assert.match(text, /Do THIS, not the whole project/);
  assert.match(text, /complete_task/);
});

await check("the outcome preamble tells an agent that finishing is part of the job", () => {
  const { task } = decodeTaskSignal(
    ...Object.values(proxyDelivery({ extra: { projectBrief: "Ship a landing page" } })),
  );
  const system = buildSystemPrompt(task, {});
  assert.match(system, /FINISHING IS PART OF THE JOB/);
  assert.match(system, /Do not invent additional work to stay busy/);
});

await check("a shared orbit session id is pinned to the acting agent", () => {
  assert.equal(
    threadSessionId({ sessionId: "space:space-1:orbit", self: { id: "res-tina" }, spaceId: "space-1" }),
    "space:space-1:orbit:res-tina",
  );
  assert.equal(threadSessionId({ sessionId: "space:space-1:res-tina", self: { id: "res-tina" } }), "space:space-1:res-tina");
  assert.equal(threadSessionId({ spaceId: "space-1", self: { id: "res-tina" }, threadId: "design" }), "space:space-1:design:res-tina");
});

await check("OpenAI GPT-family image generation uses the Responses image tool and attaches its bytes", async () => {
  const calls = [];
  const collector = new OutboundMediaCollector();
  const generator = new ProviderMediaGenerator({
    llm: { provider: "openai", models: ["gpt-5.4"], api_key: "sk-agent" },
    collector,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output: [{ type: "image_generation_call", result: Buffer.from("openai-image").toString("base64") }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await generator.generate({ modality: "image", prompt: "A green orbital habitat", format: "png" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.4", "the selected GPT model performs the generation");
  assert.match(calls[0].url, /\/responses$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tools[0].type, "image_generation");
  assert.equal(body.tool_choice.type, "image_generation");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-agent");
  assert.equal(collector.attachments()[0].dataBase64, Buffer.from("openai-image").toString("base64"));
});

await check("media generation falls back from a non-output LLM to configured Gemini audio and wraps PCM as WAV", async () => {
  const calls = [];
  const collector = new OutboundMediaCollector();
  const generator = new ProviderMediaGenerator({
    llm: { provider: "anthropic", models: ["claude-opus-5"], api_key: "sk-anthropic" },
    env: { GROK_CREATURE_LLM_KEY_GEMINI: "gemini-platform" },
    collector,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.from([1, 2, 3, 4]).toString("base64") } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await generator.generate({ modality: "audio", prompt: "Welcome to Decillion", voice: "Kore" });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "gemini", "Anthropic has no media-output route, so a configured provider is selected");
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-3\.1-flash-tts-preview:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "gemini-platform");
  const bytes = Buffer.from(collector.attachments()[0].dataBase64, "base64");
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
});

await check("OpenRouter asynchronous video generation is polled and attached as video", async () => {
  const calls = [];
  const collector = new OutboundMediaCollector();
  const generator = new ProviderMediaGenerator({
    llm: { provider: "openrouter", models: ["openai/gpt-5.4"], api_key: "or-agent" },
    collector,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const href = String(url);
      calls.push({ url: href, method: init.method });
      if (init.method === "POST") {
        return new Response(JSON.stringify({ id: "video-1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/content?")) {
        return new Response(Buffer.from("mp4-bytes"), { status: 200, headers: { "content-type": "video/mp4" } });
      }
      return new Response(JSON.stringify({ id: "video-1", status: "completed" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const result = await generator.generate({ modality: "video", prompt: "A robot crossing a salt flat", aspect_ratio: "16:9", duration: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "google/veo-3.1-lite");
  assert.equal(calls.length, 3, "submit, poll, then download");
  assert.equal(collector.attachments()[0].kind, "video");
  assert.equal(Buffer.from(collector.attachments()[0].dataBase64, "base64").toString(), "mp4-bytes");
});

await check("a failed provider request is not retried against another billable provider", async () => {
  let requests = 0;
  const generator = new ProviderMediaGenerator({
    llm: { provider: "openai", models: ["gpt-5.4"], api_key: "sk-agent" },
    env: { GROK_CREATURE_LLM_KEY_GEMINI: "gemini-platform" },
    collector: new OutboundMediaCollector(),
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { message: "policy rejected" } }), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  const result = await generator.generate({ modality: "image", prompt: "test" });
  assert.equal(result.ok, false);
  assert.equal(result.provider, "openai");
  assert.equal(requests, 1, "a possibly billed failure must not spill into Gemini");
  assert.match(result.hint, /not retried/);
});

await check("the tool catalog becomes MCP tools with pinned platform defaults", () => {
  const catalog = [
    {
      name: "project sandbox",
      tool_id: "31@global",
      program_id: "31@global",
      entity_id: "sandbox",
      creature_id: "30@global",
      category: "sandbox",
      description: "the project's cloud machine",
      arg_schema: { command: { type: "string", description: "shell command" }, path: { type: "string" }, space_id: { type: "string" } },
      required: ["command"],
      function: "exec",
      defaults: { space_id: "space-1" },
      risk: "high",
    },
    { name: "no-target tool", tool_id: "", arg_schema: {} },
  ];
  const { tools, byName } = buildToolDefinitions(catalog);
  assert.equal(tools.length, 1, "an unroutable creature must never be offered to the agent");
  assert.equal(tools[0].name, "project_sandbox");
  assert.deepEqual(tools[0].inputSchema.required, ["command"]);
  assert.match(tools[0].description, /pins space_id/);
  // The platform's binding wins over anything the model says.
  const merged = mergeArgs(byName.get("project_sandbox"), { command: "ls", space_id: "space-999", nothing: null });
  assert.deepEqual(merged, { command: "ls", space_id: "space-1" });
});

await check("token usage maps to what the platform bills", () => {
  const usage = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 10, output_tokens: 40 });
  assert.equal(usage.promptTokens, 1010);
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.totalTokens, 1050);
});

await check("terminal results preserve generated attachments for the Decillion uploader", () => {
  const attachment = {
    name: "generated.png",
    mimeType: "image/png",
    kind: "image",
    size: 3,
    dataBase64: Buffer.from("png").toString("base64"),
    source: "generated",
  };
  const result = buildResult(
    "draw it",
    { subtype: "success", is_error: false, result: "Here it is.", usage: {} },
    { seq: 0, toolCallCount: 0, todos: [] },
    { attachments: [attachment] },
  );
  assert.deepEqual(result.attachments, [attachment]);
});

await check("an agent's own API key takes over the run from the image's credentials", () => {
  // The image is deployed with the platform's own credentials baked in; an agent
  // that carries its own must not silently run (and bill) on the platform's.
  const imageEnv = { PATH: "/usr/bin", XAI_API_KEY: "xai-platform-key", GROK_CODE_XAI_API_KEY: "xai-platform-legacy" };
  const own = buildChildEnv({ env: imageEnv, llm: { provider: "openai", models: ["gpt-4o"], api_key: "sk-agent-key" } });
  assert.equal(own.env.XAI_API_KEY, undefined, "the image's key must not outrank the agent's own");
  assert.equal(own.env.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(own.model, "gpt-4o");
  assert.equal(own.credential, "agent:openai");
  // The agent's key rides the run's config entry, never the child's environment,
  // so a subprocess (or a crash dump) cannot carry it further.
  assert.equal(own.modelConfig.apiKey, "sk-agent-key");
  assert.equal(Object.values(own.env).includes("sk-agent-key"), false, "the provider key stays out of the child env");

  // An agent with no override keeps the image's backbone untouched.
  const inherited = buildChildEnv({ env: imageEnv });
  assert.equal(inherited.env.XAI_API_KEY, "xai-platform-key");
  assert.equal(inherited.model, undefined);
  assert.equal(inherited.modelConfig, undefined);
});

await check("a per-agent LLM override becomes a native endpoint entry, per provider", () => {
  const env = { PATH: "/usr/bin", GROK_SESSION_ID: "leaked" };

  // The native provider (xAI): the model id goes straight to grok's built-in
  // catalog and the agent's own key takes over the run's env credential — so it
  // needs no generated `[model.<id>]` endpoint. Its per-run resilience (idle
  // timeout, retries) therefore rides the run-wide `[models]` block instead (see
  // runWideModelDefaults), not a per-model entry.
  const xai = buildChildEnv({ env: { ...env, XAI_API_KEY: "xai-image" }, llm: { provider: "xai", models: ["grok-4.5"], api_key: "xai-agent" } });
  assert.equal(xai.model, "grok-4.5");
  assert.equal(xai.modelConfig, undefined, "the native backbone needs no generated [model.<id>] endpoint");
  assert.equal(xai.env.XAI_API_KEY, "xai-agent", "the agent's own xAI key takes over from the image's");
  assert.equal(xai.credential, "agent:XAI_API_KEY");
  assert.equal(xai.env.GROK_SESSION_ID, undefined, "the parent's session id must not leak into the child");

  // Anthropic speaks the Messages API and authenticates with x-api-key, not a
  // bearer token — getting either wrong is a 401 on every prompt.
  const anthropic = buildChildEnv({ env, llm: { provider: "anthropic", models: ["claude-opus-5"], api_key: "sk-ant-agent" } });
  assert.equal(anthropic.modelConfig.apiBackend, "messages");
  assert.equal(anthropic.modelConfig.authScheme, "x_api_key");
  assert.equal(anthropic.modelConfig.headers["anthropic-version"], "2023-06-01");

  // OpenAI-compatible providers: one shape, different endpoints. OpenAI itself
  // defaults to the Responses API — its reasoning models reject
  // chat/completions when function tools ride with a non-none reasoning_effort —
  // and pins tool-call streaming OFF to avoid the Responses stall that surfaced
  // as "randomly stuck on a step". The others speak Chat Completions.
  for (const [provider, host, backend] of [
    ["openai", "api.openai.com", "responses"],
    ["gemini", "generativelanguage.googleapis.com", "chat_completions"],
    ["openrouter", "openrouter.ai", "chat_completions"],
    ["agentrouter", "agentrouter.org", "chat_completions"],
  ]) {
    const built = buildChildEnv({ env, llm: { provider, models: ["some-model"], api_key: "k" } });
    assert.ok(built.modelConfig.baseUrl.includes(host), `${provider} → ${host}`);
    assert.equal(built.modelConfig.apiBackend, backend, `${provider} → ${backend}`);
  }
  assert.equal(
    buildChildEnv({ env, llm: { provider: "openai", models: ["gpt-5"], api_key: "k" } }).modelConfig.streamToolCalls,
    false,
    "OpenAI pins tool-call streaming off to avoid the Responses stall",
  );

  // An agent may point a provider at its own gateway.
  const custom = buildChildEnv({ env, llm: { provider: "openai", models: ["m"], api_key: "k", base_url: "https://gw.example/v1" } });
  assert.equal(custom.modelConfig.baseUrl, "https://gw.example/v1");
});

await check("an unusable LLM override falls back to the default backbone, with a warning", () => {
  // No key to authenticate with: the run must not fail, and must not silently
  // bill the platform without saying so.
  const noKey = applyLlmOverride({ XAI_API_KEY: "xai-platform" }, { provider: "openai", models: ["gpt-4o"] });
  assert.equal(noKey.modelConfig, undefined);
  assert.match(noKey.warning, /no api_key/);

  // An unknown provider with no endpoint to call.
  const unknown = applyLlmOverride({}, { provider: "nonesuch", models: ["m"], api_key: "k" });
  assert.equal(unknown.modelConfig, undefined);
  assert.match(unknown.warning, /not a known backbone/);

  // ...but an unknown provider WITH a base_url is honoured: a self-hosted or
  // brand-new OpenAI-compatible endpoint needs no code change.
  const selfHosted = applyLlmOverride({}, { provider: "nonesuch", models: ["m"], api_key: "k", base_url: "https://llm.internal/v1" });
  assert.equal(selfHosted.modelConfig.baseUrl, "https://llm.internal/v1");
  assert.equal(selfHosted.warning, undefined);
});

await check("the operator's baked default backbone serves agents that bring no provider", () => {
  // A deploy can bake a non-xAI default (an operator whose platform key is an
  // OpenRouter key, say). It must apply only when the agent has none of its own.
  const env = { PATH: "/usr/bin", GROK_CREATURE_LLM_PROVIDER: "openrouter", GROK_CREATURE_LLM_API_KEY: "sk-or-platform", GROK_CREATURE_LLM_MODEL: "openai/gpt-4o" };
  assert.equal(defaultLlm(env).provider, "openrouter");
  const fallback = buildChildEnv({ env });
  assert.equal(fallback.model, "openai/gpt-4o");
  assert.equal(fallback.modelConfig.baseUrl, "https://openrouter.ai/api/v1");

  const agentWins = buildChildEnv({ env, llm: { provider: "openai", models: ["gpt-4o-mini"], api_key: "sk-agent" } });
  assert.equal(agentWins.modelConfig.apiKey, "sk-agent", "a per-agent provider always wins over the baked default");
  assert.equal(agentWins.modelConfig.baseUrl, "https://api.openai.com/v1");

  // With nothing baked, nothing changes.
  assert.equal(defaultLlm({ PATH: "/usr/bin" }), null);
});

await check("trajectory events land on the channels the client renders", () => {
  const mapper = new TrajectoryMapper();
  const channels = [];
  for (const message of successScenario().messages) {
    for (const event of mapper.map(message)) channels.push([event.channel, event.kind]);
  }
  assert.deepEqual(channels, [
    ["status", "run_start"],
    ["thought", "reason"],
    ["plan", "decision"],
    ["observation", "tool_result"],
    ["action", "decision"],
    ["observation", "tool_result"],
    ["final", "final_answer"],
  ]);
  assert.equal(mapper.toolCallCount, 2);
  assert.equal(mapper.todos.length, 2);
});

await check("credentials are masked out of streamed steps", () => {
  const mapper = new TrajectoryMapper();
  const [event] = mapper.map({ type: "assistant", message: { content: [{ type: "text", text: "using sk-ant-abcdefghijklmnopqrstuv now" }] } });
  assert.equal(/sk-ant-abcdefghijklmnopqrstuv/.test(event.message), false);
  assert.match(event.message, /\*\*\*/);
});

// ── gateway-level checks ─────────────────────────────────────────────────────

await check("a signal arriving before any listener is buffered and replayed on subscribe", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  try {
    // The node flushes packets it queued while the creature was cold right after
    // WELCOME — they can land before the serve loop subscribes. That must not drop
    // them (it would hang the caller).
    gateway.pushSignal("creatures/signal", { data: JSON.stringify({ kind: "invoke", tool_id: "t", correlationId: "c1", payload: {} }) });
    for (let i = 0; i < 100 && bridge._earlySignals.length === 0; i++) await sleep(5);
    assert.equal(bridge._earlySignals.length, 1, "the early signal must be buffered, not dropped");

    const received = [];
    bridge.onSignal((key, data) => received.push([key, data]));
    assert.equal(received.length, 1, "registering a listener replays the buffered signal");
    assert.equal(received[0][0], "creatures/signal");
    assert.equal(bridge._earlySignals.length, 0, "the buffer is drained once replayed");

    // A later signal goes straight through, not into the buffer.
    gateway.pushSignal("creatures/signal", { data: JSON.stringify({ kind: "invoke", tool_id: "t", correlationId: "c2", payload: {} }) });
    for (let i = 0; i < 100 && received.length < 2; i++) await sleep(5);
    assert.equal(received.length, 2, "a signal after subscribe is delivered live");
  } finally {
    bridge.close();
    await gateway.close();
  }
});

await check("the handshake adopts the node-assigned identity and large messages chunk", async () => {
  const gateway = await new FakeGateway({ identity: { machineId: "77@global", programId: "77@global", vmId: "vm-77" } }).listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  try {
    assert.equal(bridge.machineId, "77@global");
    assert.equal(bridge.vmId, "vm-77");
    assert.equal(bridge.sessionId, 42);
    const pong = await bridge.ping();
    assert.equal(pong.ok, true);
    // A payload larger than one 64 KiB chunk must arrive whole.
    const big = "x".repeat(200_000);
    await bridge.signalUser("creatures/signal", "1@global", { kind: "davinci/step", blob: big });
    const [signal] = gateway.signals();
    assert.equal(signal.packet.blob.length, big.length);
  } finally {
    bridge.close();
    await gateway.close();
  }
});

await check("the space's creatures are employable over MCP, and pinned args win", async () => {
  // The node answers a tool signal the way a live tool creature does.
  const invoked = [];
  const gateway = await new FakeGateway({
    onCall: (op, input, gw) => {
      if (op !== "signalUser") return { ok: true };
      const packet = JSON.parse(input.packet);
      if (packet.kind !== "invoke") return { ok: true };
      invoked.push({ target: input.userId, packet });
      setTimeout(() => {
        gw.pushSignal("creatures/signal", {
          data: JSON.stringify({ kind: "tools/result", correlationId: packet.correlationId, result: { ok: true, stdout: "hello from the sandbox" } }),
        });
      }, 10);
      return { ok: true };
    },
  }).listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  const { tools, byName } = buildToolDefinitions([
    {
      name: "project sandbox",
      tool_id: "31@global",
      program_id: "31@global",
      entity_id: "sandbox",
      arg_schema: { command: { type: "string" }, space_id: { type: "string" } },
      required: ["command"],
      function: "exec",
      defaults: { space_id: "space-1" },
    },
  ]);
  const invoker = new ToolInvoker(bridge, byName, bridge.machineId);
  const socketPath = path.join(tempDir("caspar-sock-"), "tools.sock");
  const server = await new ToolSocketServer(socketPath, { list: () => tools, call: (name, args) => invoker.invoke(name, args) }).start();

  // Speak MCP to the server the way Grok does.
  const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, CASPAR_TOOL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = responses.get(message.id);
      if (waiter) {
        responses.delete(message.id);
        waiter(message);
      }
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "caspar");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const listed = await rpc(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((t) => t.name), ["project_sandbox"]);

    const called = await rpc(3, "tools/call", { name: "project_sandbox", arguments: { command: "echo hi", space_id: "space-999" } });
    assert.ok(!called.result.isError, "a successful employment is not an error");
    const payload = JSON.parse(called.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.response.stdout, "hello from the sandbox");

    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].target, "31@global");
    assert.equal(invoked[0].packet.entityId, "sandbox", "entityId is required for the node to cold-spawn the tool");
    assert.equal(invoked[0].packet.function, "exec");
    assert.equal(invoked[0].packet.reply_to, bridge.machineId);
    assert.equal(invoked[0].packet.payload.space_id, "space-1", "the platform's space binding must win over the model's argument");

    const unknown = await rpc(4, "tools/call", { name: "nope", arguments: {} });
    assert.equal(unknown.result.isError, true);
  } finally {
    child.kill();
    invoker.dispose();
    await server.stop();
    bridge.close();
    await gateway.close();
  }
});

await check("prompts that arrive while one is being served are queued, not dropped", async () => {
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  const { createDeliveryQueue } = await import("../runtime.mjs");
  const queue = createDeliveryQueue(bridge, 3000);
  try {
    // Two prompts back-to-back, as two agents in one space produce — plus one
    // signal that is not a prompt at all.
    const first = proxyDelivery({ prompt: "first", correlationId: "c1" });
    const second = proxyDelivery({ prompt: "second", correlationId: "c2" });
    gateway.pushSignal(first.key, first.data);
    gateway.pushSignal("creatures/signal", { data: JSON.stringify({ kind: "tools/result", correlationId: "x" }) });
    gateway.pushSignal(second.key, second.data);

    const a = await queue.next();
    const b = await queue.next();
    assert.equal(taskObjective(a.task), "first");
    assert.equal(taskObjective(b.task), "second", "the second prompt must survive being delivered mid-run");
    assert.equal(a.correlationId, "c1");
    assert.equal(b.correlationId, "c2");
    // Nothing else is pending, so the queue idles out rather than inventing work.
    assert.equal(await queue.next(), null);
  } finally {
    queue.dispose();
    bridge.close();
    await gateway.close();
  }
});

await check("a dropped gateway link wakes the serve loop instead of hanging until idle", async () => {
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  const { createDeliveryQueue } = await import("../runtime.mjs");
  // A long idle window: only the disconnect (not the timeout) should wake next().
  const queue = createDeliveryQueue(bridge, 30000);
  try {
    assert.equal(bridge.isConnected(), true, "connected after the handshake");
    let closed = false;
    bridge.onClose(() => {
      closed = true;
    });

    // Block on the next prompt, then simulate the node/gateway dropping the link
    // (node restart, transient blip). A serving creature that only polled on the
    // idle window would sit here alive-but-unreachable; the link watch must wake
    // it at once so it can reconnect.
    const pending = queue.next();
    for (const socket of [...gateway.sockets]) socket.destroy();

    const started = Date.now();
    const woke = await pending;
    assert.equal(woke, null, "next() resolves null when the link drops (nothing to serve)");
    assert.ok(Date.now() - started < 5000, "woke promptly on disconnect, not after the idle window");
    assert.equal(closed, true, "onClose fired for the unexpected drop");
    assert.equal(bridge.isConnected(), false, "isConnected() reflects the dropped link");
  } finally {
    queue.dispose();
    bridge.close();
    await gateway.close();
  }
});

// ── end-to-end serve checks ─────────────────────────────────────────────────

/**
 * Serve one prompt with the fake CLI standing in for Grok Build, and return
 * everything the node saw plus what the CLI was invoked with.
 */
async function serveWithFakeCli({ scenario, delivery, envOverrides = {}, catalogTools = [] } = {}) {
  const { file, record } = scenarioFile(scenario);
  const workspaceRoot = tempDir("caspar-ws-");
  const previous = { ...process.env };
  Object.assign(process.env, {
    GROK_BIN: FAKE_CLI,
    GROK_FAKE_SCENARIO: file,
    GROK_FAKE_RECORD: record,
    GROK_CREATURE_WORKSPACE_ROOT: workspaceRoot,
    GROK_CREATURE_CONFIG_DIR: path.join(workspaceRoot, "config"),
    GROK_CREATURE_MAX_WALL_SECONDS: "30",
    // The checks run the CLI as whoever runs them; privilege dropping has its own
    // check and would otherwise hide the run behind file permissions.
    GROK_CREATURE_USER: "",
    ...envOverrides,
  });
  const gateway = await new FakeGateway().listen();
  const bridge = await bridgeFromEnv({ env: { CASPAR_GATEWAY_HOST: "127.0.0.1", CASPAR_GATEWAY_PORT: String(gateway.port) }, timeoutMs: 5000 });
  // Imported lazily so each serve picks up the env above.
  const { serveOnce } = await import("../runtime.mjs");
  try {
    const d = delivery ?? proxyDelivery({ tools: catalogTools });
    const decoded = decodeTaskSignal(d.key, d.data);
    const result = await serveOnce(bridge, decoded);
    return {
      result,
      signals: gateway.signals(),
      storeSignals: gateway.storeSignals(),
      invocation: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf-8")) : null,
      workspaceRoot,
    };
  } finally {
    bridge.close();
    await gateway.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

await check("a served prompt streams its trajectory and replies exactly once", async () => {
  const { result, signals, storeSignals, invocation } = await serveWithFakeCli({ scenario: successScenario("The deploy is green.") });

  const finals = signals.filter((s) => s.packet.kind === "davinci/result");
  // In a space, every step of the run is a signal ON that space: the node
  // records it in the signal log and fans it out live in the same delivery.
  const steps = storeSignals.filter((s) => s.tags.includes("kind=step") || s.tags.includes("kind=toolcall"));
  const answers = storeSignals.filter((s) => s.tags.includes("kind=answer"));

  assert.equal(finals.length, 1, "exactly one terminal result");
  assert.equal(finals[0].userId, "8@global", "the terminal result goes back through the proxy (replyTo)");
  assert.equal(finals[0].packet.final, true);
  assert.equal(finals[0].packet.stream, false);
  assert.equal(finals[0].packet.correlationId, "corr-1");

  assert.equal(
    signals.filter((s) => s.packet.kind === "davinci/step").length,
    0,
    "a run inside a space never pushes steps straight at a user — the store fan-out reaches every participant",
  );
  assert.ok(steps.length >= 6, `expected the whole trajectory to be recorded, saw ${steps.length}`);
  assert.ok(steps.every((s) => s.storeId === "space-1"));
  assert.ok(steps.every((s) => s.tags.includes("run=corr-1")), "every step carries its run tag");
  assert.ok(steps.every((s) => s.tags.includes("thread=main")), "every step carries its thread tag");
  assert.deepEqual(steps.map((s) => s.data.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    steps.map((s) => s.data.channel),
    ["status", "thought", "plan", "observation", "action", "observation", "final"],
  );
  // A tool call is labelled as one, so an agent's tool trail is filterable.
  assert.deepEqual(
    steps.filter((s) => s.tags.includes("kind=toolcall")).map((s) => s.data.channel),
    ["action"],
  );
  assert.equal(steps[1].data.event.message, "They want the deploy status.");
  assert.equal(answers.length, 1, "the final answer is recorded once, as a chat turn");
  assert.equal(answers[0].data.text, "The deploy is green.");

  // The reply the backend bills and the client renders.
  assert.equal(result.success, true);
  assert.equal(result.answer, "The deploy is green.");
  assert.equal(result.usage.promptTokens, 1010);
  assert.equal(result.usage.completionTokens, 40);
  assert.equal(result.durationMs, 1234);
  assert.equal(result.model, "grok-build");
  assert.equal(result.engine, "grok-build");
  assert.equal(Array.isArray(result.plan), false, "plan must not be an array — an array is the backend's employ-plan signal");
  assert.deepEqual(result.plan.progress, { done: 0, total: 2 });
  assert.equal("result" in result, false, "a `result` key would be mistaken for the answer by the backend");
  assert.deepEqual(finals[0].packet.result, result);

  // What the CLI was actually asked to do.
  assert.ok(invocation, "the CLI should have been invoked");
  assert.equal(invocation.outputFormat, "streaming-messages-json", "the bridge parses the Messages stream shape");
  assert.ok(invocation.argv.includes("--prompt-file"), "the (unbounded) turn is passed as a file, not on stdin");
  assert.ok(invocation.argv.includes("--trust"), "a creature's own workspace has nobody to answer a trust prompt");
  assert.equal(invocation.permissionMode, "bypassPermissions");
  assert.match(invocation.rules, /Tina, the release manager/);
  assert.equal(invocation.prompt, "What is the status of the deploy?");
  assert.ok(invocation.grokHome, "the run gets its own GROK_HOME");
  assert.equal(invocation.argv.includes("--resume"), false, "the first turn creates the native Grok session");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(invocation.grokHome, "caspar-conversation.json"), "utf-8")),
    { sessionId: invocation.sessionId },
    "the thread records the native session id for subsequent --resume turns",
  );
  assert.equal(/\[mcp_servers/.test(invocation.config), true, "platform media tools keep the MCP server available without space creatures");
  assert.match(invocation.rules, /caspar__generate_media/, "the provider-neutral generation tool is explained to the agent");
  assert.match(invocation.rules, /caspar__share_media/, "the outbound sharing tool is explained to the agent");
  assert.equal(invocation.tools, undefined, "no --tools allowlist: it would strip the planning/web built-ins");
  assert.ok((invocation.disallowedTools || "").includes("run_terminal_cmd"), "the local shell/file built-ins are denied");
  const promptPath = invocation.argv[invocation.argv.indexOf("--prompt-file") + 1] || "";
  assert.ok(promptPath.endsWith("prompt.txt"), "a text-only turn is a .txt prompt file, not content blocks");
});

await check("a later turn resumes its Grok session without the new-session flag", async () => {
  const configRoot = tempDir("caspar-resume-config-");
  const threadHome = path.join(configRoot, "space-space-1-res-tina");
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  fs.mkdirSync(threadHome, { recursive: true });
  fs.writeFileSync(path.join(threadHome, "caspar-conversation.json"), JSON.stringify({ sessionId }));

  const { result, invocation } = await serveWithFakeCli({
    scenario: successScenario("Continuing."),
    envOverrides: { GROK_CREATURE_CONFIG_DIR: configRoot },
  });

  assert.equal(result.success, true);
  assert.equal(invocation.argv.includes("--session-id"), false, "resume must not also identify a new session");
  const resumeAt = invocation.argv.indexOf("--resume");
  assert.notEqual(resumeAt, -1, "the persisted conversation is resumed");
  assert.equal(invocation.argv[resumeAt + 1], sessionId);
});

await check("a quiet run still streams heartbeats so the client does not time it out", async () => {
  // The CLI stays silent (no stream-json) for a stretch that dwarfs the heartbeat
  // interval, standing in for a long tool call or model turn. The run must keep
  // pushing keep-alive steps on the stream so a client watching for inactivity
  // sees the run is alive.
  const quietScenario = {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "grok-build", tools: [], mcp_servers: [] },
      { __sleepMs: 450 },
      ...successScenario("done").messages.slice(1),
    ],
  };
  const { storeSignals, result } = await serveWithFakeCli({
    scenario: quietScenario,
    envOverrides: { GROK_CREATURE_STREAM_HEARTBEAT_MS: "80" },
  });
  const heartbeats = storeSignals.filter((s) => s.data.channel === "heartbeat");
  assert.ok(heartbeats.length >= 1, `expected at least one heartbeat during the quiet stretch, saw ${heartbeats.length}`);
  assert.ok(
    heartbeats.every((s) => s.temp === true),
    "a heartbeat is delivered live but never recorded — it is not work",
  );
  assert.ok(
    heartbeats.every((s) => s.tags.includes("run=corr-1")),
    "each heartbeat carries the run's tag so the client can match it",
  );
  // The heartbeat is purely a keep-alive: the run still finishes and replies.
  assert.equal(result.success, true);
  assert.equal(result.answer, "done");
});

await check("heartbeats can be disabled with STREAM_HEARTBEAT_MS=0", async () => {
  const quietScenario = {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "grok-build", tools: [], mcp_servers: [] },
      { __sleepMs: 300 },
      ...successScenario("done").messages.slice(1),
    ],
  };
  const { signals } = await serveWithFakeCli({
    scenario: quietScenario,
    envOverrides: { GROK_CREATURE_STREAM_HEARTBEAT_MS: "0" },
  });
  const heartbeats = signals.filter((s) => s.packet.kind === "davinci/step" && s.packet.channel === "heartbeat");
  assert.equal(heartbeats.length, 0, "no heartbeats when the interval is zero");
});

await check("an image/audio attachment reaches the model inline as ACP content blocks", async () => {
  // A 1×1 PNG and a tiny WAV, both inline base64 — exactly what the Expo client
  // sends for the current turn's attachments.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const wav = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
  const { result, invocation, workspaceRoot } = await serveWithFakeCli({
    scenario: successScenario("Nice picture."),
    delivery: proxyDelivery({
      prompt: "what is this?",
      extra: {
        attachments: [
          { name: "shot.png", mime_type: "image/png", data: png },
          { name: "clip.wav", mime_type: "audio/wav", data: wav },
          { name: "notes.pdf", mime_type: "application/pdf", data: "JVBERi0=" },
        ],
      },
    }),
  });

  assert.equal(result.success, true, "the run still completes with attachments");
  assert.ok(invocation, "the CLI was invoked");
  const promptPath = invocation.argv[invocation.argv.indexOf("--prompt-file") + 1] || "";
  assert.ok(promptPath.endsWith("prompt.json"), "a multimodal turn is a .json content-block prompt file");

  const blocks = JSON.parse(invocation.prompt);
  assert.ok(Array.isArray(blocks), "the prompt file is a content-block array");
  assert.equal(blocks[0].type, "text", "the composed text turn comes first");
  assert.match(blocks[0].text, /what is this\?/);

  const image = blocks.find((b) => b.type === "image");
  assert.ok(image, "the image is inlined as an image content block");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, png, "the image bytes are carried verbatim to the model");

  // Audio is NOT inlined as a block (the model drops audio blocks); it is handled
  // by transcription instead. With no STT configured here, it stays file-only.
  assert.equal(blocks.some((b) => b.type === "audio"), false, "audio is not inlined as a content block");

  // Non-media stays file-only — never inlined as a block.
  assert.equal(blocks.some((b) => b.type !== "text" && b.mimeType === "application/pdf"), false, "a PDF is not inlined as a content block");

  // Every attachment (media included) is still materialised so the agent can
  // also open/run/edit the bytes with its filesystem tools.
  const attachDir = fs.existsSync(workspaceRoot)
    ? fs.readdirSync(workspaceRoot, { recursive: true }).map(String)
    : [];
  assert.ok(attachDir.some((p) => p.endsWith("shot.png")), "the image is also materialised into the workspace");
  assert.ok(attachDir.some((p) => p.endsWith("notes.pdf")), "the non-media file is materialised for the agent to open");
});

await check("a PDF and a text document are extracted to text the model can read", async () => {
  // The model's content is text + image only, so a PDF/doc must be inlined as
  // text — otherwise the agent "can't understand" it. Build a tiny real PDF.
  const zlib = await import("node:zlib");
  const content = Buffer.from("BT (Invoice total is 42 dollars) Tj ET", "latin1");
  const deflated = zlib.deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    deflated,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);

  const { result, invocation } = await serveWithFakeCli({
    scenario: successScenario("The invoice total is 42 dollars."),
    delivery: proxyDelivery({
      prompt: "what is the total?",
      extra: {
        attachments: [
          { name: "invoice.pdf", mime_type: "application/pdf", data: pdf.toString("base64") },
          { name: "readme.md", mime_type: "text/markdown", data: Buffer.from("# Title\nBudget: 100 USD.").toString("base64") },
        ],
      },
    }),
  });

  assert.equal(result.success, true);
  // No image/audio here, so the turn stays plain text.
  const promptPath = invocation.argv[invocation.argv.indexOf("--prompt-file") + 1] || "";
  assert.ok(promptPath.endsWith("prompt.txt"), "a document-only turn is still a plain-text prompt");
  assert.match(invocation.prompt, /CONTENT OF invoice\.pdf/, "the PDF's text is inlined");
  assert.match(invocation.prompt, /Invoice total is 42 dollars/, "the extracted PDF text reaches the model");
  assert.match(invocation.prompt, /CONTENT OF readme\.md/, "the markdown doc is inlined");
  assert.match(invocation.prompt, /Budget: 100 USD/, "the document's content reaches the model");
});

await check("audio is transcribed to text via a Whisper-compatible endpoint", async () => {
  const http = await import("node:http");
  let sawUpload = false;
  const stt = http.createServer((req, res) => {
    sawUpload = req.url.includes("/audio/transcriptions");
    let body = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "Hello from the recording." }));
    });
  });
  await new Promise((r) => stt.listen(0, "127.0.0.1", r));
  const { port } = stt.address();
  try {
    const { result, invocation } = await serveWithFakeCli({
      scenario: successScenario("You said hello."),
      envOverrides: {
        GROK_CREATURE_STT_API_KEY: "sk-test",
        GROK_CREATURE_STT_BASE_URL: `http://127.0.0.1:${port}`,
      },
      delivery: proxyDelivery({
        prompt: "what did I say?",
        extra: {
          attachments: [
            { name: "voice.wav", mime_type: "audio/wav", data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=" },
          ],
        },
      }),
    });
    assert.equal(result.success, true);
    assert.ok(sawUpload, "the audio was POSTed to the transcription endpoint");
    assert.match(invocation.prompt, /TRANSCRIPT OF voice\.wav/, "the transcript is inlined as text");
    assert.match(invocation.prompt, /Hello from the recording/, "the transcript reaches the model");
  } finally {
    stt.close();
  }
});

await check("a URL-referenced image is fetched and inlined (the Expo client's frame-safe path)", async () => {
  // The app uploads bytes to Caspar storage and sends the agent only a small
  // reference {name, mime_type, url} — never base64 — so the prompt signal stays
  // under the node's frame limit. The backbone fetches the bytes from the URL.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { result, invocation } = await serveWithFakeCli({
      scenario: successScenario("Got it."),
      delivery: proxyDelivery({
        prompt: "describe the picture",
        extra: {
          attachments: [
            { name: "remote.png", mime_type: "image/png", url: `http://127.0.0.1:${port}/remote.png` },
          ],
        },
      }),
    });
    assert.equal(result.success, true);
    const promptPath = invocation.argv[invocation.argv.indexOf("--prompt-file") + 1] || "";
    assert.ok(promptPath.endsWith("prompt.json"), "the fetched image makes the turn multimodal");
    const blocks = JSON.parse(invocation.prompt);
    const image = blocks.find((b) => b.type === "image");
    assert.ok(image, "the URL-referenced image is inlined as an image block");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, png.toString("base64"), "the fetched bytes reach the model");
  } finally {
    server.close();
  }
});

await check("a space's creatures are wired into the run as an MCP server", async () => {
  const { invocation } = await serveWithFakeCli({
    scenario: successScenario(),
    catalogTools: [{ name: "project sandbox", tool_id: "31@global", program_id: "31@global", entity_id: "sandbox", arg_schema: { command: { type: "string" } }, required: ["command"], function: "exec", defaults: { space_id: "space-1" } }],
  });
  // Grok has no --mcp-config flag: the server is an entry in the run's config.toml.
  assert.match(invocation.config, /\[mcp_servers\.caspar\]/);
  assert.match(invocation.config, /mcpStdioServer\.mjs/);
  assert.match(invocation.config, /CASPAR_TOOL_SOCKET = "/);
  assert.match(invocation.rules, /caspar__project_sandbox/, "platform tools must not erase the space's external creature catalog");
});

await check("attached HTTP MCP servers are written as [mcp_servers.*] url entries", async () => {
  const { renderConfigToml } = await import("../grokConfig.mjs");
  const { httpMcpServersFromCatalog } = await import("../mcpAttach.mjs");
  const catalog = [
    {
      name: "Linear",
      kind: "mcp",
      mcpUrl: "https://mcp.linear.app/mcp",
      mcpToken: "lin_tok",
      program_id: "mcp-1",
    },
    { name: "sandbox", kind: "tool", program_id: "p1", tool_id: "p1" },
  ];
  const { tools } = buildToolDefinitions(catalog);
  assert.equal(tools.some((t) => /linear/i.test(t.name)), false, "MCP servers are not Caspar tools");
  const servers = httpMcpServersFromCatalog(catalog);
  assert.equal(servers.Linear.url, "https://mcp.linear.app/mcp");
  assert.match(servers.Linear.headers.Authorization, /Bearer lin_tok/);
  const toml = renderConfigToml({ mcpServers: { caspar: { command: "node", args: ["x"] }, ...servers } });
  assert.match(toml, /\[mcp_servers\.Linear\]/);
  assert.match(toml, /url = "https:\/\/mcp\.linear\.app\/mcp"/);
  assert.match(toml, /\[mcp_servers\.caspar\]/);
});

await check("an MCP listing with no reachable url is not written as a server", async () => {
  const { httpMcpServersFromCatalog, mcpServerSummaries } = await import("../mcpAttach.mjs");
  // An attach the market creature never hydrated (or a redacted read) carries a
  // host but no url — dialling it would fail at CLI startup, so it is dropped.
  const catalog = [{ name: "Half", kind: "mcp", mcpHost: "mcp.half.dev", program_id: "mcp-2" }];
  assert.deepEqual(httpMcpServersFromCatalog(catalog), {});
  assert.deepEqual(mcpServerSummaries(catalog), []);
});

await check("attached stdio MCP servers are written as command entries", async () => {
  const { renderConfigToml } = await import("../grokConfig.mjs");
  const { httpMcpServersFromCatalog } = await import("../mcpAttach.mjs");
  const servers = httpMcpServersFromCatalog([
    {
      name: "playwright",
      kind: "mcp",
      mcpCommand: "npx",
      mcpArgs: ["-y", "@playwright/mcp@latest"],
      program_id: "mcp-pw",
    },
  ]);
  assert.equal(servers.playwright.command, "npx");
  assert.deepEqual(servers.playwright.args, ["-y", "@playwright/mcp@latest"]);
  const toml = renderConfigToml({ mcpServers: servers });
  assert.match(toml, /\[mcp_servers\.playwright\]/);
  assert.match(toml, /command = "npx"/);
});

await check("an SSE MCP server declares its transport", async () => {
  const { renderConfigToml } = await import("../grokConfig.mjs");
  const { httpMcpServersFromCatalog } = await import("../mcpAttach.mjs");
  const servers = httpMcpServersFromCatalog([
    { name: "Notion", kind: "mcp", mcp_url: "https://mcp.notion.com/stream", mcp_transport: "sse", program_id: "mcp-3" },
  ]);
  assert.equal(servers.Notion.type, "sse");
  assert.match(renderConfigToml({ mcpServers: servers }), /type = "sse"/);
});

await check("the prompt names the space's MCP servers as things the agent can use", async () => {
  const { capabilitiesPreamble } = await import("../prompt.mjs");
  const { mcpServerSummaries } = await import("../mcpAttach.mjs");
  const mcpServers = mcpServerSummaries([
    {
      name: "Linear",
      kind: "mcp",
      description: "issues and projects",
      mcpUrl: "https://mcp.linear.app/mcp",
      program_id: "mcp-1",
    },
  ]);
  const withTools = capabilitiesPreamble(
    [{ name: "caspar__sandbox", description: "the shared machine", kind: "tool" }],
    { mcpServers },
  );
  assert.match(withTools, /caspar__sandbox/, "the space's own creatures are still listed");
  assert.match(withTools, /Linear/, "an attached MCP server must be named");
  assert.match(withTools, /Linear__/, "the agent must be told how its tools are named");
  assert.doesNotMatch(withTools, /mcp\.linear\.app\/mcp/, "no credential-bearing url in the prompt");
  // A space whose only capability is an MCP server still gets the section.
  const mcpOnly = capabilitiesPreamble([], { mcpServers });
  assert.match(mcpOnly, /Linear/);
  assert.equal(capabilitiesPreamble([], {}), "", "no tools and no MCP servers = no section");
});

await check("a native/default-backbone run still gets a bounded idle timeout + retries", async () => {
  // The prior stall fix only wrote resilience knobs into the per-agent
  // `[model.<id>]` block, so an agent on the creature's own backbone (no
  // config.llm → no `[model.<id>]` entry) inherited grok's 600s idle window with
  // no retry tuning — the path where "the agent randomly gets stuck on a step"
  // still bit. The run-wide `[models]` defaults must cover it.
  const { invocation } = await serveWithFakeCli({ scenario: successScenario() });
  assert.match(invocation.config, /\[models\]/, "a native run still writes a [models] block");
  assert.match(invocation.config, /inference_idle_timeout_secs = 180/, "a wedged inference on the default backbone aborts, not hangs");
  assert.match(invocation.config, /max_retries = 4/, "and retries instead of failing the whole run");
  assert.equal(/\[model\./.test(invocation.config), false, "no per-model endpoint is written for the native backbone");

  // Operator override: 0 disables the knob, dropping back to grok's own default.
  const off = await serveWithFakeCli({ scenario: successScenario(), envOverrides: { GROK_CREATURE_INFERENCE_IDLE_TIMEOUT: "0" } });
  assert.equal(/inference_idle_timeout_secs/.test(off.invocation.config), false, "INFERENCE_IDLE_TIMEOUT=0 drops the global idle timeout");
  assert.match(off.invocation.config, /max_retries = 4/, "the retry default is independent of the idle-timeout knob");
});

await check("run-wide [models] defaults do not override a per-agent endpoint's own knobs", () => {
  // A per-agent provider writes its own `[model.<id>]` block; grok applies the
  // global `[models]` scalars as get_or_insert, so the endpoint's own idle
  // timeout still wins. Both blocks are present and the per-model one is intact.
  const config = renderConfigToml({
    defaultModel: "gpt-5",
    modelDefaults: { inferenceIdleTimeoutSec: 180, maxRetries: 4 },
    model: { name: "gpt-5", model: "gpt-5", baseUrl: "https://api.openai.com/v1", apiKey: "k", apiBackend: "responses", streamToolCalls: false, inferenceIdleTimeoutSec: 120, maxRetries: 6 },
  });
  assert.match(config, /\[models\]/);
  assert.match(config, /\[model\.gpt-5\]/);
  assert.match(config, /inference_idle_timeout_secs = 120/, "the per-model idle timeout is written verbatim");
  assert.match(config, /stream_tool_calls = false/, "the openai Responses stream opt-out survives");
});

await check("tools added to a space appear on the next prompt (dynamic catalog)", async () => {
  // The backend sends config.tools fresh with EVERY prompt (DiscoveryService
  // rebuilds it from the space's current programs), and the runtime rebuilds its
  // MCP tool server per prompt from that catalog. So a tool attached to a space
  // later is available on the very next prompt — no redeploy, no per-agent wiring.
  // Prove it by listing tools over the REAL MCP server for two successive catalogs.
  const listToolsFor = async (catalog) => {
    const { tools } = buildToolDefinitions(catalog);
    const socketPath = path.join(tempDir("caspar-dyn-"), "tools.sock");
    const server = await new ToolSocketServer(socketPath, { list: () => tools, call: async () => ({ ok: true }) }).start();
    const child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, CASPAR_TOOL_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    let buffer = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        const w = responses.get(m.id);
        if (w) {
          responses.delete(m.id);
          w(m);
        }
      }
    });
    const rpc = (id, method, params) =>
      new Promise((resolve) => {
        responses.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } });
      const listed = await rpc(2, "tools/list", {});
      return listed.result.tools.map((t) => t.name).sort();
    } finally {
      child.kill();
      await server.stop();
    }
  };

  const webSearch = { name: "web search", tool_id: "40@global", program_id: "40@global", entity_id: "web_search", arg_schema: { query: { type: "string" } }, required: ["query"] };
  const sandbox = { name: "project sandbox", tool_id: "31@global", program_id: "31@global", entity_id: "sandbox", arg_schema: { command: { type: "string" } }, required: ["command"], function: "exec", defaults: { space_id: "space-1" } };

  const before = await listToolsFor([webSearch]);
  const after = await listToolsFor([webSearch, sandbox]);
  assert.deepEqual(before, ["web_search"], "the first prompt sees only the tool the space had then");
  assert.deepEqual(after, ["project_sandbox", "web_search"], "a tool added to the space appears on the next prompt");
});

await check("a failed run still answers, with the reason", async () => {
  const { result, signals } = await serveWithFakeCli({
    scenario: {
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m", tools: [], mcp_servers: [] },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["the model refused"], duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 0 }, modelUsage: {}, permission_denials: [], session_id: "s" },
      ],
    },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /error_during_execution/);
  assert.match(result.answer, /could not complete this request/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1, "a failure is still a reply");
});

await check("a CLI that produces no result still answers", async () => {
  const { result, signals } = await serveWithFakeCli({ scenario: { messages: [], exitCode: 3 } });
  assert.equal(result.success, false);
  assert.match(result.error, /no result/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("a clean exit whose terminal result line never arrives recovers the assistant's answer", async () => {
  // The CLI exits 0 having spoken, but no `type:"result"` line reaches the bridge
  // (the exact shape of the 'produced no result (exit code 0)' failure). Because
  // the run actually answered, the reply is that answer — not a failure.
  const { result, signals } = await serveWithFakeCli({
    scenario: {
      exitCode: 0,
      messages: [
        { type: "system", subtype: "init", session_id: "sess-1", model: "grok-build", tools: [], mcp_servers: [] },
        { type: "assistant", message: { content: [{ type: "text", text: "Hi! How can I help you today?" }] }, session_id: "sess-1" },
      ],
    },
  });
  assert.equal(result.success, true, "a run that spoke but lost its result line is not a failure");
  assert.equal(result.answer, "Hi! How can I help you today?");
  assert.ok(Array.isArray(result.warnings) && result.warnings.some((w) => /terminal result line/.test(w)), "the recovery is surfaced as a warning");
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("a result line emitted without a trailing newline is still parsed (flush on close)", async () => {
  // The terminal `result` arrives unterminated (process truncated at exit). The
  // bridge must flush its buffer on close and read it, not drop the whole run.
  const { result } = await serveWithFakeCli({ scenario: { ...successScenario("The deploy is green."), noFinalNewline: true } });
  assert.equal(result.success, true, "the unterminated result line must still be captured");
  assert.equal(result.answer, "The deploy is green.");
});

await check("a no-result reply surfaces the CLI's non-JSON stdout so the cause is visible", async () => {
  // The CLI prints an error/notice to stdout instead of stream-json and exits 0.
  // stderr is empty, no result line — exactly the opaque 'exit code 0' failure.
  // The reply must carry what the CLI actually said.
  const { result } = await serveWithFakeCli({
    scenario: { exitCode: 0, stdoutNoise: "warning: this build of grok is out of date; run `grok update`.", messages: [] },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /no result \(exit code 0\)/);
  assert.match(result.error, /non-JSON to stdout/);
  assert.match(result.error, /out of date/);
});

await check("a no-result reply names the messages the CLI did emit when stdout is clean", async () => {
  // The CLI booted (system/init) but never produced a terminal result and left
  // nothing on stderr/stdout — the reply reports which messages it did see.
  const { result } = await serveWithFakeCli({
    scenario: { exitCode: 0, messages: [{ type: "system", subtype: "init", session_id: "s", model: "m", tools: [], mcp_servers: [] }] },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /messages seen: system\/init/);
});

await check("a run that never finishes is ended by its wall-clock budget", async () => {
  const { result, signals } = await serveWithFakeCli({ scenario: { hang: true }, envOverrides: { GROK_CREATURE_MAX_WALL_SECONDS: "2" } });
  assert.equal(result.success, false);
  assert.equal(result.budget.timed_out, true);
  assert.match(result.error, /wall-clock budget/);
  assert.equal(signals.filter((s) => s.packet.kind === "davinci/result").length, 1);
});

await check("a run with no space pushes its steps straight at the requester", async () => {
  // A spaceless prompt (the market advisor staffing a brief) has no store to
  // post to, so the steps go to the requester's own connection instead.
  const { signals, storeSignals } = await serveWithFakeCli({
    scenario: successScenario(),
    delivery: proxyDelivery({ extra: { spaceId: "" } }),
  });
  assert.equal(storeSignals.length, 0, "no space, so nothing is posted to a store");
  const steps = signals.filter((s) => s.packet.kind === "davinci/step");
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.userId === "9@global"), "steps go to the prompting user (streamTo)");
  assert.ok(
    steps.every((s) => s.packet.stream === true && s.packet.final === false),
    "the node keeps the correlation open only for chunks marked non-terminal",
  );
});

await check("with no space and no streamTo, steps ride the proxy as non-terminal chunks", async () => {
  const { signals } = await serveWithFakeCli({
    scenario: successScenario(),
    delivery: proxyDelivery({ streamTo: "", extra: { spaceId: "" } }),
  });
  const steps = signals.filter((s) => s.packet.kind === "davinci/step");
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.userId === "8@global"), "steps address the proxy reply path");
});

for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch {
    /* best effort */
  }
}

await check("space history records become annotated group-chat turns for the running agent", () => {
  const self = { id: "res-a", name: "Ada", handle: "ada" };
  const meMention = [{ id: "res-a", kind: "agent", name: "Ada", handle: "ada" }];
  // Signal packets as `readSpaceSignals` yields them, oldest first.
  const packets = [
    { id: "s1", time: 1, tags: ["kind=message"], data: { from: "user", fromName: "Grace", text: "hi @ada", mentions: meMention } },
    { id: "s2", time: 2, tags: ["kind=answer"], data: { from: "agent", agentName: "Ada", text: "hello Grace", mentions: [] } },
    { id: "s3", time: 3, tags: ["kind=answer"], data: { from: "agent", agentName: "Babbage", text: "@ada take a look", mentions: meMention } },
    { id: "s4", time: 4, tags: ["kind=message"], data: { from: "user", fromName: "Grace", text: "current message", mentions: [] } },
  ];
  const turns = buildHistoryTurns(packets, self, { excludeText: "current message" });
  assert.equal(turns.length, 3, "the current message is excluded; the rest are kept oldest-first");
  // A human turn addressed to me.
  assert.deepEqual(turns[0], { role: "user", content: "hi @ada", from: "Grace", to: [{ name: "Ada", handle: "ada" }], directedToMe: true });
  // My own past answer renders as the assistant ("you"), aimed at nobody.
  assert.equal(turns[1].role, "assistant", "the running agent's own turns are the assistant");
  assert.equal(turns[1].from, "Ada");
  assert.equal(turns[1].directedToMe, false);
  // Another agent's turn is a "user" turn from my perspective, and it @mentions me.
  assert.equal(turns[2].role, "user", "another agent's turn is not 'you'");
  assert.equal(turns[2].from, "Babbage");
  assert.equal(turns[2].directedToMe, true);
});

await check("the backbone reads the space's conversation from the node's tag-filtered signal log", async () => {
  // The log reads newest-first; a conversation reads oldest-first.
  const rows = [
    { id: "s3", userId: "1@global", time: 3, tags: ["kind=answer", "thread=main"], data: JSON.stringify({ from: "agent", agentName: "Lead", text: "third" }) },
    { id: "s2", userId: "1@global", time: 2, tags: ["kind=answer", "thread=main"], data: JSON.stringify({ from: "agent", agentName: "Lead", text: "second" }) },
    { id: "s1", userId: "1@global", time: 1, tags: ["kind=message", "thread=main"], data: JSON.stringify({ from: "user", fromName: "Sam", text: "first" }) },
  ];
  let seen = null;
  const bridge = {
    async call(op, input) {
      if (op !== "readSignals") return {};
      seen = input;
      return { ok: true, storeId: input.storeId, signals: rows };
    },
  };
  const packets = await fetchSpaceConversation(bridge, { spaceId: "sp", threadId: "main" });
  assert.equal(seen.storeId, "sp");
  assert.deepEqual(seen.tagsAll, ["thread=main"], "the read is scoped to the run's thread");
  assert.deepEqual(seen.tagsAny, ["kind=message", "kind=answer"], "only conversation kinds — never steps or tool calls");
  const turns = buildHistoryTurns(packets, { name: "Writer" }, {});
  assert.deepEqual(turns.map((t) => t.content), ["first", "second", "third"], "turns run oldest→newest");
});

await check("an unreadable signal log leaves the run with no history instead of failing it", async () => {
  const throwing = { async call() { throw new Error("boom"); } };
  assert.deepEqual(await readSpaceSignals(throwing, { spaceId: "sp" }), []);
  assert.deepEqual(await readSpaceSignals(null, { spaceId: "sp" }), []);
  // A row whose data is not JSON is skipped, not fatal.
  const garbled = {
    async call() {
      return { signals: [{ id: "s1", data: "not json", tags: [], time: 1 }, { id: "s2", data: JSON.stringify({ text: "ok" }), tags: [], time: 2 }] };
    },
  };
  const rows = await readSpaceSignals(garbled, { spaceId: "sp" });
  assert.equal(rows.length, 1, "the readable row survives its garbled neighbour");
  assert.equal(rows[0].data.text, "ok");
});

await check("posting a turn tags it with kind, thread, agent, run and each mention", async () => {
  let sent = null;
  // The node answers with what it DID: a recorded signal comes back
  // `persisted: true`; a temp one is delivered and deliberately not recorded.
  const bridge = {
    async call(op, input) {
      if (op !== "signal") return { ok: true };
      sent = input;
      return { ok: true, persisted: !input.temp, signalId: "sig-1", time: 5 };
    },
  };
  await postSpaceSignal(bridge, {
    spaceId: "sp",
    kind: KIND.ANSWER,
    threadId: "t-7",
    agentProgramId: "90@global",
    correlationId: "abc123",
    mentions: [{ programId: "91@global" }],
    data: { text: "done" },
  });
  assert.equal(sent.storeId, "sp");
  assert.deepEqual(sent.tags, ["kind=answer", "thread=t-7", "agent=90@global", "run=abc123", "mention=91@global"]);
  assert.equal(JSON.parse(sent.data).text, "done");
  assert.equal(sent.temp, undefined, "a turn is persisted, never temp");

  // A heartbeat is delivered but never recorded.
  await postSpaceSignal(bridge, { spaceId: "sp", kind: KIND.STEP, threadId: "t-7", temp: true, data: {} });
  assert.equal(sent.temp, true);

  // A turn with no space is a programming error, not a silent no-op.
  await assert.rejects(() => postSpaceSignal(bridge, { spaceId: "", kind: KIND.ANSWER, data: {} }));

  // A store that accepted the signal but did NOT record it has lost the turn:
  // it was shown to whoever was connected and is gone by the next read. That
  // must fail the post, not pass as a success.
  const unrecorded = { async call() { return { ok: true, persisted: false }; } };
  await assert.rejects(
    () => postSpaceSignal(unrecorded, { spaceId: "sp", kind: KIND.ANSWER, data: { text: "lost" } }),
    /did not record/,
  );
  // A heartbeat is the one thing allowed to go unrecorded.
  await postSpaceSignal(unrecorded, { spaceId: "sp", kind: KIND.STEP, temp: true, data: {} });
});

await check("the serve loop processes prompts in parallel — a slow prompt does not block others", async () => {
  // Each run's fake CLI sleeps before answering, so its work has a measurable
  // duration. If the loop served serially the second reply would land ~a full
  // sleep after the first; served in parallel both finish within a moment of
  // each other. We assert on the GAP between the two terminal results, which is
  // robust to how long process startup takes on the host.
  const SLEEP_MS = 1500;
  const sleepScenario = {
    messages: [
      { type: "system", subtype: "init", session_id: "sess", model: "grok-build", tools: [], mcp_servers: [] },
      { __sleepMs: SLEEP_MS },
      ...successScenario("done").messages,
    ],
  };
  const { file } = scenarioFile(sleepScenario);
  const workspaceRoot = tempDir("caspar-ws-");
  const previous = { ...process.env };
  Object.assign(process.env, {
    CASPAR_GATEWAY_HOST: "127.0.0.1",
    GROK_BIN: FAKE_CLI,
    GROK_FAKE_SCENARIO: file,
    GROK_FAKE_RECORD: "", // a single record path would be clobbered by two runs
    GROK_CREATURE_WORKSPACE_ROOT: workspaceRoot,
    GROK_CREATURE_CONFIG_DIR: path.join(workspaceRoot, "config"),
    GROK_CREATURE_MAX_WALL_SECONDS: "30",
    GROK_CREATURE_USER: "",
    GROK_CREATURE_MAX_CONCURRENT_PROMPTS: "4",
    GROK_CREATURE_DISCOVER_TOOLS: "false",
    GROK_CREATURE_TASK_WAIT: "30",
    GROK_CREATURE_RECONNECT_ATTEMPTS: "1",
  });
  const gateway = await new FakeGateway().listen();
  process.env.CASPAR_GATEWAY_PORT = String(gateway.port);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Two prompts for two DIFFERENT agents (distinct proxy program ids, hence
  // distinct sessions and workspaces) with distinct correlations. Different
  // agents are exactly what must stay parallel — one agent's own prompts are
  // serialized onto its task board (checked separately below).
  const a = proxyDelivery({ prompt: "slow-a", correlationId: "cc-a", replyTo: "8@global", extra: { sessionId: "space:space-1:agent-a", self: { id: "res-tina", name: "Tina", handle: "tina" } } });
  const b = proxyDelivery({ prompt: "slow-b", correlationId: "cc-b", replyTo: "18@global", extra: { sessionId: "space:space-1:agent-b", self: { id: "res-bob", name: "Bob", handle: "bob" } } });

  const { main } = await import("../runtime.mjs");
  const mainPromise = main();
  try {
    // The gateway can only push to a connected creature, so wait for the serve
    // loop's bridge to hand-shake before delivering the prompts.
    for (let i = 0; i < 300 && gateway.sockets.size === 0; i++) await sleep(10);
    assert.ok(gateway.sockets.size > 0, "the creature connected to the gateway");
    await sleep(50); // let the serve loop subscribe (early-signal buffer covers the race regardless)

    gateway.pushSignal(a.key, a.data);
    gateway.pushSignal(b.key, b.data);

    let firstAt = 0;
    let secondAt = 0;
    for (let i = 0; i < 600; i++) {
      const finals = gateway.signals().filter((s) => s.packet.kind === "davinci/result");
      if (finals.length >= 1 && !firstAt) firstAt = Date.now();
      if (finals.length >= 2) {
        secondAt = Date.now();
        break;
      }
      await sleep(20);
    }

    const finals = gateway.signals().filter((s) => s.packet.kind === "davinci/result");
    const correlations = new Set(finals.map((s) => s.packet.correlationId));
    assert.equal(finals.length, 2, "both prompts produced a terminal result");
    assert.deepEqual([...correlations].sort(), ["cc-a", "cc-b"], "each prompt replied on its own correlation (its own stream)");
    // Served serially, the gap would be ~SLEEP_MS; served in parallel it is tiny.
    assert.ok(
      secondAt - firstAt < SLEEP_MS - 500,
      `the two results landed ${secondAt - firstAt}ms apart — serial would be ~${SLEEP_MS}ms, so the second prompt was not blocked behind the first`,
    );
  } finally {
    // Drop the link and stop listening so the serve loop's reconnect fails and
    // main() returns instead of idling forever.
    for (const socket of [...gateway.sockets]) socket.destroy();
    await gateway.close();
    await Promise.race([mainPromise, sleep(8000)]);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

await check("two prompts for the SAME agent are serialized on its task board", async () => {
  // The other side of the parallelism check above: one agent is one worker, so
  // the second prompt must NOT start a second instance of it. It is queued
  // instead, and answered immediately with a `queued` result so the client is
  // never left holding an authorization open for an unknown wait.
  const SLEEP_MS = 1500;
  const sleepScenario = {
    messages: [
      { type: "system", subtype: "init", session_id: "sess", model: "grok-build", tools: [], mcp_servers: [] },
      { __sleepMs: SLEEP_MS },
      ...successScenario("done").messages,
    ],
  };
  const { file } = scenarioFile(sleepScenario);
  const workspaceRoot = tempDir("caspar-ws-");
  const previous = { ...process.env };
  Object.assign(process.env, {
    CASPAR_GATEWAY_HOST: "127.0.0.1",
    GROK_BIN: FAKE_CLI,
    GROK_FAKE_SCENARIO: file,
    GROK_FAKE_RECORD: "",
    GROK_CREATURE_WORKSPACE_ROOT: workspaceRoot,
    GROK_CREATURE_CONFIG_DIR: path.join(workspaceRoot, "config"),
    GROK_CREATURE_MAX_WALL_SECONDS: "30",
    GROK_CREATURE_USER: "",
    GROK_CREATURE_MAX_CONCURRENT_PROMPTS: "4",
    GROK_CREATURE_DISCOVER_TOOLS: "false",
    GROK_CREATURE_TASK_WAIT: "30",
    GROK_CREATURE_RECONNECT_ATTEMPTS: "1",
  });
  const gateway = await new FakeGateway().listen();
  process.env.CASPAR_GATEWAY_PORT = String(gateway.port);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Same agent (same proxy program id), two prompts arriving together.
  const a = proxyDelivery({ prompt: "first job", correlationId: "same-a", replyTo: "8@global" });
  const b = proxyDelivery({ prompt: "second job", correlationId: "same-b", replyTo: "8@global" });

  const { main } = await import("../runtime.mjs");
  const mainPromise = main();
  try {
    for (let i = 0; i < 300 && gateway.sockets.size === 0; i++) await sleep(10);
    assert.ok(gateway.sockets.size > 0, "the creature connected to the gateway");
    await sleep(50);

    gateway.pushSignal(a.key, a.data);
    gateway.pushSignal(b.key, b.data);

    for (let i = 0; i < 600; i++) {
      if (gateway.signals().filter((s) => s.packet.kind === "davinci/result").length >= 2) break;
      await sleep(20);
    }
    const finals = gateway.signals().filter((s) => s.packet.kind === "davinci/result");
    assert.equal(finals.length, 2, "both prompts were answered");
    const byCorrelation = new Map(finals.map((s) => [s.packet.correlationId, s.packet.result]));
    const queued = [...byCorrelation.values()].filter((r) => r?.queued === true);
    assert.equal(queued.length, 1, "exactly one of the two was queued behind the other");
    assert.ok(queued[0].task?.taskId, "the queued reply names the task it created");
    assert.ok(queued[0].task?.title, "and its title, so the client can show what is waiting");

    // The board says the same thing: two tasks queued, only one ever started.
    const taskRows = gateway.storeSignals().filter((s) => (s.tags || []).includes("kind=task"));
    const events = taskRows.map((s) => s.data.event);
    assert.equal(events.filter((e) => e === "queued").length, 2, "both prompts became tasks");
    assert.equal(events.filter((e) => e === "started").length, 1, "only one instance of the agent ever ran");
  } finally {
    for (const socket of [...gateway.sockets]) socket.destroy();
    await gateway.close();
    await Promise.race([mainPromise, sleep(8000)]);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
