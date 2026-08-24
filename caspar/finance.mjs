import crypto from "node:crypto";

const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;
const AGENT_SETTLEMENT_EVIDENCE = Symbol("agentSettlementEvidence");
const TOOL_SETTLEMENT_EVIDENCE = Symbol("toolSettlementEvidence");

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`invalid finance integer ${name}`);
  }
  return number;
}

function add(a, b, name) {
  const total = a + b;
  if (!Number.isSafeInteger(total) || total > MAX_SAFE_MINOR) {
    throw new Error(`finance overflow: ${name}`);
  }
  return total;
}

function ceilMulDiv(units, rate, divisor, name) {
  units = integer(units, `${name}.units`);
  rate = integer(rate, `${name}.rate`);
  divisor = integer(divisor, `${name}.divisor`);
  if (divisor <= 0) throw new Error(`invalid divisor: ${name}`);
  const product = BigInt(units) * BigInt(rate);
  const amount = (product + BigInt(divisor) - 1n) / BigInt(divisor);
  if (amount > BigInt(MAX_SAFE_MINOR)) throw new Error(`finance overflow: ${name}`);
  return Number(amount);
}

function dataObject(response) {
  if (!response || typeof response !== "object") return null;
  const data = response.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

async function readJson(bridge, key, path) {
  return dataObject(await bridge.call("getJson", { key, path }));
}

function authorization(task) {
  const value = task?.billingAuthorization;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function capMap(quote) {
  const caps = new Map();
  for (const row of Array.isArray(quote?.beneficiaries) ? quote.beneficiaries : []) {
    const userId = String(row?.userId || "");
    const role = String(row?.role || "");
    const amount = integer(row?.maxAmount, "beneficiary.maxAmount");
    if (!userId || !role || amount <= 0) throw new Error("invalid quote beneficiary");
    caps.set(`${userId}|${role}`, amount);
  }
  return caps;
}

function validateExecutionPlan(hold, quote, bridgeProgramId) {
  const plan = quote?.executionPlan;
  // Quotes created before the federated cutover remain runnable under the
  // original hold meter checks. Every new quote carries this stronger binding.
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return;
  const authority = String(plan.settlementAuthority || "");
  const meterProgramId = String(plan.meterProgramId || "");
  if (!authority || authority !== String(hold?.settlementAuthority || "")) {
    throw new Error("billing execution authority mismatch");
  }
  if (!meterProgramId || meterProgramId !== String(hold?.meterProgramId || "") || meterProgramId !== String(bridgeProgramId || "")) {
    throw new Error("billing execution meter mismatch");
  }
  const resources = new Map();
  for (const raw of Array.isArray(plan.resources) ? plan.resources : []) {
    const kind = String(raw?.kind || "");
    const resourceId = String(raw?.resourceId || "");
    const nodeOwnerAccountId = String(raw?.nodeOwnerAccountId || "");
    const resourceMeter = String(raw?.meterProgramId || "");
    if (!kind || !resourceId || !nodeOwnerAccountId || !resourceMeter) {
      throw new Error("invalid billing execution resource");
    }
    const key = `${kind}|${resourceId}`;
    if (resources.has(key)) throw new Error("duplicate billing execution resource");
    resources.set(key, raw);
  }
  const price = quote?.priceSnapshot || {};
  const quoteKind = String(quote?.kind || "");
  if (quoteKind !== "agent" && quoteKind !== "tool") {
    throw new Error("unsupported billing execution kind");
  }
  const coordinator = resources.get(`${quoteKind}|${String(quote?.resourceId || "")}`);
  if (!coordinator || String(coordinator.nodeOwnerAccountId) !== String(price.nodeOwnerAccountId || "")) {
    throw new Error(`${quoteKind} execution node does not match quoted pricing`);
  }
  if (String(coordinator.meterProgramId) !== meterProgramId) {
    throw new Error(`${quoteKind} coordinator meter does not match execution plan`);
  }
  if (integer(coordinator.sandboxPerMinuteMinor, "coordinator.sandboxRate") !== integer(price.sandboxPerMinuteMinor, `${quoteKind}.sandboxRate`)) {
    throw new Error(`${quoteKind} execution rate does not match quoted pricing`);
  }
  if (quoteKind === "tool" && resources.size !== 1) {
    throw new Error("direct tool quote contains unexpected execution resources");
  }
  for (const tool of Array.isArray(price.tools) ? price.tools : []) {
    const resourceId = String(tool?.resourceId || "");
    const execution = resources.get(`tool|${resourceId}`);
    if (!execution || String(execution.nodeOwnerAccountId) !== String(tool?.nodeOwnerAccountId || "")) {
      throw new Error("tool execution node does not match quoted pricing");
    }
    if (integer(execution.sandboxPerMinuteMinor, "toolExecution.sandboxRate") !== integer(tool?.sandboxPerMinuteMinor, "tool.sandboxRate")) {
      throw new Error("tool execution rate does not match quoted pricing");
    }
  }
}

function toolSettlement(quote, observed, sourceRef) {
  const price = quote.priceSnapshot || {};
  if (price.kind !== "tool" || quote.kind !== "tool") {
    throw new Error("quote price snapshot is not tool pricing");
  }
  const resourceId = String(quote.resourceId || "");
  if (!resourceId || String(observed.resourceId || "") !== resourceId) {
    throw new Error("observed tool does not match the authorized quote");
  }
  const calls = integer(observed.calls, "tool.calls");
  const runtimeMs = integer(observed.runtimeMs, "tool.runtimeMs");
  const authorizedCalls = integer(price.authorizedCalls, "tool.authorizedCalls");
  const authorizedRuntimeMs = integer(price.authorizedRuntimeMs, "tool.authorizedRuntimeMs");
  if (calls > authorizedCalls || runtimeMs > authorizedRuntimeMs) {
    throw new Error("actual tool usage exceeds authorized quote ceiling");
  }
  const fixed = calls > 0 ? integer(price.fixedMinor, "tool.fixedMinor") : 0;
  const callCost = ceilMulDiv(calls, price.perCallMinor, 1, "tool.calls");
  const runtimeCost = ceilMulDiv(runtimeMs, price.runtimePerMinuteMinor, 60_000, "tool.runtime");
  const gross = add(add(fixed, callCost, "tool.gross"), runtimeCost, "tool.gross");
  const provider = ceilMulDiv(calls, price.providerPerCallMinor, 1, "tool.provider");
  if (gross < provider) throw new Error("actual tool price is below provider cost");
  const margin = gross - provider;
  const commission = ceilMulDiv(margin, price.platformCommissionBps, 10_000, "tool.commission");
  const creator = margin - commission;
  const node = ceilMulDiv(runtimeMs, price.sandboxPerMinuteMinor, 60_000, "tool.node");
  const caps = capMap(quote);
  const lines = [];
  const payer = String(quote.payerUserId || "");
  addLine(lines, caps, payer, String(price.providerClearingAccountId), "provider_clearing", provider, sourceRef);
  addLine(lines, caps, payer, String(price.creatorAccountId), "tool_owner", creator, sourceRef);
  addLine(lines, caps, payer, String(price.platformAccountId), "platform", commission, sourceRef);
  addLine(lines, caps, payer, String(price.nodeOwnerAccountId), "node_owner", node, sourceRef);
  let total = lines.reduce((sum, line) => add(sum, line.amount, "settlementTotal"), 0);
  const minimum = integer(price.minChargeMinor, "minChargeMinor");
  if (total < minimum) {
    const topUp = Math.min(
      minimum - total,
      platformFloorRoom(lines, caps, payer, String(price.platformAccountId)),
    );
    if (topUp > 0) {
      addLine(lines, caps, payer, String(price.platformAccountId), "platform", topUp, sourceRef);
      total = lines.reduce((sum, line) => add(sum, line.amount, "settlementTotal"), 0);
    }
  }
  if (total > integer(quote.maxAmount, "quote.maxAmount")) {
    throw new Error("actual cost exceeds authorized hold");
  }
  return { lines, total, resourceId, calls, runtimeMs, outcome: String(observed.outcome || "ok") };
}

function addLine(lines, caps, payerUserId, userId, role, amount, sourceRef) {
  amount = integer(amount, `${role}.amount`);
  if (amount === 0 || userId === payerUserId) return;
  const key = `${userId}|${role}`;
  const cap = caps.get(key);
  if (cap === undefined) throw new Error(`quote does not authorize ${role}`);
  const already = lines
    .filter((line) => line.userId === userId && line.role === role)
    .reduce((sum, line) => add(sum, line.amount, `${role}.total`), 0);
  if (add(already, amount, `${role}.cap`) > cap) {
    throw new Error(`actual ${role} cost exceeds authorized cap`);
  }
  lines.push({ userId, role, amount, sourceRef });
}

/**
 * How much of the minimum-charge floor may still be routed to the platform
 * account without exceeding what the quote authorized for it. The floor is a
 * top-up, not a metered cost, so it must never fail a settlement: if the quote
 * under-reserved the platform cap (e.g. a zero-margin agent/tool whose
 * commission rounded to zero, so no platform beneficiary was quoted), collect
 * as much of the minimum as was authorized and settle — rather than throwing
 * "quote does not authorize platform" and discarding an answer the agent
 * already produced. Returns 0 when the payer is the platform account or the
 * quote reserved no platform cap.
 */
function platformFloorRoom(lines, caps, payerUserId, platformAccountId) {
  if (!platformAccountId || platformAccountId === payerUserId) return 0;
  const cap = caps.get(`${platformAccountId}|platform`);
  if (cap === undefined) return 0;
  const already = lines
    .filter((line) => line.userId === platformAccountId && line.role === "platform")
    .reduce((sum, line) => add(sum, line.amount, "platform.floor.total"), 0);
  return Math.max(0, cap - already);
}

function agentSettlement(quote, observed, sourceRef) {
  const price = quote.priceSnapshot || {};
  if (price.kind !== "agent") throw new Error("quote price snapshot is not agent pricing");
  const promptTokens = integer(observed.promptTokens, "promptTokens");
  const completionTokens = integer(observed.completionTokens, "completionTokens");
  const sandboxMs = observed.sandboxActive ? integer(observed.durationMs, "sandboxMs") : 0;
  const grossInput = ceilMulDiv(promptTokens, price.inputPerMillionMinor, 1_000_000, "input");
  const grossOutput = ceilMulDiv(completionTokens, price.outputPerMillionMinor, 1_000_000, "output");
  const gross = add(grossInput, grossOutput, "gross");
  const providerInput = ceilMulDiv(
    promptTokens,
    price.providerInputPerMillionMinor,
    1_000_000,
    "providerInput",
  );
  const providerOutput = ceilMulDiv(
    completionTokens,
    price.providerOutputPerMillionMinor,
    1_000_000,
    "providerOutput",
  );
  const provider = add(providerInput, providerOutput, "provider");
  if (gross < provider) throw new Error("actual consumer price is below provider cost");
  const margin = gross - provider;
  const commission = ceilMulDiv(margin, price.platformCommissionBps, 10_000, "commission");
  const creator = margin - commission;
  const node = ceilMulDiv(sandboxMs, price.sandboxPerMinuteMinor, 60_000, "sandbox");
  const caps = capMap(quote);
  const lines = [];
  const payer = String(quote.payerUserId || "");
  addLine(lines, caps, payer, String(price.providerClearingAccountId), "provider_clearing", provider, sourceRef);
  addLine(lines, caps, payer, String(price.creatorAccountId), "agent_creator", creator, sourceRef);
  addLine(lines, caps, payer, String(price.platformAccountId), "platform", commission, sourceRef);
  addLine(lines, caps, payer, String(price.nodeOwnerAccountId), "node_owner", node, sourceRef);

  const toolPrices = new Map();
  for (const raw of Array.isArray(price.tools) ? price.tools : []) {
    const resourceId = String(raw?.resourceId || "");
    if (!resourceId || toolPrices.has(resourceId)) throw new Error("invalid quoted tool snapshot");
    toolPrices.set(resourceId, raw);
  }
  const toolUsage = new Map();
  for (const raw of Array.isArray(observed.tools) ? observed.tools : []) {
    const resourceId = String(raw?.resourceId || "");
    if (!toolPrices.has(resourceId)) throw new Error("observed tool is not authorized by quote");
    const calls = integer(raw?.calls, "tool.calls");
    const runtimeMs = integer(raw?.runtimeMs, "tool.runtimeMs");
    const outcome = String(raw?.outcome || "ok");
    const current = toolUsage.get(resourceId) || { resourceId, calls: 0, runtimeMs: 0, timeouts: 0 };
    // A routed tools/result packet is the completion receipt. If the remote
    // node never returns one, retain the timeout in usage evidence but do not
    // pay its tool owner or node for unproven execution.
    if (outcome === "timeout") {
      current.timeouts = add(current.timeouts, calls, "tool.timeouts.total");
    } else {
      current.calls = add(current.calls, calls, "tool.calls.total");
      current.runtimeMs = add(current.runtimeMs, runtimeMs, "tool.runtime.total");
    }
    toolUsage.set(resourceId, current);
  }
  for (const usage of toolUsage.values()) {
    const tool = toolPrices.get(usage.resourceId);
    const authorizedCalls = integer(tool.authorizedCalls, "tool.authorizedCalls");
    const authorizedRuntimeMs = integer(tool.authorizedRuntimeMs, "tool.authorizedRuntimeMs");
    if (usage.calls > authorizedCalls || usage.runtimeMs > authorizedRuntimeMs) {
      throw new Error("actual tool usage exceeds authorized quote ceiling");
    }
    const fixed = usage.calls > 0 ? integer(tool.fixedMinor, "tool.fixedMinor") : 0;
    const callCost = ceilMulDiv(usage.calls, tool.perCallMinor, 1, "tool.calls");
    const runtimeCost = ceilMulDiv(
      usage.runtimeMs,
      tool.runtimePerMinuteMinor,
      60_000,
      "tool.runtime",
    );
    const toolGross = add(add(fixed, callCost, "tool.gross"), runtimeCost, "tool.gross");
    const toolProvider = ceilMulDiv(
      usage.calls,
      tool.providerPerCallMinor,
      1,
      "tool.provider",
    );
    if (toolGross < toolProvider) throw new Error("actual tool price is below provider cost");
    const toolMargin = toolGross - toolProvider;
    const toolCommission = ceilMulDiv(
      toolMargin,
      tool.platformCommissionBps,
      10_000,
      "tool.commission",
    );
    const toolCreator = toolMargin - toolCommission;
    const toolNode = ceilMulDiv(
      usage.runtimeMs,
      tool.sandboxPerMinuteMinor,
      60_000,
      "tool.node",
    );
    const toolRef = `${sourceRef}:${usage.resourceId}`;
    addLine(lines, caps, payer, String(tool.providerClearingAccountId), "provider_clearing", toolProvider, toolRef);
    addLine(lines, caps, payer, String(tool.creatorAccountId), "tool_owner", toolCreator, toolRef);
    addLine(lines, caps, payer, String(tool.platformAccountId), "platform", toolCommission, toolRef);
    addLine(lines, caps, payer, String(tool.nodeOwnerAccountId), "node_owner", toolNode, toolRef);
  }

  let total = lines.reduce((sum, line) => add(sum, line.amount, "settlementTotal"), 0);
  const minimum = integer(price.minChargeMinor, "minChargeMinor");
  if (total < minimum) {
    const topUp = Math.min(
      minimum - total,
      platformFloorRoom(lines, caps, payer, String(price.platformAccountId)),
    );
    if (topUp > 0) {
      addLine(lines, caps, payer, String(price.platformAccountId), "platform", topUp, sourceRef);
      total = lines.reduce((sum, line) => add(sum, line.amount, "settlementTotal"), 0);
    }
  }
  if (total > integer(quote.maxAmount, "quote.maxAmount")) {
    throw new Error("actual cost exceeds authorized hold");
  }
  return { lines, total, promptTokens, completionTokens, sandboxMs, tools: [...toolUsage.values()] };
}

function usageHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Validate a run's committed quote against its authorization (pool or hold) for
// the fields both paths share, and return the loaded quote. Throws on mismatch.
function assertQuoteBinding(quote, { payerUserId, quoteId }, { task, correlationId }, expectedKind) {
  if (String(quote.payerUserId) !== payerUserId) throw new Error("billing payer mismatch");
  if (String(quote.quoteId) !== quoteId) throw new Error("billing quote mismatch");
  if (String(quote.requestId) !== String(correlationId)) {
    throw new Error("billing quote is not bound to this run");
  }
  if (String(quote.kind || "") !== expectedKind || String(quote.priceSnapshot?.kind || "") !== expectedKind) {
    throw new Error(`billing quote is not for a ${expectedKind} run`);
  }
  const expectedResourceId = expectedKind === "agent"
    ? String(task.proxyProgramId || "")
    : String(task.toolProgramId || "");
  if (String(quote.resourceId) !== expectedResourceId) {
    throw new Error(`billing quote is not for this ${expectedKind}`);
  }
  if (String(quote.projectId || "") !== String(task.spaceId || "")) {
    throw new Error("billing quote is not for this project");
  }
}

// Reserve a run's slice from the payer's shared pool (the pool replaces per-run
// holds). The reservation ceiling is the quote's authorized maxAmount; the run
// later settles its actual usage against that slice and returns the remainder to
// the pool. Concurrent runs across the user's spaces all draw down one pool.
async function authorizePoolRun(bridge, { task, correlationId }, expectedKind, { poolId, payerUserId, quoteId }) {
  if (!poolId || !payerUserId || !quoteId || !correlationId) {
    throw new Error("incomplete billing authorization");
  }
  const [pool, quote] = await Promise.all([
    readJson(bridge, `Json::FinancePool::${poolId}`, "pool"),
    readJson(bridge, `Json::BillingQuote::${quoteId}`, "quote"),
  ]);
  if (!pool || !quote) throw new Error("billing pool or quote not found");
  if (pool.status !== "open") throw new Error("billing pool is not open");
  if (String(pool.payerUserId) !== payerUserId) throw new Error("billing payer mismatch");
  assertQuoteBinding(quote, { payerUserId, quoteId }, { task, correlationId }, expectedKind);
  if (String(pool.meterProgramId) !== String(bridge.programId || "")) {
    throw new Error("billing pool is not assigned to this meter");
  }
  validateExecutionPlan(pool, quote, bridge.programId);
  if (Date.now() > integer(pool.expiresAt, "pool.expiresAt")) {
    throw new Error("billing pool expired");
  }
  const reserve = await bridge.call(
    "reservePool",
    {
      poolId,
      payerUserId,
      quoteId,
      runId: String(correlationId),
      maxAmount: integer(quote.maxAmount, "quote.maxAmount"),
    },
    { timeoutMs: 35_000 },
  );
  if (!reserve || reserve.ok !== true) {
    throw new Error(String(reserve?.error || "could not reserve from billing pool"));
  }
  return { poolId, payerUserId, quoteId, runId: String(correlationId), quote };
}

async function authorizeRun(bridge, { task, correlationId }, expectedKind) {
  const auth = authorization(task);
  if (!auth) throw new Error("billing authorization required");
  const payerUserId = String(auth.payerUserId || "");
  const quoteId = String(auth.quoteId || "");
  const poolId = String(auth.poolId || "");
  if (poolId) {
    return authorizePoolRun(bridge, { task, correlationId }, expectedKind, { poolId, payerUserId, quoteId });
  }
  const holdId = String(auth.holdId || "");
  if (!holdId || !payerUserId || !quoteId || !correlationId) {
    throw new Error("incomplete billing authorization");
  }
  const [hold, quote] = await Promise.all([
    readJson(bridge, `Json::FinanceHold::${holdId}`, "hold"),
    readJson(bridge, `Json::BillingQuote::${quoteId}`, "quote"),
  ]);
  if (!hold || !quote) throw new Error("billing hold or quote not found");
  if (hold.status !== "open") throw new Error("billing hold is not open");
  if (String(hold.payerUserId) !== payerUserId || String(quote.payerUserId) !== payerUserId) {
    throw new Error("billing payer mismatch");
  }
  if (String(hold.quoteId) !== quoteId || String(quote.quoteId) !== quoteId) {
    throw new Error("billing quote mismatch");
  }
  if (String(quote.requestId) !== String(correlationId)) {
    throw new Error("billing quote is not bound to this run");
  }
  if (String(quote.kind || "") !== expectedKind || String(quote.priceSnapshot?.kind || "") !== expectedKind) {
    throw new Error(`billing quote is not for a ${expectedKind} run`);
  }
  const expectedResourceId = expectedKind === "agent"
    ? String(task.proxyProgramId || "")
    : String(task.toolProgramId || "");
  if (String(quote.resourceId) !== expectedResourceId) {
    throw new Error(`billing quote is not for this ${expectedKind}`);
  }
  const spaceId = String(task.spaceId || "");
  if (String(quote.projectId || "") !== spaceId) {
    throw new Error("billing quote is not for this project");
  }
  if (String(hold.meterProgramId) !== String(bridge.programId || "")) {
    throw new Error("billing hold is not assigned to this meter");
  }
  validateExecutionPlan(hold, quote, bridge.programId);
  if (Date.now() > integer(hold.expiresAt, "hold.expiresAt")) {
    throw new Error("billing hold expired");
  }

  const start = await bridge.call(
    "startHold",
    { holdId, payerUserId, quoteId, runId: String(correlationId) },
    { timeoutMs: 35_000 },
  );
  if (!start || start.ok !== true) {
    throw new Error(String(start?.error || "could not reserve billing hold"));
  }
  return { holdId, payerUserId, quoteId, runId: String(correlationId), quote };
}

export function authorizeBillingRun(bridge, delivery) {
  return authorizeRun(bridge, delivery, "agent");
}

export function authorizeDirectToolRun(bridge, delivery) {
  return authorizeRun(bridge, delivery, "tool");
}

// Route a computed settlement to the right Caspar op: settlePool for a pool-backed
// session (the run draws down the user's shared pool), settleHold for a legacy
// per-run hold. The lines and their caps are identical either way — only the
// authorization the actual usage settles against differs.
async function submitSettlement(bridge, session, usageHashValue, lines) {
  const shared = {
    payerUserId: session.payerUserId,
    quoteId: session.quoteId,
    settlementId: session.runId,
    usageHash: usageHashValue,
    lines,
  };
  const [op, input] = session.poolId
    ? ["settlePool", { poolId: session.poolId, runId: session.runId, ...shared }]
    : ["settleHold", { holdId: session.holdId, ...shared }];
  const response = await bridge.call(op, input, { timeoutMs: 35_000 });
  if (!response || response.ok !== true) {
    throw new Error(String(response?.error || "billing settlement failed"));
  }
  return response;
}

export async function settleBillingRun(bridge, session, observed) {
  if (!session[AGENT_SETTLEMENT_EVIDENCE]) {
    const settlement = agentSettlement(session.quote, observed, session.runId);
    const usage = {
      runId: session.runId,
      quoteId: session.quoteId,
      payerUserId: session.payerUserId,
      observedAt: Date.now(),
      promptTokens: settlement.promptTokens,
      completionTokens: settlement.completionTokens,
      sandboxMs: settlement.sandboxMs,
      tools: settlement.tools,
      lines: settlement.lines,
      totalMinor: settlement.total,
    };
    session[AGENT_SETTLEMENT_EVIDENCE] = {
      settlement,
      usage,
      hash: usageHash(usage),
    };
  }
  const { settlement, usage, hash } = session[AGENT_SETTLEMENT_EVIDENCE];
  await bridge.call("putJson", {
    key: `Json::BillingUsage::${session.runId}`,
    path: "usage",
    data: { ...usage, usageHash: hash, status: "observed" },
    merge: false,
  });
  await submitSettlement(bridge, session, hash, settlement.lines);
  await bridge.call("putJson", {
    key: `Json::BillingUsage::${session.runId}`,
    path: "usage",
    data: { status: "settled", settledAt: Date.now() },
    merge: true,
  });
  return { chargedMinor: settlement.total, usageHash: hash, lines: settlement.lines };
}

export async function settleDirectToolRun(bridge, session, observed) {
  if (!session[TOOL_SETTLEMENT_EVIDENCE]) {
    const settlement = toolSettlement(session.quote, observed, session.runId);
    const usage = {
      runId: session.runId,
      quoteId: session.quoteId,
      payerUserId: session.payerUserId,
      observedAt: Date.now(),
      resourceId: settlement.resourceId,
      calls: settlement.calls,
      runtimeMs: settlement.runtimeMs,
      outcome: settlement.outcome,
      lines: settlement.lines,
      totalMinor: settlement.total,
    };
    session[TOOL_SETTLEMENT_EVIDENCE] = {
      settlement,
      usage,
      hash: usageHash(usage),
    };
  }
  const { settlement, usage, hash } = session[TOOL_SETTLEMENT_EVIDENCE];
  await bridge.call("putJson", {
    key: `Json::BillingUsage::${session.runId}`,
    path: "usage",
    data: { ...usage, usageHash: hash, status: "observed" },
    merge: false,
  });
  await submitSettlement(bridge, session, hash, settlement.lines);
  await bridge.call("putJson", {
    key: `Json::BillingUsage::${session.runId}`,
    path: "usage",
    data: { status: "settled", settledAt: Date.now() },
    merge: true,
  });
  return { chargedMinor: settlement.total, usageHash: hash, lines: settlement.lines };
}

export async function releaseBillingRun(bridge, session, reason) {
  const releaseId = `meter_release_${session.runId}`;
  const reasonText = String(reason || "execution did not produce a receipt").slice(0, 256);
  const [op, input] = session.poolId
    ? ["releasePool", { poolId: session.poolId, payerUserId: session.payerUserId, runId: session.runId, releaseId, reason: reasonText }]
    : ["releaseHold", { holdId: session.holdId, payerUserId: session.payerUserId, releaseId, reason: reasonText }];
  const response = await bridge.call(op, input, { timeoutMs: 35_000 });
  if (!response || response.ok !== true) {
    throw new Error(String(response?.error || "billing hold release failed"));
  }
}
