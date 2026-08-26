#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  authorizeBillingRun,
  authorizeDirectToolRun,
  chargeAgentCheckpoint,
  releaseBillingRun,
  settleBillingRun,
  settleDirectToolRun,
} from "../finance.mjs";
import { serveAgent } from "../runtime.mjs";

const quote = {
  quoteId: "quote-1",
  requestId: "run-1",
  payerUserId: "payer",
  kind: "agent",
  resourceId: "agent-program",
  projectId: "project-1",
  maxAmount: 20_000,
  beneficiaries: [
    { userId: "provider", role: "provider_clearing", maxAmount: 4_000 },
    { userId: "creator", role: "agent_creator", maxAmount: 7_000 },
    { userId: "platform", role: "platform", maxAmount: 4_000 },
    { userId: "node", role: "node_owner", maxAmount: 3_000 },
    { userId: "tool-node", role: "node_owner", maxAmount: 2_000 },
    { userId: "tool-owner", role: "tool_owner", maxAmount: 1_000 },
  ],
  priceSnapshot: {
    kind: "agent",
    inputPerMillionMinor: 2_000_000,
    outputPerMillionMinor: 4_000_000,
    providerInputPerMillionMinor: 1_000_000,
    providerOutputPerMillionMinor: 2_000_000,
    sandboxPerMinuteMinor: 600,
    minChargeMinor: 10,
    platformCommissionBps: 2_000,
    platformAccountId: "platform",
    providerClearingAccountId: "provider",
    nodeOwnerAccountId: "node",
    creatorAccountId: "creator",
    tools: [{
      resourceId: "tool-1",
      fixedMinor: 100,
      perCallMinor: 20,
      runtimePerMinuteMinor: 60,
      providerPerCallMinor: 10,
      sandboxPerMinuteMinor: 120,
      platformCommissionBps: 2_000,
      platformAccountId: "platform",
      providerClearingAccountId: "provider",
      nodeOwnerAccountId: "tool-node",
      creatorAccountId: "tool-owner",
      authorizedCalls: 8,
      authorizedRuntimeMs: 600_000,
    }],
  },
  executionPlan: {
    settlementAuthority: "node",
    meterProgramId: "trusted-meter",
    resources: [
      {
        kind: "agent",
        resourceId: "agent-program",
        nodeOwnerAccountId: "node",
        hostOriginId: "node-a",
        meterProgramId: "trusted-meter",
        settlementAuthority: "node",
        sandboxPerMinuteMinor: 600,
        nodeRegistrationRevision: "rev-agent",
      },
      {
        kind: "tool",
        resourceId: "tool-1",
        nodeOwnerAccountId: "tool-node",
        hostOriginId: "node-b",
        meterProgramId: "tool-node-meter",
        settlementAuthority: "tool-node",
        sandboxPerMinuteMinor: 120,
        nodeRegistrationRevision: "rev-tool",
      },
    ],
  },
};

const hold = {
  status: "open",
  payerUserId: "payer",
  quoteId: "quote-1",
  meterProgramId: "trusted-meter",
  settlementAuthority: "node",
  expiresAt: Date.now() + 60_000,
};

class Bridge {
  constructor({
    settlementOk = true,
    programId = "trusted-meter",
    quoteValue = quote,
    holdValue = hold,
    poolValue = null,
    poolExhausted = false,
  } = {}) {
    this.programId = programId;
    this.calls = [];
    this.settlementOk = settlementOk;
    this.quoteValue = quoteValue;
    this.holdValue = holdValue;
    this.poolValue = poolValue;
    this.poolExhausted = poolExhausted;
  }

  async call(op, input) {
    this.calls.push({ op, input });
    if (op === "getJson" && input.key === `Json::FinanceHold::${this.holdValue.holdId || "hold-1"}`) return { data: this.holdValue };
    if (op === "getJson" && this.poolValue && input.key === `Json::FinancePool::${this.poolValue.poolId}`) return { data: this.poolValue };
    if (op === "getJson" && input.key === `Json::BillingQuote::${this.quoteValue.quoteId}`) return { data: this.quoteValue };
    if (op === "startHold" || op === "reservePool") return { ok: true };
    if (op === "settleHold" || op === "settlePool") return this.settlementOk ? { ok: true } : { ok: false, error: "rejected" };
    if (op === "debitPool") {
      // The node's pool-authority host gateway wraps the action result under
      // `result` with a top-level `ok`; mirror that here.
      if (!this.settlementOk) return { ok: false, error: "rejected" };
      if (this.poolExhausted) {
        return { ok: true, result: { applied: false, exhausted: true, remaining: 0, charged: 0 } };
      }
      const charged = (input.lines || []).reduce((sum, line) => sum + line.amount, 0);
      return { ok: true, result: { applied: true, charged, remaining: 1_000_000 } };
    }
    if (op === "releaseHold" || op === "releasePool") return { ok: true };
    if (op === "putJson") return { ok: true };
    throw new Error(`unexpected bridge call ${op}`);
  }
}

const pool = {
  poolId: "pool-1",
  payerUserId: "payer",
  status: "open",
  meterProgramId: "trusted-meter",
  settlementAuthority: "node",
  remaining: 1_000_000,
  reserved: 0,
  spent: 0,
  expiresAt: Date.now() + 3_600_000,
};

const poolTask = {
  proxyProgramId: "agent-program",
  spaceId: "project-1",
  billingAuthorization: { poolId: "pool-1", payerUserId: "payer", quoteId: "quote-1" },
};

const task = {
  proxyProgramId: "agent-program",
  spaceId: "project-1",
  billingAuthorization: { holdId: "hold-1", payerUserId: "payer", quoteId: "quote-1" },
};

async function expectReject(label, fn, pattern) {
  await assert.rejects(fn, pattern, label);
}

{
  const bridge = new Bridge();
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  assert.equal(bridge.calls.at(-1).op, "startHold");
  const receipt = await settleBillingRun(bridge, session, {
    promptTokens: 1_000,
    completionTokens: 500,
    durationMs: 30_000,
    sandboxActive: true,
    tools: [{ resourceId: "tool-1", calls: 2, runtimeMs: 30_000 }],
  });
  assert.ok(receipt.chargedMinor > 0);
  assert.equal(receipt.usageHash.length, 64);
  const settle = bridge.calls.find((call) => call.op === "settleHold");
  assert.ok(settle, "the trusted runtime settled the hold");
  assert.equal(settle.input.settlementId, "run-1");
  assert.equal(settle.input.lines.reduce((sum, line) => sum + line.amount, 0), receipt.chargedMinor);
  assert.ok(settle.input.lines.some((line) => line.role === "tool_owner"));
  const paidNodes = new Set(
    settle.input.lines.filter((line) => line.role === "node_owner").map((line) => line.userId),
  );
  assert.deepEqual(paidNodes, new Set(["node", "tool-node"]), "agent and remote tool hosts are both paid");
}

{
  const bridge = new Bridge();
  const original = quote.executionPlan.resources[1].nodeOwnerAccountId;
  quote.executionPlan.resources[1].nodeOwnerAccountId = "forged-node";
  await expectReject(
    "tool execution-node metadata cannot diverge from the server price snapshot",
    () => authorizeBillingRun(bridge, { task, correlationId: "run-1" }),
    /tool execution node does not match quoted pricing/,
  );
  quote.executionPlan.resources[1].nodeOwnerAccountId = original;
}

await expectReject(
  "billing authorization is mandatory",
  () => authorizeBillingRun(new Bridge(), { task: { ...task, billingAuthorization: null }, correlationId: "run-1" }),
  /billing authorization required/,
);

await expectReject(
  "a quote cannot be replayed for another correlation",
  () => authorizeBillingRun(new Bridge(), { task, correlationId: "run-2" }),
  /not bound to this run/,
);

{
  const bridge = new Bridge();
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  await expectReject(
    "unquoted tools are rejected",
    () => settleBillingRun(bridge, session, {
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
      sandboxActive: true,
      tools: [{ resourceId: "tool-2", calls: 1, runtimeMs: 1 }],
    }),
    /not authorized by quote/,
  );
}

{
  // No per-run ceiling any more: tool usage that would have tripped the old
  // 8-call ceiling now settles (charges actual) instead of failing with
  // "actual tool usage exceeds authorized quote ceiling".
  const bridge = new Bridge();
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  const receipt = await settleBillingRun(bridge, session, {
    promptTokens: 1,
    completionTokens: 1,
    durationMs: 1,
    sandboxActive: true,
    tools: [{ resourceId: "tool-1", calls: 9, runtimeMs: 1 }],
  });
  assert.ok(receipt.chargedMinor > 0, "high tool call count settles instead of hitting a ceiling");
}

{
  const bridge = new Bridge();
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  await settleBillingRun(bridge, session, {
    promptTokens: 1,
    completionTokens: 1,
    durationMs: 30_000,
    sandboxActive: true,
    tools: [{ resourceId: "tool-1", calls: 1, runtimeMs: 30_000, outcome: "timeout" }],
  });
  const settle = bridge.calls.find((call) => call.op === "settleHold");
  assert.ok(!settle.input.lines.some((line) => line.userId === "tool-owner"), "timed-out tool owner is not paid");
  assert.ok(!settle.input.lines.some((line) => line.userId === "tool-node"), "timed-out remote node is not paid");
}

{
  const bridge = new Bridge({ settlementOk: false });
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  await expectReject(
    "a failed atomic settlement fails the run",
    () => settleBillingRun(bridge, session, {
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
      sandboxActive: false,
      tools: [],
    }),
    /rejected/,
  );
  const firstSettle = bridge.calls.find((call) => call.op === "settleHold");
  await expectReject(
    "retry preserves the original settlement evidence",
    () => settleBillingRun(bridge, session, {
      promptTokens: 999,
      completionTokens: 999,
      durationMs: 999,
      sandboxActive: true,
      tools: [],
    }),
    /rejected/,
  );
  const settleCalls = bridge.calls.filter((call) => call.op === "settleHold");
  assert.equal(settleCalls.length, 2);
  assert.equal(
    settleCalls[1].input.usageHash,
    firstSettle.input.usageHash,
    "exactly-once retries keep a deterministic usage hash",
  );
  assert.deepEqual(
    settleCalls[1].input.lines,
    firstSettle.input.lines,
    "exactly-once retries keep deterministic settlement lines",
  );
  const usageWrites = bridge.calls.filter((call) => call.op === "putJson");
  assert.equal(usageWrites.length, 2, "failed settlement remains observed, never marked settled");
}


const directToolQuote = {
  quoteId: "tool-quote-1",
  requestId: "tool-run-1",
  payerUserId: "payer",
  kind: "tool",
  resourceId: "tool-1",
  projectId: "project-1",
  maxAmount: 420,
  beneficiaries: [
    { userId: "provider", role: "provider_clearing", maxAmount: 20 },
    { userId: "tool-owner", role: "tool_owner", maxAmount: 200 },
    { userId: "platform", role: "platform", maxAmount: 100 },
    { userId: "tool-node", role: "node_owner", maxAmount: 100 },
  ],
  priceSnapshot: {
    kind: "tool",
    fixedMinor: 100,
    perCallMinor: 20,
    runtimePerMinuteMinor: 60,
    providerPerCallMinor: 10,
    sandboxPerMinuteMinor: 120,
    minChargeMinor: 10,
    platformCommissionBps: 2_000,
    platformAccountId: "platform",
    providerClearingAccountId: "provider",
    nodeOwnerAccountId: "tool-node",
    creatorAccountId: "tool-owner",
    authorizedCalls: 1,
    authorizedRuntimeMs: 60_000,
  },
  executionPlan: {
    settlementAuthority: "tool-node",
    meterProgramId: "tool-meter",
    resources: [{
      kind: "tool",
      resourceId: "tool-1",
      nodeOwnerAccountId: "tool-node",
      hostOriginId: "node-b",
      meterProgramId: "tool-meter",
      settlementAuthority: "tool-node",
      sandboxPerMinuteMinor: 120,
      nodeRegistrationRevision: "rev-tool",
    }],
  },
};

const directToolHold = {
  holdId: "tool-hold-1",
  status: "open",
  payerUserId: "payer",
  quoteId: "tool-quote-1",
  meterProgramId: "tool-meter",
  settlementAuthority: "tool-node",
  expiresAt: Date.now() + 60_000,
};

const directToolTask = {
  kind: "direct_tool",
  toolProgramId: "tool-1",
  spaceId: "project-1",
  billingAuthorization: {
    holdId: "tool-hold-1",
    payerUserId: "payer",
    quoteId: "tool-quote-1",
  },
};

{
  const bridge = new Bridge({
    programId: "tool-meter",
    quoteValue: directToolQuote,
    holdValue: directToolHold,
  });
  const session = await authorizeDirectToolRun(
    bridge,
    { task: directToolTask, correlationId: "tool-run-1" },
  );
  const receipt = await settleDirectToolRun(bridge, session, {
    resourceId: "tool-1",
    calls: 1,
    runtimeMs: 30_000,
    outcome: "ok",
  });
  assert.equal(receipt.chargedMinor, 210);
  const lines = bridge.calls.find((call) => call.op === "settleHold").input.lines;
  assert.ok(lines.some((line) => line.role === "tool_owner" && line.userId === "tool-owner"));
  assert.ok(lines.some((line) => line.role === "node_owner" && line.userId === "tool-node"));
  assert.ok(lines.some((line) => line.role === "provider_clearing"));
  assert.ok(lines.some((line) => line.role === "platform"));

  await releaseBillingRun(bridge, session, "test no receipt");
  assert.equal(bridge.calls.at(-1).op, "releaseHold");
  assert.equal(bridge.calls.at(-1).input.releaseId, "meter_release_tool-run-1");
}

// ── minimum-charge floor never fails a settlement ───────────────────────────
// A zero-margin run whose actual cost lands below the catalog minimum must
// still settle. The minimum-charge floor is a top-up routed to the platform
// account; it is clamped to whatever platform cap the quote reserved (here none)
// instead of throwing "quote does not authorize platform" and discarding the
// agent's answer.
{
  const zeroMarginQuote = {
    quoteId: "quote-z", requestId: "run-z", payerUserId: "payer",
    kind: "agent", resourceId: "agent-program", projectId: "project-1",
    maxAmount: 100_000,
    beneficiaries: [{ userId: "node", role: "node_owner", maxAmount: 100_000 }],
    priceSnapshot: {
      kind: "agent",
      inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 1_000_000,
      // gross == provider → zero margin → zero commission → no platform beneficiary quoted
      providerInputPerMillionMinor: 1_000_000, providerOutputPerMillionMinor: 1_000_000,
      sandboxPerMinuteMinor: 600, minChargeMinor: 10_000, platformCommissionBps: 2_000,
      platformAccountId: "platform", providerClearingAccountId: "provider",
      nodeOwnerAccountId: "node", creatorAccountId: "creator", tools: [],
    },
  };
  const bridge = new Bridge();
  const session = { runId: "run-z", quoteId: "quote-z", payerUserId: "payer", holdId: "hold-z", quote: zeroMarginQuote };
  const receipt = await settleBillingRun(bridge, session, {
    promptTokens: 0, completionTokens: 0, sandboxActive: true, durationMs: 1_000, tools: [],
  });
  const settle = bridge.calls.find((c) => c.op === "settleHold");
  assert.ok(settle, "a sub-minimum zero-margin run still settles instead of throwing");
  assert.ok(
    !settle.input.lines.some((l) => l.role === "platform"),
    "no platform floor line is charged when the quote reserved no platform cap",
  );
  assert.ok(receipt.chargedMinor < 10_000, "the run settles below the minimum rather than failing");
}

// ── agent run billing lifecycle (serveAgent) ────────────────────────────────
// authorizeBillingRun moves the hold open→running (startHold). From that point
// only this meter can free the hold before its TTL; the app cannot release a
// running hold. So a run that fails after start MUST release, or the payer's
// authorization stays "held for active runs" for the full hold TTL — the wallet
// drain these checks guard against.

const agentDelivery = { task, correlationId: "run-1" };

// A completed run settles and never releases.
{
  const bridge = new Bridge();
  const result = await serveAgent(bridge, agentDelivery, async () => ({
    answer: "done",
    success: true,
  }));
  assert.ok(bridge.calls.some((c) => c.op === "startHold"), "a billed run starts the hold");
  assert.ok(bridge.calls.some((c) => c.op === "settleHold"), "a completed run settles the hold");
  assert.ok(
    !bridge.calls.some((c) => c.op === "releaseHold"),
    "a completed run does not release the hold",
  );
  assert.equal(typeof result.chargedMinor, "number", "a settled run reports its charge");
}

// A run that throws after the hold started releases the running hold so the
// authorization is not stranded, then re-surfaces the original error.
{
  const bridge = new Bridge();
  await expectReject(
    "an agent run that throws after start propagates its error",
    () => serveAgent(bridge, agentDelivery, async () => {
      throw new Error("attachment materialization failed");
    }),
    /attachment materialization failed/,
  );
  const release = bridge.calls.find((c) => c.op === "releaseHold");
  assert.ok(release, "a failed agent run releases the running hold");
  assert.equal(release.input.holdId, "hold-1", "the leaked authorization is released");
  assert.ok(
    !bridge.calls.some((c) => c.op === "settleHold"),
    "a run that never produced usage is not settled",
  );
}

// A run whose atomic settlement keeps failing releases the running hold rather
// than leaving the payer's funds held, and surfaces a reconciliation error.
{
  const bridge = new Bridge({ settlementOk: false });
  await expectReject(
    "an unsettleable agent run surfaces a reconciliation error",
    () => serveAgent(bridge, agentDelivery, async () => ({ answer: "partial", success: false })),
    /pending reconciliation/,
  );
  assert.ok(
    bridge.calls.some((c) => c.op === "releaseHold"),
    "a failed settlement releases the running hold so funds are not stranded",
  );
}

// ── shared-pool live-metering run path (debit against the pool) ──────────────
// A run whose authorization carries a poolId meters live: no per-run reservation
// or ceiling — it debits actual accrued cost from the pool's shared remaining
// (debitPool) and stops peacefully when the pool reports exhausted. There is no
// hold and nothing to release.
{
  const bridge = new Bridge({ poolValue: pool });
  const session = await authorizeBillingRun(bridge, { task: poolTask, correlationId: "run-1" });
  assert.equal(session.poolId, "pool-1", "a pool-backed run carries the pool id");
  assert.equal(session.mode, "live", "a pool-backed run meters live");
  assert.ok(!session.holdId, "a pool-backed run has no per-run hold");
  assert.ok(!bridge.calls.some((c) => c.op === "reservePool"), "live runs do not reserve a slice up front");
  assert.ok(!bridge.calls.some((c) => c.op === "startHold"), "pool runs do not start a hold");

  const receipt = await settleBillingRun(bridge, session, {
    promptTokens: 1_000, completionTokens: 500, sandboxActive: false, durationMs: 1_000, tools: [],
  });
  const debit = bridge.calls.find((c) => c.op === "debitPool");
  assert.ok(debit, "settlement debits the pool");
  assert.equal(debit.input.poolId, "pool-1");
  assert.equal(debit.input.runId, "run-1");
  assert.equal(debit.input.usageHash.length, 64);
  assert.ok(receipt.chargedMinor > 0, "a live pool run charges the computed cost");
  assert.ok(
    !bridge.calls.some((c) => c.op === "settleHold" || c.op === "settlePool"),
    "live runs neither settle a hold nor a reservation",
  );
}

// A live checkpoint that finds the pool exhausted stops peacefully (no throw).
{
  const bridge = new Bridge({ poolValue: pool, poolExhausted: true });
  const session = await authorizeBillingRun(bridge, { task: poolTask, correlationId: "run-1" });
  const res = await chargeAgentCheckpoint(bridge, session, {
    promptTokens: 1_000, completionTokens: 500, sandboxActive: false, durationMs: 1_000, tools: [],
  });
  assert.equal(res.exhausted, true, "an exhausted pool stops the run instead of failing it");
}

// A live run reserved nothing, so a failure/stop releases nothing.
{
  const bridge = new Bridge({ poolValue: pool });
  const session = await authorizeBillingRun(bridge, { task: poolTask, correlationId: "run-1" });
  await releaseBillingRun(bridge, session, "run failed before settlement");
  assert.ok(
    !bridge.calls.some((c) => c.op === "releasePool" || c.op === "releaseHold"),
    "a live run has no reservation to release",
  );
}

// A closed/expired pool refuses new runs (fail closed).
{
  const bridge = new Bridge({ poolValue: { ...pool, status: "closed" } });
  await expectReject(
    "a run cannot authorize against a closed pool",
    () => authorizeBillingRun(bridge, { task: poolTask, correlationId: "run-1" }),
    /pool is not open/,
  );
}

console.log("finance checks passed");
