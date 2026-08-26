#!/usr/bin/env node
/**
 * Checks for live in-space discovery (caspar/discovery.mjs) and the capability
 * preamble it feeds into the system prompt.
 *
 * Pure functions are asserted directly; the fetch is driven end to end against
 * the real `FakeGateway` (real wire protocol) with an `onCall` that answers
 * `readMembers` + `getCreature` the way a node would. Asserts:
 *   • the space id is resolved from the task (explicit and via sessionId);
 *   • the fetch lists the store's members and reads each one's descriptor;
 *   • a member with no decillion descriptor is skipped;
 *   • discovered entries merge into config.tools WITHOUT displacing a backend
 *     entry (which keeps its platform-pinned defaults);
 *   • the merged catalog becomes callable MCP tools and is enumerated for the
 *     model, sub-agents included.
 *
 * Run: node caspar/tests/discovery-checks.mjs
 */

import assert from "node:assert/strict";

import { buildToolDefinitions, mergeCatalogs } from "../catalog.mjs";
import { DEFAULT_BUILTIN_FS_TOOLS, SANDBOX_LOCAL_FS_READERS, disallowedBuiltinTools } from "../grokRunner.mjs";
import { discoverSpaceCatalog, entryFromDescriptor, extractDescriptor, resolveSpaceId } from "../discovery.mjs";
import { WARM_FUNCTION, prewarmToolContainers } from "../prewarm.mjs";
import { bridgeFromEnv } from "../bridge.mjs";
import { buildSystemPrompt, capabilitiesPreamble } from "../prompt.mjs";
import { persistSpaceMessage, signalEndpointFromTask } from "../spaceHistory.mjs";
import { FakeGateway } from "./fakeGateway.mjs";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let passed = 0;
const failures = [];

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

// ── Fixtures ────────────────────────────────────────────────────────────────
const SANDBOX_META = { public: { decillion: { kind: "tool", name: "sandbox", usecases: ["run code", "edit files"], howToTalk: "call exec/write/read", argSchema: { command: { type: "string" } }, function: "exec" } } };
const RESEARCHER_META = { decillion: { kind: "agent", name: "Researcher", usecases: ["deep research"], howToTalk: "ask in prose" } };

/** A node-shaped onCall: readMembers → members; getCreature → its metadata;
 * getJson(StoreProgramIndex) → the space's attached programs (tools + agents). */
function nodeBehaviour({ members, metaById, programIndex }) {
  return (op, input) => {
    if (op === "getJson") {
      const key = String(input?.key || "");
      if (programIndex && key === "Json::StoreProgramIndex::space-1") return { ok: true, data: programIndex };
      return { ok: true };
    }
    if (op === "readMembers" || op === "listStoreMembers" || op === "listStoreAccess" || op === "listAccess") {
      // Only answer for the right store; otherwise behave like "unknown store".
      if (input?.storeId !== "space-1" && input?.id !== "space-1") return { ok: true, members: [] };
      return { ok: true, members };
    }
    if (op === "getCreature") {
      const meta = metaById[input?.userId || input?.creatureId];
      return meta ? { ok: true, obj: meta } : { ok: true };
    }
    return { ok: true };
  };
}

async function withBridge(onCall, fn) {
  const gw = new FakeGateway({ identity: { programId: "9@global", creatureId: "8@global" }, onCall });
  await gw.listen();
  const prevHost = process.env.CASPAR_GATEWAY_HOST;
  const prevPort = process.env.CASPAR_GATEWAY_PORT;
  process.env.CASPAR_GATEWAY_HOST = "127.0.0.1";
  process.env.CASPAR_GATEWAY_PORT = String(gw.port);
  let bridge;
  try {
    bridge = await bridgeFromEnv({ timeoutMs: 4000 });
    return await fn(bridge, gw);
  } finally {
    if (bridge) bridge.close();
    await gw.close();
    if (prevHost === undefined) delete process.env.CASPAR_GATEWAY_HOST;
    else process.env.CASPAR_GATEWAY_HOST = prevHost;
    if (prevPort === undefined) delete process.env.CASPAR_GATEWAY_PORT;
    else process.env.CASPAR_GATEWAY_PORT = prevPort;
  }
}

async function main() {
  // ── pure helpers ──────────────────────────────────────────────────────────
  await check("resolveSpaceId reads explicit id and parses sessionId", () => {
    assert.equal(resolveSpaceId({ spaceId: "s-1" }), "s-1");
    assert.equal(resolveSpaceId({ storeId: "s-2" }), "s-2");
    assert.equal(resolveSpaceId({ sessionId: "space:s-3:agent-x" }), "s-3");
    assert.equal(resolveSpaceId({ sessionId: "grok-default" }), "");
    assert.equal(resolveSpaceId({}), "");
  });

  await check("extractDescriptor handles public.decillion, decillion, and bare", () => {
    assert.equal(extractDescriptor({ obj: SANDBOX_META }).name, "sandbox");
    assert.equal(extractDescriptor({ obj: RESEARCHER_META }).kind, "agent");
    assert.equal(extractDescriptor({ kind: "tool", name: "x", usecases: [] }).name, "x");
    assert.equal(extractDescriptor({ obj: { nothing: true } }), undefined);
    assert.equal(extractDescriptor(null), undefined);
  });

  await check("entryFromDescriptor yields a catalog entry catalog.mjs can route", () => {
    const e = entryFromDescriptor(SANDBOX_META.public.decillion, { creatureId: "c1", programId: "p1", entityId: "" });
    assert.equal(e.program_id, "p1");
    assert.equal(e.entity_id, "main");
    assert.equal(e.function, "exec");
    assert.ok(e.description.includes("Use when"));
    const a = entryFromDescriptor(RESEARCHER_META.decillion, { creatureId: "c2", programId: "p2", entityId: "" });
    assert.equal(a.kind, "agent");
    assert.equal(a.entity_id, "agent"); // agents default to the proxy's agent entity
    // Agents are participants, not tools: buildToolDefinitions filters them out so
    // an agent can only ever be reached by @mention, never a synchronous tool call.
    const { tools, byName } = buildToolDefinitions([e, a]);
    assert.equal(tools.length, 1, "only the tool is callable — the agent is dropped");
    assert.ok(![...byName.values()].some((v) => v.kind === "agent"), "no agent is exposed as a callable tool");
  });

  await check("mergeCatalogs keeps backend entries and only adds new ones", () => {
    const backend = [{ name: "sandbox", program_id: "p1", defaults: { space_id: "space-1" } }];
    const discovered = [
      { name: "sandbox-dup", program_id: "p1" }, // same id → dropped, backend wins (keeps defaults)
      { name: "researcher", program_id: "p2", kind: "agent" }, // new → added
    ];
    const merged = mergeCatalogs(backend, discovered);
    assert.equal(merged.length, 2);
    const sandbox = merged.find((e) => e.program_id === "p1");
    assert.equal(sandbox.name, "sandbox");
    assert.deepEqual(sandbox.defaults, { space_id: "space-1" }); // binding preserved
    assert.ok(merged.find((e) => e.program_id === "p2"));
  });

  await check("capabilitiesPreamble enumerates tools only — agents are @mention participants, not tools", () => {
    assert.equal(capabilitiesPreamble([]), "");
    // A caps list of only agents yields nothing: agents are never a callable tool.
    assert.equal(capabilitiesPreamble([{ name: "Researcher", description: "deep research", kind: "agent" }]), "");
    const text = capabilitiesPreamble([
      { name: "sandbox", description: "run code", kind: "tool" },
      { name: "Researcher", description: "deep research", kind: "agent" },
    ]);
    assert.ok(text.includes("WHAT YOU CAN DO IN THIS SPACE"));
    assert.ok(text.includes("sandbox"));
    // No synchronous "delegate to a sub-agent" surface, and the agent is not listed.
    assert.ok(!/delegate to/i.test(text), "no synchronous sub-agent delegation is offered");
    assert.ok(!text.includes("Researcher"), "another agent is never listed as a callable capability");
    // it steers cross-agent work to @mention instead
    assert.ok(/@mention/i.test(text), "it points cross-agent work to @mention");
    // it tells the model to answer capability questions with THESE, not built-ins
    assert.ok(/not the generic editor\/shell built-ins/i.test(text));
    // it is included in the full system prompt
    const sys = buildSystemPrompt({ spaceId: "space-1" }, { capabilities: [{ name: "sandbox", description: "run code", kind: "tool" }] });
    assert.ok(sys.includes("sandbox"));
  });

  await check("shared sandbox reframes the agent's filesystem as the space's shared machine", () => {
    const caps = [{ name: "sandbox", description: "run code", kind: "tool" }];
    const withEnv = capabilitiesPreamble(caps, { sharedEnv: { name: "sandbox", description: "run code" } });
    assert.ok(/SHARED WORKSPACE/i.test(withEnv));
    assert.ok(/private scratch/i.test(withEnv), "it warns the local dir is private");
    // no shared-env block when the space has no shared machine
    const noEnv = capabilitiesPreamble(caps);
    assert.ok(!/SHARED WORKSPACE/i.test(noEnv));
    // the delivery section no longer tells the agent to work in its own local dir
    const sys = buildSystemPrompt({ spaceId: "space-1" }, { capabilities: caps, sharedEnv: { name: "sandbox", description: "run code" } });
    assert.ok(/shared machine/i.test(sys));
  });

  await check("living project brief is injected into every system prompt", () => {
    const withBrief = buildSystemPrompt(
      { spaceId: "space-1", projectBrief: "Launch a neighbourhood cafe with a partner." },
      { capabilities: [{ name: "sandbox", description: "run code", kind: "tool" }] },
    );
    assert.ok(/PROJECT OUTCOME/i.test(withBrief));
    assert.ok(withBrief.includes("Launch a neighbourhood cafe with a partner."));
    const viaBrief = buildSystemPrompt({ spaceId: "space-1", brief: "Ship the API" });
    assert.ok(viaBrief.includes("Ship the API"));
    const none = buildSystemPrompt({ spaceId: "space-1" });
    assert.ok(!/PROJECT OUTCOME/i.test(none));
  });

  await check("built-in shell/fs tools are denied unconditionally (never a fallback)", () => {
    // the shell + filesystem built-ins are always off, sandbox present or not
    const denied = disallowedBuiltinTools({ env: {} });
    assert.deepEqual(denied, DEFAULT_BUILTIN_FS_TOOLS);
    for (const off of ["run_terminal_cmd", "read_file", "write", "search_replace", "apply_patch", "list_dir", "grep"]) {
      assert.ok(denied.includes(off), `${off} must be denied — it is local shell/filesystem work`);
    }
    // planning / web tools are NOT denied — and neither are the MCP meta-tools,
    // which are the ONLY way the agent reaches the space's creatures.
    for (const keep of ["todo_write", "enter_plan_mode", "exit_plan_mode", "web_search", "web_fetch", "use_tool", "search_tool"]) {
      assert.ok(!denied.includes(keep), `${keep} must stay enabled`);
    }
    // the `task` requirement invariant: the grok binary rejects a toolset that has
    // `task` without `get_task_output` + `kill_task`. The monitors are not in the
    // base toolset for us to keep, so the whole background-task family is denied as
    // a unit when there is no sandbox — never a subset, which would fail init with
    // RequirementError { tool: GrokBuild:task }.
    for (const fam of ["task", "get_task_output", "kill_task"]) {
      assert.ok(denied.includes(fam), `${fam} must be denied without a sandbox (background-task family off as a unit)`);
    }
    // operator can disable the enforcement or override the list
    assert.deepEqual(disallowedBuiltinTools({ env: { GROK_CREATURE_FORCE_SANDBOX_FS: "0" } }), []);
    assert.deepEqual(disallowedBuiltinTools({ env: { GROK_CREATURE_DISALLOWED_TOOLS: "run_terminal_cmd, foo" } }), ["run_terminal_cmd", "foo"]);
    // with a sandbox present, the prompt points shell/file work at it by name
    const withSb = buildSystemPrompt(
      { spaceId: "space-1" },
      { capabilities: [{ name: "sandbox", description: "run code", kind: "tool" }], sharedEnv: { name: "sandbox", description: "run code" }, disabledBuiltins: denied },
    );
    assert.ok(/turned OFF/i.test(withSb) && /`sandbox`/.test(withSb));
    // with NO sandbox in the catalog yet, the prompt still tells the model its
    // local shell/files are gone (so it never silently falls back to them)
    const noSb = buildSystemPrompt({ spaceId: "space-1" }, { capabilities: [], disabledBuiltins: denied });
    assert.ok(/NO LOCAL SHELL OR FILESYSTEM/i.test(noSb));
    assert.ok(/DISABLED/i.test(noSb));
  });

  await check("with the sandbox backend active, only the local-disk search tools are denied", () => {
    const denied = disallowedBuiltinTools({ env: {}, sandboxActive: true });
    // Exactly the tools that read the CLI's own container (never the backends).
    assert.deepEqual(denied, SANDBOX_LOCAL_FS_READERS);
    for (const off of ["list_dir", "glob", "grep", "grep_files", "hashline_grep"]) {
      assert.ok(denied.includes(off), `${off} must stay denied under the sandbox — it reads local disk`);
    }
    // Everything that DOES route through SandboxTerminalBackend / SandboxFileSystem
    // stays enabled — those built-ins ARE the sandbox now.
    for (const keep of ["bash", "run_terminal_cmd", "read_file", "read", "write", "edit", "search_replace", "apply_patch"]) {
      assert.ok(!denied.includes(keep), `${keep} must stay enabled under the sandbox (routes to the VM)`);
    }
    // The background-task family stays ON so grok's `task` requirement on
    // get_task_output + kill_task is satisfied (denying them broke session init).
    for (const fam of ["task", "get_task_output", "kill_task", "wait_tasks", "monitor"]) {
      assert.ok(!denied.includes(fam), `${fam} must stay enabled under the sandbox (task requirement)`);
    }
    // The denied set is a strict subset of the no-sandbox deny list, so it can
    // never make a grok tool requirement newly unsatisfiable.
    for (const t of denied) {
      assert.ok(DEFAULT_BUILTIN_FS_TOOLS.includes(t), `${t} is a subset of the no-sandbox deny list`);
    }
    // Operator escapes: fully re-enable, or override the exact list.
    assert.deepEqual(disallowedBuiltinTools({ env: { GROK_CREATURE_SANDBOX_DENY_LOCAL_SEARCH: "0" }, sandboxActive: true }), []);
    assert.deepEqual(
      disallowedBuiltinTools({ env: { GROK_CREATURE_DISALLOWED_TOOLS: "glob, foo" }, sandboxActive: true }),
      ["glob", "foo"],
    );
  });

  await check("prewarm spawns each tool/agent container once, sandbox via start, no prompts", () => {
    const calls = [];
    const invoker = { invoke: (name, args) => { calls.push({ name, args }); return Promise.resolve({ ok: true }); } };
    const toolDefs = [
      { name: "sandbox" },
      { name: "web_search" },
      { name: "researcher" },   // an agent
      { name: "dashboard" },    // a frontend — skipped
      { name: "generate_media" }, // in-process, no machine — skipped
      { name: "sandbox_dup" },  // shares the sandbox's target — deduped
    ];
    const byName = new Map([
      ["sandbox", { name: "sandbox", kind: "tool", program_id: "px-sandbox", defaults: { space_id: "s1" } }],
      ["web_search", { name: "web_search", kind: "tool", program_id: "px-web" }],
      ["researcher", { name: "researcher", kind: "agent", program_id: "px-research" }],
      ["dashboard", { name: "dashboard", kind: "frontend", program_id: "px-front" }],
      ["generate_media", { name: "generate_media", kind: "media" }],
      ["sandbox_dup", { name: "sandbox_dup", kind: "tool", program_id: "px-sandbox" }],
    ]);
    const fired = prewarmToolContainers(invoker, toolDefs, byName, { sandboxToolName: "sandbox" });

    // One warm per distinct target: sandbox, web_search, researcher. Frontend,
    // media (no machine), and the duplicate sandbox target are all skipped.
    assert.deepEqual(fired.map((f) => f.tool).sort(), ["researcher", "sandbox", "web_search"]);
    assert.equal(calls.length, 3);
    const bySandbox = calls.find((c) => c.name === "sandbox");
    assert.equal(bySandbox.args.function, "start", "sandbox is warmed with start (boots the VM too)");
    for (const other of ["web_search", "researcher"]) {
      const c = calls.find((x) => x.name === other);
      assert.equal(c.args.function, WARM_FUNCTION, `${other} warmed with the reserved no-op function`);
    }
    // Critically: no warm carries an objective/prompt/skill, so an agent proxy's
    // decodeTaskSignal drops it (no LLM run).
    for (const c of calls) {
      for (const k of ["objective", "prompt", "skill"]) {
        assert.ok(!(k in c.args), `warm args must not carry ${k}`);
      }
    }
    // Master switch off → nothing fired.
    const noneFired = prewarmToolContainers(invoker, toolDefs, byName, { sandboxToolName: "sandbox", env: { GROK_CREATURE_PREWARM_TOOLS: "0" } });
    assert.deepEqual(noneFired, []);
    // A null invoker (no bridge) is a safe no-op.
    assert.deepEqual(prewarmToolContainers(null, toolDefs, byName, {}), []);
  });

  // ── live fetch over the real gateway wire ──────────────────────────────────
  await check("discoverSpaceCatalog fetches members + descriptors from the node", async () => {
    const members = [
      { creatureId: "cx-sandbox", programId: "px-sandbox", entityId: "main" },
      { creatureId: "cx-researcher", programId: "px-researcher" },
      { creatureId: "cx-plain", programId: "px-plain" }, // no descriptor → skipped
    ];
    const metaById = { "cx-sandbox": SANDBOX_META, "cx-researcher": RESEARCHER_META };
    await withBridge(nodeBehaviour({ members, metaById }), async (bridge, gw) => {
      const entries = await discoverSpaceCatalog(bridge, { spaceId: "space-1" }, { timeoutMs: 3000 });
      assert.equal(entries.length, 2, "only the two creatures with a descriptor");
      const names = entries.map((e) => e.name).sort();
      assert.deepEqual(names, ["Researcher", "sandbox"]);
      assert.ok(entries.find((e) => e.program_id === "px-sandbox"));
      // it actually listed members and read each creature over the gateway
      assert.ok(gw.calls.some((c) => /Members|Access/i.test(c.op)), "a member-listing host call was made");
      assert.equal(gw.calls.filter((c) => c.op === "getCreature").length, 3, "each member's creature record was read");
    });
  });

  await check("discoverSpaceCatalog reads the program index (where tools/agents are attached)", async () => {
    // Platform tools + sub-agents are attached as PROGRAMS, not store members.
    const programIndex = {
      "px-sandbox": {
        programId: "px-sandbox", creatureId: "cx-sandbox", entityId: "sandbox",
        metadata: { name: "sandbox", descriptor: SANDBOX_META.public.decillion, defaults: { space_id: "space-1" } },
      },
      "px-researcher": {
        programId: "px-researcher", creatureId: "cx-researcher", entityId: "agent",
        metadata: { descriptor: RESEARCHER_META.decillion },
      },
      // A record with no descriptor but a name still surfaces (older spaces).
      "px-legacy": { programId: "px-legacy", creatureId: "cx-legacy", metadata: { name: "legacy-tool" } },
    };
    await withBridge(nodeBehaviour({ members: [], metaById: {}, programIndex }), async (bridge, gw) => {
      const entries = await discoverSpaceCatalog(bridge, { spaceId: "space-1" }, { timeoutMs: 3000 });
      const names = entries.map((e) => e.name).sort();
      // The descriptor's own name ("sandbox") wins over the record's name.
      assert.deepEqual(names, ["Researcher", "legacy-tool", "sandbox"]);
      const sb = entries.find((e) => e.program_id === "px-sandbox");
      assert.equal(sb.entity_id, "sandbox");
      assert.deepEqual(sb.defaults, { space_id: "space-1" }, "the platform-pinned space binding is carried");
      // The index carries descriptors inline — no per-member getCreature needed.
      assert.equal(gw.calls.filter((c) => c.op === "getCreature").length, 0, "no getCreature round-trips");
      assert.ok(gw.calls.some((c) => c.op === "getJson"), "read the program index over the gateway");
    });
  });

  await check("an agent attached with a top-level kind (thin/no descriptor) is NOT a callable tool", async () => {
    // The team-recommend flow attaches teammates with only a thin descriptor
    // ({name, category, avatar} — no kind) or none, recording the classification
    // as a top-level metadata.kind. Discovery must read that kind so the teammate
    // stays an @mention participant instead of leaking into the callable tools.
    const programIndex = {
      "px-thin": {
        programId: "px-thin", creatureId: "cx-thin", entityId: "agent",
        metadata: { kind: "agent", name: "Planner", descriptor: { name: "Planner", category: "planner", avatar: "av-1" } },
      },
      "px-bare": {
        programId: "px-bare", creatureId: "cx-bare", entityId: "agent",
        metadata: { kind: "agent", name: "Writer" }, // no descriptor at all
      },
      "px-sandbox": {
        programId: "px-sandbox", creatureId: "cx-sandbox", entityId: "sandbox",
        metadata: { name: "sandbox", descriptor: SANDBOX_META.public.decillion },
      },
    };
    await withBridge(nodeBehaviour({ members: [], metaById: {}, programIndex }), async (bridge) => {
      const entries = await discoverSpaceCatalog(bridge, { spaceId: "space-1" }, { timeoutMs: 3000 });
      const kindByName = Object.fromEntries(entries.map((e) => [e.name, e.kind]));
      assert.equal(kindByName.Planner, "agent", "thin-descriptor agent classified from top-level kind");
      assert.equal(kindByName.Writer, "agent", "descriptor-less agent classified from top-level kind");
      const { tools, byName } = buildToolDefinitions(entries);
      assert.deepEqual(tools.map((t) => t.name), ["sandbox"], "only the sandbox is callable");
      assert.ok(![...byName.values()].some((v) => v.kind === "agent"), "neither teammate leaks in as a callable tool");
    });
  });

  await check("discoverSpaceCatalog excludes the calling agent's own proxy (no self-invocation)", async () => {
    // The caller's own proxy shows up in the program index like any other program;
    // handing it back would make the model call itself and hang. It must be dropped
    // whether identified by proxy program id, resource id, or creature id.
    const programIndex = {
      "px-self": {
        programId: "px-self", creatureId: "cx-self", entityId: "agent", resourceId: "res-me",
        metadata: { descriptor: { kind: "agent", name: "Gpt_5_4_Mini", usecases: ["chat"] } },
      },
      "px-sandbox": {
        programId: "px-sandbox", creatureId: "cx-sandbox", entityId: "sandbox",
        metadata: { name: "sandbox", descriptor: SANDBOX_META.public.decillion },
      },
    };
    await withBridge(nodeBehaviour({ members: [], metaById: {}, programIndex }), async (bridge) => {
      // Identify self by the proxy program the signal was sent to and the resource id.
      const task = { spaceId: "space-1", proxyProgramId: "px-self", self: { id: "res-me" } };
      const entries = await discoverSpaceCatalog(bridge, task, { timeoutMs: 3000 });
      const names = entries.map((e) => e.name).sort();
      assert.deepEqual(names, ["sandbox"], "only the sandbox — the agent's own proxy is excluded");
    });
  });

  await check("discoverSpaceCatalog is empty (never throws) with no space / no members", async () => {
    await withBridge(nodeBehaviour({ members: [], metaById: {} }), async (bridge) => {
      assert.deepEqual(await discoverSpaceCatalog(bridge, { sessionId: "space:other:x" }, { timeoutMs: 2000 }), []);
      assert.deepEqual(await discoverSpaceCatalog(bridge, {}, { timeoutMs: 2000 }), []); // no space id at all
    });
    assert.deepEqual(await discoverSpaceCatalog(null, { spaceId: "space-1" }), []); // no bridge
  });

  await check("discovered catalog merges with config.tools, but discovered agents are not callable tools", async () => {
    const members = [{ creatureId: "cx-researcher", programId: "px-researcher" }];
    const metaById = { "cx-researcher": RESEARCHER_META };
    await withBridge(nodeBehaviour({ members, metaById }), async (bridge) => {
      const configTools = [{ name: "sandbox", program_id: "px-sandbox", kind: "tool", defaults: { space_id: "space-1" } }];
      const discovered = await discoverSpaceCatalog(bridge, { spaceId: "space-1" }, { timeoutMs: 3000 });
      const merged = mergeCatalogs(configTools, discovered);
      // Discovery still surfaces the researcher agent in the merged catalog (for
      // awareness), but buildToolDefinitions drops it — only the sandbox is callable.
      assert.ok(merged.some((e) => e.kind === "agent"), "the merged catalog still knows about the agent");
      const { tools, byName } = buildToolDefinitions(merged);
      assert.equal(tools.length, 1, "only the sandbox is a callable tool — the agent is dropped");
      const caps = tools.map((t) => ({ name: t.name, description: t.description, kind: byName.get(t.name)?.kind || "tool" }));
      const preamble = capabilitiesPreamble(caps);
      assert.ok(!/delegate to/i.test(preamble), "no synchronous sub-agent delegation is offered");
      assert.ok(!caps.some((c) => c.kind === "agent"), "no agent is offered as a callable capability");
    });
  });

  await check("signalEndpointFromTask reads the spaces/signal address, null when absent", () => {
    assert.equal(signalEndpointFromTask({}), null);
    assert.equal(signalEndpointFromTask({ signalEndpoint: {} }), null); // no programId
    const ep = signalEndpointFromTask({ signalEndpoint: { programId: "p-sig", entityId: "main", creatureId: "c-sig" } });
    assert.deepEqual(ep, { programId: "p-sig", entityId: "main", creatureId: "c-sig" });
    // snake_case + default entity
    const ep2 = signalEndpointFromTask({ signal_endpoint: { program_id: "p2" } });
    assert.equal(ep2.programId, "p2");
    assert.equal(ep2.entityId, "main");
  });

  await check("persistSpaceMessage signals spaces/signal with persist:true and the message data", async () => {
    const calls = [];
    const bridge = {
      machineId: "self-1",
      signalUser: async (key, target, packet) => {
        calls.push({ key, target, packet });
        return { ok: true };
      },
    };
    const data = { text: "done", from: "agent", msgId: "cid-1", threadId: "main" };
    const ok = await persistSpaceMessage(bridge, {
      endpoint: { programId: "p-sig", entityId: "main" },
      spaceId: "space-1",
      selfId: "self-1",
      data,
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "creatures/signal");
    assert.equal(calls[0].target, "p-sig");
    // The outer StoresSend carries the store + a JSON `data` envelope whose inner
    // payload is the persist:true spaces/signal call with our message data.
    assert.equal(calls[0].packet.store.id, "space-1");
    const env = JSON.parse(calls[0].packet.data);
    assert.equal(env.programId, "p-sig");
    const inner = JSON.parse(env.payload);
    assert.equal(inner.action, "signal");
    assert.equal(inner.payload.persist, true);
    assert.equal(inner.payload.storeId, "space-1");
    assert.deepEqual(inner.payload.data, data);
    // Missing endpoint / space / bridge is a no-op, never a throw.
    assert.equal(await persistSpaceMessage(null, { endpoint: {}, spaceId: "s", data }), false);
    assert.equal(await persistSpaceMessage(bridge, { endpoint: null, spaceId: "s", data }), false);
  });

  console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
