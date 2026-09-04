#!/usr/bin/env node
/**
 * Checks for server-side orchestration (caspar/orchestrate.mjs): the backbone
 * driving the @mention fan-out chain with delegated billing, so multi-agent
 * work continues with no client present.
 *
 * Driven against a minimal fake bridge that answers the node host ops the module
 * uses (getLink for the payer's pool, getJson for the pool + program index) and
 * completes the creature-to-creature billing call (signalUser out, reply back on
 * the registered onSignal listener). Asserts:
 *   • an answer's @mentioned teammate is launched via its proxy, with a
 *     delegated quote and advanced orchestration state;
 *   • the hop cap and the visited set stop runaway / duplicate launches;
 *   • a refused delegated quote (budget reached) halts that branch;
 *   • only backbone-minted (autonomousQuote) runs settle against the budget.
 *
 * Run: node caspar/tests/orchestrate-checks.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

// Shrink the delegated-quote poll so the "refused" case (no doc ever written)
// resolves in a few ms instead of the production ~6s. Read at call time.
process.env.DELEGATED_QUOTE_ATTEMPTS = "8";
process.env.DELEGATED_QUOTE_INTERVAL_MS = "3";

import {
  billingEndpointFromTask,
  resetChainBudgets,
  ensureDelegatedAuthorization,
  isSequentialHandoff,
  isServerOrchestrated,
  parseAnswerMentionsOrdered,
  planAndLaunchFollowups,
  resolvePoolId,
  settleAutonomousSpend,
} from "../orchestrate.mjs";
import { resetProgress } from "../acceptance.mjs";

/** The deterministic quote id the billing creature (and the backbone) compute. */
function fakeQuoteId(payer, requestId) {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(String(payer), "utf8"));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(String(requestId), "utf8"));
  h.update(Buffer.from([0]));
  return h.digest("hex");
}

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    // The chain run budget is per-root and lives in the module, so without this
    // every check after the twelfth launch would inherit an exhausted budget.
    resetChainBudgets();
    // The stagnation tracker is per-root module state too: without this, one
    // check's idle hops would halt the next check's chain.
    resetProgress();
    await fn();
    passed += 1;
    console.log(`${GREEN}✓${NC} ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`${RED}✗${NC} ${name}\n  ${String(err?.stack || err).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

const BILLING_PROG = "billing-prog";
const PROGRAM_INDEX = {
  "self-prog": { programId: "self-prog", creatureId: "self-cr", entityId: "agent", metadata: { kind: "agent", name: "Orbit Lead", handle: "lead" } },
  "mate-prog": { programId: "mate-prog", creatureId: "mate-cr", entityId: "agent", metadata: { kind: "agent", name: "Writer", handle: "writer" } },
  "builder-prog": { programId: "builder-prog", creatureId: "builder-cr", entityId: "agent", metadata: { kind: "agent", name: "Builder", handle: "builder" } },
  "growth-prog": { programId: "growth-prog", creatureId: "growth-cr", entityId: "agent", metadata: { kind: "agent", name: "Growth", handle: "growth" } },
  "research-prog": { programId: "research-prog", creatureId: "research-cr", entityId: "agent", metadata: { kind: "agent", name: "Researcher", handle: "researcher" } },
  // Attached the way the app attaches a market agent: the display name and the
  // descriptor, whose `username` IS the @handle chat shows. No top-level handle.
  "atlas-prog": { programId: "atlas-prog", creatureId: "atlas-cr", entityId: "agent", metadata: { kind: "agent", name: "Atlas", descriptor: { kind: "agent", name: "Atlas", username: "operator" } } },
  "tool-prog": { programId: "tool-prog", creatureId: "tool-cr", entityId: "main", metadata: { kind: "tool", name: "sandbox" } },
};

/**
 * A minimal node-shaped bridge for the orchestration flow. Mirrors the real
 * path: a delegated quote is fired at the billing creature (signalUser) and read
 * back as the committed doc (getJson Json::BillingQuote::<id>) — no reliance on a
 * signal reply. A refused quote (quoteOk:false) writes no doc, so the read times
 * out and the teammate is not launched. Teammate launches signal the proxy.
 */

function makeBridge({ pools = { "user-1": { poolId: "pool-1", payerUserId: "user-1" } }, quoteOk = true } = {}) {
  const launched = [];
  const settled = [];
  const notes = []; // stall notes — `kind=step` signals on the space
  const planEvents = []; // `kind=plan` rows — the shared plan the hand-off writes
  const quoteDocs = new Map(); // quoteId -> committed quote doc
  const parseInner = (packet) => {
    try {
      return JSON.parse(JSON.parse(packet.data).payload);
    } catch {
      return {};
    }
  };
  const bridge = {
    programId: "meter-prog",
    machineId: "meter-machine",
    async call(op, input) {
      if (op === "signal") {
        const row = { storeId: input?.storeId, tags: input?.tags || [], data: JSON.parse(input?.data || "{}") };
        // The plan is state about the work, the stall note is a step in the run's
        // trail. They ride the same host call and must not be counted together.
        if (row.tags.includes("kind=plan")) planEvents.push(row);
        else notes.push(row);
        return { ok: true, persisted: true };
      }
      if (op === "readSignals") return { ok: true, signals: [] };
      if (op === "getLink") {
        const m = String(input?.key || "").match(/^FinancePoolByUser::(.+)$/);
        return m ? String(pools[m[1]]?.poolId || "") : "";
      }
      if (op === "getJson") {
        const key = String(input?.key || "");
        let m = key.match(/^Json::FinancePool::(.+)$/);
        if (m) {
          const pool = Object.values(pools).find((p) => p.poolId === m[1]);
          return pool ? { ok: true, data: { status: "open", payerUserId: pool.payerUserId, poolId: pool.poolId } } : { ok: true };
        }
        m = key.match(/^Json::StoreProgramIndex::/);
        if (m) return { ok: true, data: PROGRAM_INDEX };
        m = key.match(/^Json::BillingQuote::(.+)$/);
        if (m) {
          const doc = quoteDocs.get(m[1]);
          return doc ? { ok: true, data: doc } : { ok: true };
        }
        return { ok: true };
      }
      return { ok: true };
    },
    onSignal() {
      return () => {};
    },
    async signalUser(key, target, packet) {
      if (target === BILLING_PROG) {
        const inner = parseInner(packet);
        const p = inner.payload || {};
        if (inner.action === "quote" && quoteOk) {
          const qid = fakeQuoteId(p.payerUserId, p.requestId);
          quoteDocs.set(qid, {
            quoteId: qid,
            payerUserId: p.payerUserId,
            requestId: p.requestId,
            resourceId: p.resourceId,
            projectId: p.projectId,
          });
        } else if (inner.action === "settleAutonomous") {
          settled.push({ payload: p });
        }
        return { ok: true };
      }
      launched.push({ target, packet, task: JSON.parse(JSON.parse(packet.data).payload) });
      return { ok: true };
    },
  };
  return { bridge, launched, settled, notes, planEvents };
}

function seedDelivery(overrides = {}) {
  const task = {
    serverOrchestrate: true,
    spaceId: "space-1",
    threadId: "main",
    proxyProgramId: "self-prog",
    self: { programId: "self-prog", name: "Lead", handle: "lead" },
    billingEndpoint: { programId: BILLING_PROG, creatureId: "billing-cr", entityId: "main" },
    orchestration: { depth: 0, maxHops: 8, visited: ["self-prog"], poolId: "pool-1", payerUserId: "user-1" },
    ...overrides,
  };
  return { task, correlationId: "seed-corr", streamTo: "user-1", replyTo: "" };
}

await check("isServerOrchestrated / billingEndpointFromTask read the task flags", () => {
  assert.equal(isServerOrchestrated({ serverOrchestrate: true }), true);
  assert.equal(isServerOrchestrated({ serverOrchestrate: false }), false);
  assert.equal(isServerOrchestrated({}), false);
  assert.equal(billingEndpointFromTask({ billingEndpoint: { programId: "b" } })?.programId, "b");
  assert.equal(billingEndpointFromTask({}), null);
});

await check("resolvePoolId returns the payer's open pool, else empty", async () => {
  const { bridge } = makeBridge();
  assert.equal(await resolvePoolId(bridge, "user-1"), "pool-1");
  assert.equal(await resolvePoolId(bridge, "nobody"), "");
});

await check("teammate is detected from the program index by name-slug when NO roster reached the backbone", async () => {
  // The real-world failure: task.roster missing/empty, so the handle must be
  // derived from the program-index name ("Writer" → "writer") and still match
  // the @mention the agent wrote.
  const { bridge, launched, notes } = makeBridge();
  const delivery = seedDelivery({ roster: [] });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "On it. **@writer** please draft the copy.", chargedMinor: 10 });
  assert.equal(n, 1, "the index-resolved teammate is launched");
  assert.equal(launched.length, 1);
  assert.equal(launched[0].target, "mate-prog");
  assert.equal(notes.length, 0, "no stall note when a teammate was launched");
});

await check("a stall note is posted in-chat when a mention matches no known agent", async () => {
  const { bridge, launched, notes } = makeBridge();
  const delivery = seedDelivery({ roster: [] });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@nobody-here please help" });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
  assert.equal(notes.length, 1, "the stall is surfaced into the space");
  assert.equal(notes[0].storeId, "space-1");
  assert.ok(notes[0].tags.includes("kind=step"), "a stall is work-trail, not a chat bubble");
  assert.match(notes[0].data.text, /Hand-off didn't continue/);
});

await check("an answer's @mentioned teammate is launched with a delegated quote", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery();
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "Done. @writer please draft it.", chargedMinor: 10 });
  assert.equal(n, 1);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].target, "mate-prog");
  const t = launched[0].task;
  assert.equal(t.proxyProgramId, "mate-prog");
  // The quote id is deterministic (sha256 of payer+requestId) and read back from
  // the committed doc — so it is a 64-hex digest bound to this run, not a stub.
  assert.match(t.billingAuthorization.quoteId, /^[0-9a-f]{64}$/);
  assert.equal(t.billingAuthorization.payerUserId, "user-1");
  assert.equal(t.billingAuthorization.poolId, "pool-1");
  assert.equal(t.autonomousQuote, true);
  assert.equal(t.serverOrchestrate, true);
  assert.equal(t.orchestration.depth, 1);
  assert.ok(t.orchestration.visited.includes("self-prog"));
  assert.ok(t.orchestration.visited.includes("mate-prog"));
  assert.equal(t.orchestration.visited.filter((id) => id === "mate-prog").length, 1);
  assert.equal(t.orchestration.visited.length, 2);
  // Context carried forward for the next hop. The teammate reads and writes the
  // space's signal log through the node's own host calls, so the only address it
  // still needs handed to it is billing.
  assert.equal(t.billingEndpoint.programId, BILLING_PROG);
  assert.equal(t.historyEndpoint, undefined);
  assert.equal(t.signalEndpoint, undefined);
});

await check("no @mention → nothing launched", async () => {
  const { bridge, launched } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, answer: "All finished, no handoff." });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
});

await check("the hop cap halts the chain, and says so in the trail", async () => {
  const { bridge, launched, notes } = makeBridge();
  const delivery = seedDelivery({ orchestration: { depth: 7, maxHops: 8, visited: ["self-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer keep going" });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
  assert.match(notes[0].data.text, /8-hop limit/);
});

await check("a teammate gets a second turn, but not a third — the pair stops trading", async () => {
  // Two turns is the shape of real teamwork: a lead hands work to a specialist,
  // the specialist hands the artifact back. The THIRD hand-off to the same agent
  // on one branch is where a pair reliably starts restating each other, so the
  // visit cap binds there — and says so in the trail, rather than the chain
  // quietly going round again on the user's money.
  const second = makeBridge();
  const stillFree = seedDelivery({ orchestration: { depth: 1, maxHops: 8, visited: ["self-prog", "mate-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  assert.equal(await planAndLaunchFollowups(second.bridge, stillFree, { success: true, answer: "@writer one more pass please" }), 1);
  assert.equal(second.launched[0].target, "mate-prog");

  const third = makeBridge();
  const capped = seedDelivery({ orchestration: { depth: 1, maxHops: 8, visited: ["self-prog", "mate-prog", "mate-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  assert.equal(await planAndLaunchFollowups(third.bridge, capped, { success: true, answer: "@writer once more" }), 0);
  assert.equal(third.launched.length, 0);
  assert.match(third.notes[0].data.text, /@writer already took 2 turns in this chain/);
});

await check("one user message cannot grow into an unbounded tree of runs", async () => {
  // Depth bounds ONE branch; `visited` is per branch, so an answer naming three
  // teammates makes three branches, each free to fan out again. Without a global
  // ceiling a single prompt became a swarm bounded only by the wallet. Every
  // launch in the chain draws on one budget, keyed by the root run.
  process.env.GROK_ORCH_MAX_CHAIN_RUNS = "2";
  try {
    resetChainBudgets();
    const { bridge, launched, notes } = makeBridge();
    const n = await planAndLaunchFollowups(bridge, seedDelivery(), {
      success: true,
      answer: "@builder ship the site. @growth draft the posts. @researcher cite sources.",
    });
    assert.equal(n, 2, "the third teammate is over the chain's run budget");
    assert.equal(launched.length, 2);
    assert.match(notes.at(-1).data.text, /already run 2 agent turns/);
    // The budget is per ROOT, and every branch carries the same root forward.
    assert.equal(launched[0].task.orchestration.rootRunId, "seed-corr");
  } finally {
    delete process.env.GROK_ORCH_MAX_CHAIN_RUNS;
    resetChainBudgets();
  }
});

await check("an acknowledgement is not a hand-off", async () => {
  // "Thanks @lead, draft attached" used to hand @lead a fresh billable task, who
  // would acknowledge it back — two agents being polite at each other until the
  // wallet stopped them. A courtesy mention launches nobody, and it is not
  // reported as a stalled chain either: it is a finished one.
  const { bridge, launched, notes } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "Landing page is live at the preview URL. Thanks @writer for the copy.",
  });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
  assert.equal(notes.length, 0, "a polite ending is not a stall");
});

await check("code, links and package names never trigger an agent", async () => {
  // Every `@token` used to be a trigger, so an answer containing a CSS block or a
  // dependency list fanned the chain out to whatever fuzzily matched.
  const { bridge, launched } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "Installed @types/node and wrote:\n```css\n@media (min-width:0){}\n```\nMail bot@example.com. @builder please deploy it.",
  });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "builder-prog");
});

await check("a hand-off carries a plan-backed contract, not just the sender's prose", async () => {
  // The receiving agent used to be handed the whole reply as its entire task
  // specification — including the paragraphs meant for somebody else. Now the
  // ask aimed at it becomes a task in the shared plan that it owns, and the
  // sender's full reply travels separately as context.
  const { bridge, launched, planEvents } = makeBridge();
  await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "Research is done. @builder ship the landing page. Use copy.md. @growth draft the posts.",
  });
  const builder = launched.find((row) => row.target === "builder-prog").task;
  assert.ok(builder.assignment?.planTaskId, "the teammate is given a plan task it owns");
  assert.match(builder.objective, /ship the landing page/);
  assert.ok(!/draft the posts/.test(builder.objective), "the other teammate's ask is not this one's job");
  assert.match(builder.handOffContextText, /draft the posts/, "the full reply still travels as context");
  const rows = planEvents.filter((row) => row.data.event === "task");
  assert.equal(rows.length, 2, "one plan task per teammate");
  assert.equal(rows[0].data.owner, "builder-prog");
});

await check("GROK_ORCH_VISIT_CAP still enforces a tighter cap, and the note says so", async () => {
  process.env.GROK_ORCH_VISIT_CAP = "1";
  try {
    const { bridge, launched, notes } = makeBridge();
    const delivery = seedDelivery({ orchestration: { depth: 1, maxHops: 8, visited: ["self-prog", "mate-prog"], poolId: "pool-1", payerUserId: "user-1" } });
    const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer once more" });
    assert.equal(n, 0);
    assert.equal(launched.length, 0);
    assert.match(notes[0].data.text, /@writer already took 1 turn in this chain/);
  } finally {
    delete process.env.GROK_ORCH_VISIT_CAP;
  }
});

await check("a mention resolves past a blocked first match to the agent that can take it", async () => {
  // "@lead" names this very agent AND a second "Orbit Lead" on the roster. The
  // first row is the answer's own author, so the mention must fall through to
  // the other one rather than being dropped.
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({
    roster: [{ programId: "orbit-prog", name: "Orbit Lead", handle: "orbit-lead", kind: "agent", entityId: "agent" }],
  });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@lead please take it from here." });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "orbit-prog");
});

await check("an @handle known only from the index descriptor still resolves", async () => {
  // A run with no roster (a routine firing, a teammate launched after the client
  // dropped) resolves handles from the program index. The index carries the
  // listing's `username` on the descriptor — "Atlas" answers to @operator.
  const { bridge, launched, notes } = makeBridge();
  const delivery = seedDelivery({ roster: [] });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@operator please roll it out." });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "atlas-prog");
  assert.equal(notes.length, 0);
});

await check("a mention that only names the answer's own author says so", async () => {
  const { bridge, launched, notes } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, answer: "@lead is on it." });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
  assert.match(notes[0].data.text, /@lead names the agent that wrote this answer/);
});

await check("an unknown handle is named as unknown, with the known agents listed", async () => {
  const { bridge, notes } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, answer: "@nobody-here please help" });
  assert.equal(n, 0);
  assert.match(notes[0].data.text, /no agent in this project answers to @nobody-here/);
  assert.match(notes[0].data.text, /known agents: .*@writer/);
});

await check("a teammate may be handed a second turn after finishing the first", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({ orchestration: { depth: 1, maxHops: 8, visited: ["self-prog", "mate-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer please review the files" });
  assert.equal(n, 1);
  assert.equal(launched.length, 1);
});

await check("independent mentions still launch in parallel", async () => {
  const { bridge, launched } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "@builder ship the site. @growth draft the posts. @researcher cite sources.",
  });
  assert.equal(n, 3);
  const byTarget = Object.fromEntries(launched.map((row) => [row.target, row.task]));
  assert.deepEqual(byTarget["builder-prog"].orchestration.visited, ["self-prog", "builder-prog"]);
  assert.deepEqual(byTarget["growth-prog"].orchestration.visited, ["self-prog", "growth-prog"]);
  assert.ok(!byTarget["builder-prog"].orchestration.visited.includes("growth-prog"));
});

await check("sequential cues launch only the first teammate", async () => {
  assert.equal(isSequentialHandoff("@builder then @growth write posts"), true);
  assert.equal(isSequentialHandoff("@builder ship it. @growth draft posts."), false);
  assert.deepEqual(parseAnswerMentionsOrdered("ask @builder then @growth"), ["builder", "growth"]);
  const { bridge, launched } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "@builder ship the site, then @growth draft the posts.",
  });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "builder-prog");
});

await check("a sequenced teammate is recorded as waiting, not silently dropped", async () => {
  const { bridge, notes } = makeBridge();
  await planAndLaunchFollowups(bridge, seedDelivery(), {
    success: true,
    answer: "@builder ship the site, then @growth draft the posts.",
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].data.kind, "orch-deferred");
  assert.match(notes[0].data.text, /@growth waits on @builder/);
});

await check("a specialist can hand off to a sibling after the lead's parallel wave", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({
    proxyProgramId: "research-prog",
    self: { programId: "research-prog", name: "Researcher", handle: "researcher" },
    orchestration: {
      depth: 1,
      maxHops: 8,
      visited: ["self-prog", "research-prog"],
      poolId: "pool-1",
      payerUserId: "user-1",
    },
  });
  const n = await planAndLaunchFollowups(bridge, delivery, {
    success: true,
    answer: "@lead use the unknowns checklist. @builder align campaign params. @growth keep UTM lowercase.",
  });
  assert.equal(n, 3, "lead + builder + growth should run a follow-up turn");
  const targets = launched.map((row) => row.target).sort();
  assert.deepEqual(targets, ["builder-prog", "growth-prog", "self-prog"]);
});

await check("legacy packed visited still allows a sibling another turn", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({
    proxyProgramId: "research-prog",
    self: { programId: "research-prog", name: "Researcher", handle: "researcher" },
    orchestration: {
      depth: 1,
      maxHops: 8,
      visited: ["self-prog", "builder-prog", "research-prog", "growth-prog"],
      poolId: "pool-1",
      payerUserId: "user-1",
    },
  });
  const n = await planAndLaunchFollowups(bridge, delivery, {
    success: true,
    answer: "@builder Please align the site with research.md.",
  });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "builder-prog");
});

await check("@lead still resolves when a second agent is named Orbit Lead", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({
    proxyProgramId: "research-prog",
    self: { programId: "research-prog", name: "Researcher", handle: "researcher" },
    orchestration: { depth: 0, maxHops: 8, visited: ["research-prog"], poolId: "pool-1", payerUserId: "user-1" },
    roster: [{ programId: "orbit-prog", name: "Orbit Lead", handle: "orbit-lead", kind: "agent", entityId: "agent" }],
  });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "Ready. @lead please review." });
  assert.equal(n, 1);
  assert.equal(launched[0].target, "self-prog");
});

await check("a refused delegated quote (budget reached) stops that branch", async () => {
  const { bridge, launched } = makeBridge({ quoteOk: false });
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, answer: "@writer draft it" });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
});

await check("a failed / paused run does not fan out", async () => {
  const { bridge, launched } = makeBridge();
  assert.equal(await planAndLaunchFollowups(bridge, seedDelivery(), { success: false, answer: "@writer" }), 0);
  assert.equal(await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, pausedForFunds: true, answer: "@writer" }), 0);
  assert.equal(launched.length, 0);
});

await check("a non-orchestrated delivery never fans out", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({ serverOrchestrate: false });
  assert.equal(await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer draft it" }), 0);
  assert.equal(launched.length, 0);
});

await check("settleAutonomousSpend records only backbone-minted runs", async () => {
  const { bridge, settled } = makeBridge();
  // A backbone-minted (delegated) run settles against the budget.
  await settleAutonomousSpend(
    bridge,
    { task: { autonomousQuote: true, spaceId: "space-1", billingEndpoint: { programId: BILLING_PROG, entityId: "main" }, billingAuthorization: { quoteId: "q-1" } } },
    { chargedMinor: 4321 },
  );
  assert.equal(settled.length, 1);
  // A user-initiated seed (no autonomousQuote) does not.
  await settleAutonomousSpend(
    bridge,
    { task: { spaceId: "space-1", billingEndpoint: { programId: BILLING_PROG, entityId: "main" }, billingAuthorization: { quoteId: "q-9" } } },
    { chargedMinor: 999 },
  );
  assert.equal(settled.length, 1);
});

await check("ensureDelegatedAuthorization mints a quote for a routine seed with no client auth", async () => {
  const { bridge } = makeBridge();
  const delivery = {
    task: {
      serverOrchestrate: true,
      spaceId: "space-1",
      proxyProgramId: "self-prog",
      streamTo: "user-1",
      billingEndpoint: { programId: BILLING_PROG, creatureId: "billing-cr", entityId: "main" },
      orchestration: { payerUserId: "user-1" },
    },
    correlationId: "routine-corr",
    streamTo: "user-1",
  };
  const ready = await ensureDelegatedAuthorization(bridge, delivery);
  assert.equal(ready, true);
  assert.match(delivery.task.billingAuthorization.quoteId, /^[0-9a-f]{64}$/);
  assert.equal(delivery.task.autonomousQuote, true);
  assert.equal(delivery.task.orchestration.poolId, "pool-1");
});

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
