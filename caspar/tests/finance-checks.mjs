#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  authorizeBillingRun,
  authorizeDirectToolRun,
  releaseBillingRun,
  settleBillingRun,
  settleDirectToolRun,
} from "../finance.mjs";

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
  } = {}) {
    this.programId = programId;
    this.calls = [];
    this.settlementOk = settlementOk;
    this.quoteValue = quoteValue;
    this.holdValue = holdValue;
  }

  async call(op, input) {
    this.calls.push({ op, input });
    if (op === "getJson" && input.key === `Json::FinanceHold::${this.holdValue.holdId || "hold-1"}`) return { data: this.holdValue };
    if (op === "getJson" && input.key === `Json::BillingQuote::${this.quoteValue.quoteId}`) return { data: this.quoteValue };
    if (op === "startHold") return { ok: true };
    if (op === "settleHold") return this.settlementOk ? { ok: true } : { ok: false, error: "rejected" };
    if (op === "releaseHold") return { ok: true };
    if (op === "putJson") return { ok: true };
    throw new Error(`unexpected bridge call ${op}`);
  }
}

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
  const bridge = new Bridge();
  const session = await authorizeBillingRun(bridge, { task, correlationId: "run-1" });
  await expectReject(
    "observed tool usage cannot exceed its server quote ceiling",
    () => settleBillingRun(bridge, session, {
      promptTokens: 1,
      completionTokens: 1,
      durationMs: 1,
      sandboxActive: true,
      tools: [{ resourceId: "tool-1", calls: 9, runtimeMs: 1 }],
    }),
    /exceeds authorized quote ceiling/,
  );
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
  await expectReject(
    "direct tool runtime cannot exceed the server quote ceiling",
    () => settleDirectToolRun(bridge, session, {
      resourceId: "tool-1",
      calls: 1,
      runtimeMs: 60_001,
      outcome: "ok",
    }),
    /exceeds authorized quote ceiling/,
  );
}

console.log("finance checks passed");
