#!/usr/bin/env node
/**
 * Checks for the per-agent task board (`caspar/agentQueue.mjs`) and the
 * `send_message` micro-tool (`caspar/sendMessage.mjs`).
 *
 * Driven against a fake bridge that keeps a real (tag-filterable) store log, so
 * the board is exercised exactly the way it works in production: events are
 * written as `kind=task` signals and read back by folding them. Asserts:
 *   • a free agent runs its task immediately; a busy one queues the next;
 *   • two instances of one agent never run at once, while a DIFFERENT agent in
 *     the same project is unaffected;
 *   • finishing a task archives it and starts the next — relayed through the
 *     agent's proxy, marked claimed so it is not queued a second time;
 *   • with several waiting, the agent's model picks from the TITLES, and any
 *     failure to ask falls back to oldest-first;
 *   • a cancelled task is never picked, and an empty board dispatches nothing;
 *   • `send_message` posts an interim chat turn and hands the work to whoever it
 *     @mentions.
 *
 * Run: node caspar/tests/agent-queue-checks.mjs
 */

import assert from "node:assert/strict";

import {
  AgentTaskBoard,
  TASK_EVENT,
  deriveTitle,
  foldTaskEvents,
  openTasks,
  queueIdentity,
  storablePayload,
} from "../agentQueue.mjs";
import { buildChoicePrompt, extractText, parseChoiceIndex } from "../llmChoice.mjs";
import { sendAgentMessage } from "../sendMessage.mjs";

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

const SPACE = "space-1";

/**
 * A node-shaped bridge with a working store log: `signal` appends a tagged row,
 * `readSignals` answers the same `tagsAll`/`tagsAny` filter the node applies, and
 * rows come back newest-first exactly as the real host call returns them.
 */
function makeBridge() {
  const rows = [];
  let clock = 1000;
  const signalled = [];
  const bridge = {
    programId: "meter-prog",
    machineId: "meter-machine",
    rows,
    signalled,
    async call(op, input) {
      if (op === "signal") {
        clock += 1;
        rows.push({
          id: `${rows.length + 1}@global`,
          userId: "meter-prog",
          time: clock,
          tags: Array.isArray(input?.tags) ? input.tags.map(String) : [],
          data: String(input?.data || "{}"),
        });
        return { ok: true, persisted: true, signalId: `${rows.length}@global` };
      }
      if (op === "readSignals") {
        const all = Array.isArray(input?.tagsAll) ? input.tagsAll : [];
        const any = Array.isArray(input?.tagsAny) ? input.tagsAny : [];
        const matched = rows.filter(
          (r) => all.every((t) => r.tags.includes(t)) && (!any.length || any.some((t) => r.tags.includes(t))),
        );
        return { ok: true, storeId: input?.storeId, signals: matched.slice().reverse() };
      }
      if (op === "getLink") return "pool-1";
      if (op === "getJson") {
        const key = String(input?.key || "");
        if (/^Json::FinancePool::/.test(key)) {
          return { ok: true, data: { status: "open", payerUserId: "user-1", poolId: "pool-1" } };
        }
        if (/^Json::StoreProgramIndex::/.test(key)) {
          return {
            ok: true,
            data: {
              "agent-a": { programId: "agent-a", creatureId: "cr-a", entityId: "agent", metadata: { kind: "agent", name: "Alpha", handle: "alpha" } },
              "agent-b": { programId: "agent-b", creatureId: "cr-b", entityId: "agent", metadata: { kind: "agent", name: "Beta", handle: "beta" } },
            },
          };
        }
        // Any delegated quote the hand-off mints reads back as committed.
        if (/^Json::BillingQuote::/.test(key)) {
          const quoteId = key.split("::").pop();
          const pending = bridge.pendingQuote;
          return pending && pending.quoteId === quoteId ? { ok: true, data: pending } : { ok: true };
        }
        return { ok: true };
      }
      return { ok: true };
    },
    onSignal() {
      return () => {};
    },
    async signalUser(key, target, packet) {
      signalled.push({ key, target, packet });
      return { ok: true };
    },
  };
  /** The task rows on the log, newest last, as parsed board events. */
  bridge.taskEvents = () =>
    rows.filter((r) => r.tags.includes("kind=task")).map((r) => ({ tags: r.tags, ...JSON.parse(r.data) }));
  bridge.chatTurns = () =>
    rows.filter((r) => r.tags.includes("kind=answer")).map((r) => ({ tags: r.tags, ...JSON.parse(r.data) }));
  return bridge;
}

function delivery(agentProgramId, prompt, extra = {}) {
  return {
    correlationId: `run-${Math.random().toString(16).slice(2, 8)}`,
    replyTo: "proxy-1",
    streamTo: "user-1",
    task: {
      spaceId: SPACE,
      threadId: "main",
      streamTo: "user-1",
      groupChat: true,
      proxyProgramId: agentProgramId,
      agentProgramId,
      self: { id: agentProgramId, name: agentProgramId === "agent-a" ? "Alpha" : "Beta", handle: agentProgramId === "agent-a" ? "alpha" : "beta", programId: agentProgramId },
      prompt,
      objective: prompt,
      billingEndpoint: { programId: "billing-prog", creatureId: "billing-cr", entityId: "main" },
      orchestration: { depth: 0, maxHops: 32, payerUserId: "user-1", poolId: "pool-1" },
      ...extra,
    },
  };
}

// ── pure pieces ─────────────────────────────────────────────────────────────

await check("a title is the prompt's first sentence, without the addressing", () => {
  assert.equal(deriveTitle("@alpha please draft the launch email. Then send it."), "please draft the launch email.");
  assert.equal(deriveTitle(""), "Untitled task");
  assert.ok(deriveTitle("x".repeat(400)).length <= 96);
});

await check("a stored payload drops the proxy's injections and the client's quote", () => {
  const payload = storablePayload({
    prompt: "do the thing",
    skill: "SECRET PERSONA",
    config: { llm: { api_key: "sk-live-do-not-store" } },
    billingAuthorization: { quoteId: "q1" },
    correlationId: "run-1",
    spaceId: SPACE,
  });
  assert.equal(payload.skill, undefined);
  assert.equal(payload.config, undefined);
  assert.equal(payload.billingAuthorization, undefined);
  assert.equal(payload.correlationId, undefined);
  assert.equal(payload.prompt, "do the thing");
});

await check("the board is a fold of its events, newest status winning", () => {
  const board = foldTaskEvents([
    { time: 3, data: { taskId: "t1", event: TASK_EVENT.DONE } },
    { time: 2, data: { taskId: "t2", event: TASK_EVENT.QUEUED, title: "Second" } },
    { time: 1, data: { taskId: "t1", event: TASK_EVENT.QUEUED, title: "First" } },
  ]);
  assert.equal(board.get("t1").status, TASK_EVENT.DONE);
  assert.equal(board.get("t1").title, "First");
  assert.deepEqual(openTasks(board).map((t) => t.taskId), ["t2"]);
});

await check("only agent work in a project gets a board row", () => {
  assert.equal(queueIdentity({ kind: "direct_tool", spaceId: SPACE, agentProgramId: "agent-a" }), null);
  assert.equal(queueIdentity({ agentProgramId: "agent-a" }), null, "a spaceless run has no board");
  assert.equal(queueIdentity({ spaceId: SPACE }), null, "a delivery that names no agent has no board");
  assert.equal(queueIdentity({ spaceId: SPACE, proxyProgramId: "agent-a" }).agentProgramId, "agent-a");
});

await check("the choice prompt lists the titles and only the titles are asked about", () => {
  const prompt = buildChoicePrompt("Alpha", [
    { title: "Fix the failing build", requestedByName: "Beta" },
    { title: "Draft the newsletter" },
  ]);
  assert.match(prompt, /1\. Fix the failing build \[from Beta\]/);
  assert.match(prompt, /2\. Draft the newsletter/);
  assert.equal(parseChoiceIndex("2", 2), 1);
  assert.equal(parseChoiceIndex("I would pick 1 first", 2), 0);
  assert.equal(parseChoiceIndex("7", 2), -1, "out of range is no choice at all");
  assert.equal(parseChoiceIndex("nothing numeric", 2), -1);
  assert.equal(extractText({ choices: [{ message: { content: " 2 " } }] }).trim(), "2");
  assert.equal(extractText({ content: [{ text: "1" }] }), "1");
  assert.equal(extractText({ output_text: "3" }), "3");
});

// ── the board in motion ─────────────────────────────────────────────────────

await check("a free agent runs immediately; the board records queued → started", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard();
  const d = delivery("agent-a", "Write the launch post");
  assert.equal(await board.admit(bridge, d), "run");
  assert.ok(board.isBusy(SPACE, "agent-a"));
  const events = bridge.taskEvents();
  assert.deepEqual(events.map((e) => e.event), [TASK_EVENT.QUEUED, TASK_EVENT.STARTED]);
  assert.equal(events[0].title, "Write the launch post");
  assert.ok(events[0].tags.includes("agent=agent-a"));
  assert.ok(events[0].tags.some((t) => t.startsWith("task=")));
});

await check("a busy agent queues the next task instead of running it twice", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard();
  await board.admit(bridge, delivery("agent-a", "First job"));
  const second = delivery("agent-a", "Second job");
  const admission = await board.admit(bridge, second);
  assert.notEqual(admission, "run", "the same agent must not start a second run");
  assert.equal(admission.queued.title, "Second job");
  const open = openTasks(await readBoard(bridge, "agent-a"));
  assert.deepEqual(open.map((t) => t.title), ["Second job"]);
});

await check("a different agent in the same project is unaffected", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard();
  await board.admit(bridge, delivery("agent-a", "Alpha's job"));
  assert.equal(await board.admit(bridge, delivery("agent-b", "Beta's job")), "run");
  assert.ok(board.isBusy(SPACE, "agent-b"));
});

await check("finishing archives the task and relays the next one, claimed", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "First job");
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Second job"));

  await board.finish(bridge, first, { success: true, answer: "done" });

  const byTask = await readBoard(bridge, "agent-a");
  const statuses = [...byTask.values()].map((t) => `${t.title}:${t.status}`).sort();
  assert.deepEqual(statuses, ["First job:done", "Second job:queued"].sort());
  assert.equal(relayed.length, 1, "the next task is relayed through the agent's proxy");
  assert.equal(relayed[0].agentProgramId, "agent-a");
  assert.equal(relayed[0].task.queueClaimed, true);
  assert.equal(relayed[0].task.serverOrchestrate, true);
  assert.equal(relayed[0].task.billingAuthorization, undefined, "a deferred run mints its own delegated quote");
  assert.equal(relayed[0].task.prompt, "Second job");
  assert.ok(board.isBusy(SPACE, "agent-a"), "the slot stays held for the claimed task");
});

await check("the relayed task runs straight away and is not queued again", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "First job");
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Second job"));
  await board.finish(bridge, first, { success: true });

  const claimedTask = relayed[0].task;
  const second = { correlationId: "run-relayed", replyTo: "proxy-1", task: claimedTask };
  assert.equal(await board.admit(bridge, second), "run");
  const board2 = await readBoard(bridge, "agent-a");
  assert.equal(board2.get(claimedTask.queueTaskId).status, TASK_EVENT.STARTED);
  const queuedRows = bridge.taskEvents().filter((e) => e.event === TASK_EVENT.QUEUED);
  assert.equal(queuedRows.length, 2, "the relayed task is not queued a second time");
});

await check("the cycle continues until the board is empty", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Job two"));
  await board.admit(bridge, delivery("agent-a", "Job three"));

  let current = first;
  for (let i = 0; i < 3 && current; i += 1) {
    await board.finish(bridge, current, { success: true });
    const next = relayed[relayed.length - 1];
    if (!next || relayed.length <= i) break;
    current = { correlationId: `run-${i}`, replyTo: "proxy-1", task: next.task };
    await board.admit(bridge, current);
  }
  await board.finish(bridge, current, { success: true });
  const done = [...(await readBoard(bridge, "agent-a")).values()];
  assert.equal(done.length, 3);
  assert.ok(done.every((t) => t.status === TASK_EVENT.DONE), done.map((t) => `${t.title}:${t.status}`).join(", "));
  assert.equal(board.isBusy(SPACE, "agent-a"), false, "the agent is idle once its board is empty");
});

await check("with several waiting, the agent's model picks from the titles", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "Job one", {
    config: { llm: { provider: "openai", api_key: "sk-test", models: ["gpt-test"] } },
  });
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Draft the newsletter"));
  await board.admit(bridge, delivery("agent-a", "Fix the failing build"));

  const asked = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ output_text: "2" }) };
  };
  try {
    await board.finish(bridge, first, { success: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(asked.length, 1, "one small call, between tasks");
  const promptText = JSON.stringify(asked[0]);
  assert.ok(promptText.includes("Draft the newsletter"), "the titles are the context");
  assert.ok(promptText.includes("Fix the failing build"));
  assert.equal(relayed[0].task.prompt, "Fix the failing build", "the model's pick is what runs");
});

await check("a model that cannot be asked falls back to oldest-first", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "Job one", {
    config: { llm: { provider: "openai", api_key: "sk-test", models: ["gpt-test"] } },
  });
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Older waiting job"));
  await board.admit(bridge, delivery("agent-a", "Newer waiting job"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("provider unreachable");
  };
  try {
    await board.finish(bridge, first, { success: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(relayed[0].task.prompt, "Older waiting job");
});

await check("a cancelled task is never picked up", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args) });
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);
  const queued = (await board.admit(bridge, delivery("agent-a", "Job two"))).queued;

  // What the app writes when a person removes the card from the board.
  await bridge.call("signal", {
    storeId: SPACE,
    data: JSON.stringify({ event: TASK_EVENT.CANCELLED, taskId: queued.taskId }),
    tags: ["kind=task", "thread=main", "agent=agent-a", `task=${queued.taskId}`],
  });

  await board.finish(bridge, first, { success: true });
  assert.equal(relayed.length, 0, "a cancelled task is not work");
  assert.equal(board.isBusy(SPACE, "agent-a"), false);
});

await check("a failed run still archives its task and frees the agent", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard();
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);
  await board.finish(bridge, first, { success: false, error: "the model refused" });
  const record = [...(await readBoard(bridge, "agent-a")).values()][0];
  assert.equal(record.status, TASK_EVENT.FAILED);
  assert.equal(record.error, "the model refused");
  assert.equal(board.isBusy(SPACE, "agent-a"), false);
});

await check("a board that refuses the row still runs the work, and frees nobody's slot", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard();
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);

  // The log refuses the next row (a store that is not recording, a node hiccup).
  const originalCall = bridge.call.bind(bridge);
  bridge.call = async (op, input) => (op === "signal" ? { ok: false, error: "refused" } : originalCall(op, input));
  const second = delivery("agent-a", "Job two");
  assert.equal(await board.admit(bridge, second), "run", "the message is answered rather than dropped");
  bridge.call = originalCall;

  // …but it must not take over, or later free, the slot the first run holds.
  await board.finish(bridge, second, { success: true });
  assert.ok(board.isBusy(SPACE, "agent-a"), "the run that holds the slot still holds it");
  const statuses = [...(await readBoard(bridge, "agent-a")).values()].map((t) => t.status);
  assert.deepEqual(statuses, [TASK_EVENT.STARTED], "only the first run has a card");
});

await check("an expired lease puts the task back, and both relays never both run", async () => {
  const bridge = makeBridge();
  const relayed = [];
  const board = new AgentTaskBoard({ signalProxy: (b, args) => relayed.push(args), claimTimeoutMs: 20 });
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Job two"));
  await board.finish(bridge, first, { success: true });
  assert.equal(relayed.length, 1);

  // The proxy never relays it back in time: the lease expires, the task goes
  // back on the board, and it is handed over again.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(relayed.length >= 2, "the task is handed over again, not lost");
  const events = bridge.taskEvents().map((e) => e.event);
  assert.ok(events.includes(TASK_EVENT.REQUEUED), "the board says it was put back");

  // Now EVERY hop lands at once. Only one may run — the whole point of a board.
  const arrivals = relayed.map((r, i) => ({ correlationId: `run-${i}`, replyTo: "proxy-1", task: r.task }));
  const admissions = [];
  for (const arrival of arrivals) admissions.push(await board.admit(bridge, arrival));
  assert.equal(admissions.filter((a) => a === "run").length, 1, "exactly one instance of the agent runs");
  assert.ok(admissions.some((a) => a && a.dropped), "the duplicate relay is dropped");
});

await check("a task its agent can never be reached for is closed, not retried forever", async () => {
  const bridge = makeBridge();
  const board = new AgentTaskBoard({
    signalProxy: () => {
      throw new Error("proxy unreachable");
    },
    claimTimeoutMs: 20,
  });
  const first = delivery("agent-a", "Job one");
  await board.admit(bridge, first);
  await board.admit(bridge, delivery("agent-a", "Unreachable job"));
  // Every hand-over fails, so the task goes straight back on the board and is
  // tried again — the loop the attempt cap exists to end.
  await board.finish(bridge, first, { success: true });
  const identity = queueIdentity(first.task);
  for (let i = 0; i < 5; i += 1) await board.dispatch(bridge, identity);
  const record = [...(await readBoard(bridge, "agent-a")).values()].find((t) => t.title === "Unreachable job");
  assert.equal(record.status, TASK_EVENT.FAILED);
  assert.match(record.error, /could not be started after/);
  assert.equal(board.isBusy(SPACE, "agent-a"), false);
});

// ── send_message ────────────────────────────────────────────────────────────

await check("send_message posts an interim chat turn from the running agent", async () => {
  const bridge = makeBridge();
  const task = delivery("agent-a", "Job one").task;
  task.correlationId = "run-live";
  const res = await sendAgentMessage(bridge, task, { text: "Halfway there — the data is loaded." });
  assert.equal(res.ok, true);
  const turns = bridge.chatTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "Halfway there — the data is loaded.");
  assert.equal(turns[0].interim, true, "an interim message is not the run's final answer");
  assert.equal(turns[0].agentName, "Alpha");
  assert.ok(turns[0].tags.includes("run=run-live"), "it belongs to the run that sent it");
});

await check("send_message hands the work to whoever it @mentions", async () => {
  const bridge = makeBridge();
  const task = delivery("agent-a", "Job one").task;
  task.correlationId = "run-live";
  const originalCall = bridge.call.bind(bridge);
  /** The billing creature commits every quote the backbone asks it for. */
  const lastQuoteRequest = () => {
    for (const sent of [...bridge.signalled].reverse()) {
      try {
        const inner = JSON.parse(JSON.parse(sent.packet.data).payload);
        if (inner.action === "quote") return inner.payload;
      } catch {
        /* not a creature-to-creature call */
      }
    }
    return null;
  };
  bridge.call = async (op, input) => {
    if (op === "getJson" && /^Json::BillingQuote::/.test(String(input?.key || ""))) {
      const quoteId = String(input.key).split("::").pop();
      const asked = lastQuoteRequest();
      if (!asked) return { ok: true };
      return {
        ok: true,
        data: {
          quoteId,
          payerUserId: asked.payerUserId,
          requestId: asked.requestId,
          resourceId: asked.resourceId,
          projectId: asked.projectId,
        },
      };
    }
    return originalCall(op, input);
  };
  const res = await sendAgentMessage(bridge, task, { text: "Starting the draft.", mention: ["beta"] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.handedTo, ["beta"]);
  const turns = bridge.chatTurns();
  assert.match(turns[0].text, /@beta$/, "an explicit mention is appended to the message");
  assert.deepEqual(turns[0].mentions.map((m) => m.programId), ["agent-b"]);
  assert.ok(turns[0].tags.includes("mention=agent-b"));
  const launch = bridge.signalled.filter((s) => s.target === "agent-b");
  assert.equal(launch.length, 1, "the mentioned teammate is launched, not waited on");
});

await check("send_message says so when a handle names nobody", async () => {
  const bridge = makeBridge();
  const task = delivery("agent-a", "Job one").task;
  const res = await sendAgentMessage(bridge, task, { text: "@nobody can you take this?" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.unknownHandles, ["nobody"]);
  assert.match(res.note, /No agent in this project answers to @nobody/);
});

await check("send_message refuses an empty message and a spaceless run", async () => {
  const bridge = makeBridge();
  const task = delivery("agent-a", "Job one").task;
  assert.equal((await sendAgentMessage(bridge, task, { text: "   " })).ok, false);
  assert.equal((await sendAgentMessage(bridge, { ...task, spaceId: "" }, { text: "hi" })).ok, false);
});

async function readBoard(bridge, agentProgramId) {
  const { readAgentBoard } = await import("../agentQueue.mjs");
  return readAgentBoard(bridge, { spaceId: SPACE, agentProgramId });
}

console.log("");
if (failures.length) {
  console.log(`${RED}${failures.length} failing${NC}, ${passed} passing`);
  process.exit(1);
}
console.log(`${GREEN}${passed} passing${NC}`);
