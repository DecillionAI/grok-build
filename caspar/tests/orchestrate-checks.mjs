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

import {
  billingEndpointFromTask,
  ensureDelegatedAuthorization,
  isServerOrchestrated,
  planAndLaunchFollowups,
  resolvePoolId,
  settleAutonomousSpend,
} from "../orchestrate.mjs";

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

const BILLING_PROG = "billing-prog";
const PROGRAM_INDEX = {
  "self-prog": { programId: "self-prog", creatureId: "self-cr", entityId: "agent", metadata: { kind: "agent", name: "Lead", handle: "lead" } },
  "mate-prog": { programId: "mate-prog", creatureId: "mate-cr", entityId: "agent", metadata: { kind: "agent", name: "Writer", handle: "writer" } },
  "tool-prog": { programId: "tool-prog", creatureId: "tool-cr", entityId: "main", metadata: { kind: "tool", name: "sandbox" } },
};

/** A minimal node-shaped bridge for the orchestration flow. */
function makeBridge({ pools = { "user-1": { poolId: "pool-1", payerUserId: "user-1" } }, quoteOk = true, quoteId = "q-1" } = {}) {
  const listeners = new Set();
  const launched = [];
  const settled = [];
  const bridge = {
    programId: "meter-prog",
    machineId: "meter-machine",
    async call(op, input) {
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
        return { ok: true };
      }
      return { ok: true };
    },
    onSignal(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async signalUser(key, target, packet) {
      if (target === BILLING_PROG) {
        let action = "";
        try {
          action = JSON.parse(JSON.parse(packet.data).payload).action;
        } catch {
          /* ignore */
        }
        const cid = packet.correlationId;
        if (action === "settleAutonomous") settled.push({ cid, packet });
        setImmediate(() => {
          const reply =
            action === "quote"
              ? quoteOk
                ? { correlationId: cid, namespace: "billing", ok: true, quote: { quoteId } }
                : { correlationId: cid, namespace: "billing", ok: false, error: "autonomous budget reached for this project" }
              : { correlationId: cid, namespace: "billing", ok: true };
          for (const fn of [...listeners]) fn("creatures/signal", { data: JSON.stringify(reply) });
        });
        return { ok: true };
      }
      launched.push({ target, packet, task: JSON.parse(JSON.parse(packet.data).payload) });
      return { ok: true };
    },
  };
  return { bridge, launched, settled };
}

function seedDelivery(overrides = {}) {
  const task = {
    serverOrchestrate: true,
    spaceId: "space-1",
    threadId: "main",
    proxyProgramId: "self-prog",
    self: { programId: "self-prog", name: "Lead", handle: "lead" },
    billingEndpoint: { programId: BILLING_PROG, creatureId: "billing-cr", entityId: "main" },
    signalEndpoint: { programId: "signal-prog", creatureId: "signal-cr", entityId: "main" },
    historyEndpoint: { programId: "history-prog", creatureId: "history-cr", entityId: "main" },
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

await check("an answer's @mentioned teammate is launched with a delegated quote", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery();
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "Done. @writer please draft it.", chargedMinor: 10 });
  assert.equal(n, 1);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].target, "mate-prog");
  const t = launched[0].task;
  assert.equal(t.proxyProgramId, "mate-prog");
  assert.equal(t.billingAuthorization.quoteId, "q-1");
  assert.equal(t.billingAuthorization.payerUserId, "user-1");
  assert.equal(t.billingAuthorization.poolId, "pool-1");
  assert.equal(t.autonomousQuote, true);
  assert.equal(t.serverOrchestrate, true);
  assert.equal(t.orchestration.depth, 1);
  assert.ok(t.orchestration.visited.includes("self-prog"));
  assert.ok(t.orchestration.visited.includes("mate-prog"));
  // Context carried forward for the next hop.
  assert.equal(t.historyEndpoint.programId, "history-prog");
  assert.equal(t.billingEndpoint.programId, BILLING_PROG);
});

await check("no @mention → nothing launched", async () => {
  const { bridge, launched } = makeBridge();
  const n = await planAndLaunchFollowups(bridge, seedDelivery(), { success: true, answer: "All finished, no handoff." });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
});

await check("the hop cap halts the chain", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({ orchestration: { depth: 7, maxHops: 8, visited: ["self-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer keep going" });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
});

await check("a visited teammate is never relaunched", async () => {
  const { bridge, launched } = makeBridge();
  const delivery = seedDelivery({ orchestration: { depth: 1, maxHops: 8, visited: ["self-prog", "mate-prog"], poolId: "pool-1", payerUserId: "user-1" } });
  const n = await planAndLaunchFollowups(bridge, delivery, { success: true, answer: "@writer once more" });
  assert.equal(n, 0);
  assert.equal(launched.length, 0);
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
  assert.equal(delivery.task.billingAuthorization.quoteId, "q-1");
  assert.equal(delivery.task.autonomousQuote, true);
  assert.equal(delivery.task.orchestration.poolId, "pool-1");
});

console.log(`\n${failures.length ? RED : GREEN}${passed} passed, ${failures.length} failed${NC}`);
process.exit(failures.length ? 1 : 0);
