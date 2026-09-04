/**
 * Server-side agent orchestration — the backbone drives the @mention fan-out
 * chain itself, so multi-agent work continues with NO client present.
 *
 * Today the client (`onAskOrbit` in new-decillion) runs each agent, then reads
 * whom its answer @mentioned and launches those teammates. That whole loop dies
 * the moment the app closes. This module moves it into the backbone: after a
 * server-orchestrated run persists its answer, the backbone resolves the
 * teammates the answer @mentioned, mints a DELEGATED billing quote for each
 * (drawing on the payer's already-open pool, bounded by the project's
 * autonomous budget), and signals each teammate's proxy to run — re-entering
 * this same backbone as an ordinary delivery. The chain therefore runs to
 * completion (and every turn is persisted on-chain) whether or not a client is
 * ever connected; a connected owner still sees it live because every run streams
 * to `streamTo`.
 *
 * Billing note: only runs the backbone launches this way carry a delegated
 * quote (`autonomousQuote`) and count against the project's autonomous budget.
 * A user-initiated seed run keeps its own client-minted quote and is unaffected.
 *
 * Loop safety is the HOP BUDGET (`orchestration.maxHops`), plus the autonomous
 * budget that bounds what an unattended chain may spend. A teammate is never
 * refused work just because it already spoke earlier in the chain: teamwork is a
 * lead and a specialist trading turns, and vetoing that stopped real work
 * mid-task. `visited` is carried per branch for the trail (and for an optional
 * tighter cap, `GROK_ORCH_VISIT_CAP`), not as a one-shot ticket per agent.
 */
import crypto from "node:crypto";

import { postSpaceSignal, KIND } from "./spaceHistory.mjs";

const DEFAULT_MAX_HOPS = 32;

/**
 * How many times ONE agent may be handed work along a single branch of the
 * chain.
 *
 * The loop guard is the HOP BUDGET, not this ledger: every hand-off costs a hop,
 * so a pair that keep tagging each other stop at exactly the depth any other
 * chain does, and the project's autonomous budget bounds the spend. A tighter
 * per-agent ledger looked like a second safety net, but it vetoed the normal
 * shape of teamwork — a lead handing work back and forth with a specialist —
 * and the veto surfaced in chat as "no teammate matched", so the chain died
 * mid-task for a reason nobody could read. Default: the hop budget, i.e. it
 * never binds before depth does. `GROK_ORCH_VISIT_CAP` restores a tighter cap.
 */
function visitCapFor(maxHops) {
  const configured = Number(process.env.GROK_ORCH_VISIT_CAP);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  return Math.max(1, Number(maxHops) || DEFAULT_MAX_HOPS);
}

// Surface a stalled @mention chain IN THE CHAT (not just the VM log) so the exact
// blocker is visible in-app. On by default while stabilising server-side
// orchestration; set GROK_ORCH_NOTES=off to silence.
const ORCH_NOTES = String(process.env.GROK_ORCH_NOTES ?? "").trim().toLowerCase() !== "off";

async function noteChain(bridge, task, text, kind = "orch-stall") {
  if (!ORCH_NOTES || !bridge) return;
  try {
    const spaceId = String((task && (task.spaceId || task.storeId || task.space_id)) || "");
    if (!spaceId) return;
    const threadId = String((task && task.threadId) || "main") || "main";
    await postSpaceSignal(bridge, {
      spaceId,
      // A note about the chain is part of the run's work trail, not a chat turn,
      // so it is a step: visible in the work view, never a bubble in the chat.
      kind: KIND.STEP,
      threadId,
      correlationId: String((task && task.correlationId) || ""),
      data: {
        role: "system",
        kind,
        text,
        threadId,
        at: new Date().toISOString(),
      },
    });
  } catch {
    /* diagnostics must never break the run */
  }
}

/** The chain could not continue, and why — the blocker, stated in the trail. */
async function noteStall(bridge, task, reason) {
  await noteChain(bridge, task, `⚠️ Hand-off didn't continue: ${reason}`);
}

function log(sentinel, payload) {
  process.stdout.write(`${sentinel} ${JSON.stringify(payload)}\n`);
}

function endpointFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const programId = String(raw.programId || raw.program_id || "").trim();
  if (!programId) return null;
  return {
    programId,
    creatureId: String(raw.creatureId || raw.creature_id || "").trim(),
    entityId: String(raw.entityId || raw.entity_id || "main").trim() || "main",
  };
}

export function billingEndpointFromTask(task) {
  return endpointFrom(task && (task.billingEndpoint || task.billing_endpoint));
}

/**
 * A server-orchestrated delivery is one the client (or a routine) marked so the
 * backbone drives its @mention chain. Absent the flag, behaviour is unchanged —
 * the client keeps orchestrating, exactly as before.
 */
export function isServerOrchestrated(task) {
  if (!task || typeof task !== "object") return false;
  if (task.serverOrchestrate === false) return false;
  return Boolean(task.serverOrchestrate);
}

function toHandle(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normHandle(value) {
  return toHandle(String(value || "").replace(/^@/, "").replace(/_/g, "-"));
}

/** Handles an answer may use for one agent (roster slug, name, last token). */
function agentHandleForms(a) {
  const forms = new Set();
  const add = (v) => {
    const h = normHandle(v);
    if (h) forms.add(h);
  };
  add(a && a.handle);
  add(a && a.name);
  const name = String((a && a.name) || "").trim();
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length >= 3);
  for (const p of parts) forms.add(p);
  for (const h of [...forms]) {
    const last = h.split("-").filter(Boolean).pop();
    if (last && last.length >= 3) forms.add(last);
  }
  return forms;
}

function spaceIdOf(task) {
  return String((task && (task.spaceId || task.storeId || task.space_id)) || "").trim();
}

/**
 * Signal one creature and await its reply, mirroring the creature-to-creature
 * dance in scheduleRoutine.mjs: a `StoresSend` on `creatures/signal` whose
 * result the target dual-emits on `creatures/signal` so this docker creature can
 * read it. Returns the parsed reply object, or null on timeout.
 */
/**
 * Fire a creature→creature action at `endpoint` and return without waiting for a
 * reply. A docker creature cannot reliably read a creature→creature reply (the
 * node's machine listener only ever hands it `creatures/signal`, and a WASM
 * endpoint's `signalResult` lands on `creatures/signal/result`), so orchestration
 * never depends on the reply — the effect is read back from the store instead
 * (the committed quote doc / the ledger). This just triggers the WASM creature to
 * run, exactly the way scheduleRoutine.mjs triggers routines/manage.
 */
async function sendCreatureSignal(bridge, endpoint, { action, payload }, { spaceId } = {}) {
  if (!bridge || !endpoint) return false;
  const correlationId = crypto.randomBytes(16).toString("hex");
  const selfId = String(bridge.programId || bridge.machineId || "");
  const inner = JSON.stringify({ action, correlationId, payload });
  const packet = {
    action: "single",
    user: { id: selfId },
    store: { id: spaceId || "" },
    data: JSON.stringify({ programId: endpoint.programId, entity: endpoint.entityId, payload: inner }),
    entityId: endpoint.entityId,
    correlationId,
  };
  try {
    await bridge.signalUser("creatures/signal", endpoint.programId, packet);
    return true;
  } catch {
    return false;
  }
}

/**
 * The deterministic quote id the billing creature mints for (payer, requestId):
 * sha256 of each part followed by a NUL byte (mirrors the creature's
 * `billingHash`). Because it is deterministic, the backbone can read the
 * committed quote doc straight from the store instead of awaiting a reply.
 */
function billingQuoteId(payer, requestId) {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from(String(payer), "utf8"));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(String(requestId), "utf8"));
  h.update(Buffer.from([0]));
  return h.digest("hex");
}

/**
 * Poll for the committed quote doc at `Json::BillingQuote::<quoteId>` and return
 * it once it is bound to this exact run. Returns null on timeout — a delegated
 * quote that is REJECTED (budget reached, unauthorized) never writes a doc, so a
 * miss here is the "do not launch" signal.
 */
async function readCommittedQuote(bridge, { quoteId, payer, requestId, resourceId, spaceId }, options = {}) {
  const attempts = options.attempts ?? Math.max(1, Number(process.env.DELEGATED_QUOTE_ATTEMPTS) || 30);
  const intervalMs = options.intervalMs ?? Math.max(5, Number(process.env.DELEGATED_QUOTE_INTERVAL_MS) || 200);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await bridge.call("getJson", { key: `Json::BillingQuote::${quoteId}`, path: "quote" });
      const q = res && res.data && typeof res.data === "object" && !Array.isArray(res.data) ? res.data : null;
      if (
        q &&
        String(q.quoteId) === quoteId &&
        String(q.payerUserId) === String(payer) &&
        String(q.requestId) === String(requestId) &&
        String(q.resourceId) === String(resourceId) &&
        String(q.projectId || "") === String(spaceId)
      ) {
        return q;
      }
    } catch {
      /* transient read error — retry */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * The payer's one shared authorization pool, resolved by the node's
 * `FinancePoolByUser` link. A delegated run reuses it (it is opened + funded by
 * the client on the user's first run and lives for weeks); this never opens or
 * funds a pool, so a delegated run can only ever draw funds the user has already
 * pooled. Returns "" when the user has no open pool (then no autonomous run can
 * proceed — correct: there is nothing to bill).
 */
export async function resolvePoolId(bridge, payer) {
  if (!bridge || !payer) return "";
  try {
    const linked = await bridge.call("getLink", { key: `FinancePoolByUser::${payer}` });
    let poolId = "";
    if (typeof linked === "string") poolId = linked;
    else if (linked && typeof linked === "object") {
      poolId = String(linked.value || linked.data || linked.link || linked.id || "");
    }
    poolId = poolId.trim();
    if (!poolId) return "";
    const pool = await bridge.call("getJson", { key: `Json::FinancePool::${poolId}`, path: "pool" });
    const p = pool && pool.data && typeof pool.data === "object" ? pool.data : null;
    if (!p || p.status !== "open" || String(p.payerUserId || "") !== String(payer)) return "";
    return poolId;
  } catch {
    return "";
  }
}

/**
 * Mint a delegated agent quote for `payer` against `proxyProgramId`, bound to
 * `correlationId`. The billing creature only honours a delegated payer when the
 * requester IS the resource's settlement meter — which this backbone is — and
 * enforces the project's autonomous budget. Returns the quoteId or "".
 */
async function mintDelegatedQuote(bridge, { billingEndpoint, payer, proxyProgramId, spaceId, correlationId }) {
  const quoteId = billingQuoteId(payer, correlationId);
  // Trigger the billing creature to mint + commit the quote, then read the
  // committed doc directly — never depend on the (unreliable for a container)
  // reply. A quote the creature REJECTS (budget/auth) writes no doc, so a null
  // read is the correct "do not launch this teammate" outcome.
  const sent = await sendCreatureSignal(
    bridge,
    billingEndpoint,
    {
      action: "quote",
      payload: {
        requestId: correlationId,
        kind: "agent",
        resourceId: proxyProgramId,
        projectId: spaceId,
        payerUserId: payer,
      },
    },
    { spaceId },
  );
  if (!sent) {
    log("GROK_ORCH", { quote: "signal-failed", proxyProgramId, spaceId });
    return "";
  }
  const quote = await readCommittedQuote(bridge, {
    quoteId,
    payer,
    requestId: correlationId,
    resourceId: proxyProgramId,
    spaceId,
  });
  if (!quote) {
    log("GROK_ORCH", { quote: "not-committed", proxyProgramId, spaceId, note: "rejected or timed out" });
    return "";
  }
  return quoteId;
}

export async function buildDelegatedAuthorization(bridge, { billingEndpoint, payer, poolId, proxyProgramId, spaceId, correlationId }) {
  if (!billingEndpoint || !payer || !poolId || !proxyProgramId || !spaceId || !correlationId) return null;
  const quoteId = await mintDelegatedQuote(bridge, { billingEndpoint, payer, proxyProgramId, spaceId, correlationId });
  if (!quoteId) return null;
  return { poolId, payerUserId: payer, quoteId };
}

/**
 * The space's agents (proxy address + display name/handle), merged from the
 * roster the caller supplied (which may carry richer handles) and the on-chain
 * program index (authoritative for proxy addresses — and the only source when a
 * routine fires with no client-supplied roster). Tools/sandbox are excluded:
 * only agents are teammates.
 */
async function agentAddressBook(bridge, spaceId, roster) {
  const byProgram = new Map();
  const put = (a) => {
    const programId = String(a.programId || "").trim();
    if (!programId) return;
    const prev = byProgram.get(programId) || {};
    // The launch must target the agent's PROXY entity ("agent") so the node
    // injects the agent's skill/LLM config and forwards to the backbone. A stored
    // "main"/empty (a non-proxy default) is corrected to "agent".
    let entityId = String(a.entityId || prev.entityId || "").trim();
    if (!entityId || entityId === "main") entityId = "agent";
    byProgram.set(programId, {
      programId,
      creatureId: String(a.creatureId || prev.creatureId || "").trim(),
      entityId,
      resourceId: String(a.resourceId || prev.resourceId || programId).trim(),
      name: String(a.name || prev.name || "").trim(),
      handle: String(a.handle || prev.handle || toHandle(a.name || prev.name)).trim(),
    });
  };
  try {
    const res = await bridge.call("getJson", { key: `Json::StoreProgramIndex::${spaceId}`, path: "" });
    const data = res && res.data && typeof res.data === "object" ? res.data : {};
    for (const [pid, raw] of Object.entries(data)) {
      const rec = raw && typeof raw === "object" ? raw : {};
      const meta = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
      const desc = meta.descriptor && typeof meta.descriptor === "object" ? meta.descriptor : {};
      const kind = String(meta.kind || meta.type || desc.kind || "").toLowerCase();
      if (kind === "tool" || kind === "sandbox") continue;
      put({
        programId: rec.programId || pid,
        creatureId: rec.creatureId || meta.creatureId,
        entityId: rec.entityId || meta.entityId || "agent",
        resourceId: meta.resourceId || rec.programId || pid,
        name: meta.name || meta.title || desc.name || rec.name,
        // The @handle chat shows is the listing's `username` — an agent writes
        // "@lead", not "@orbit-lead". The index stores it on the descriptor, so
        // read it here: a run that arrives with no roster (a routine firing, a
        // teammate launched after the client dropped) must still resolve the
        // handles its teammates are addressed by, not just their display names.
        handle: meta.handle || meta.username || desc.username || desc.handle,
      });
    }
  } catch (err) {
    log("GROK_ORCH", { roster_index_error: String(err?.message || err).slice(0, 160) });
  }
  // Overlay the caller's roster: it carries the handles the answer was written
  // against and any proxy address the client already resolved.
  for (const r of Array.isArray(roster) ? roster : []) {
    if (!r || typeof r !== "object") continue;
    if (r.kind && r.kind !== "agent") continue;
    const programId = String(r.programId || r.id || "").trim();
    if (!programId) continue;
    put({
      programId,
      creatureId: r.creatureId,
      entityId: r.entityId || "agent",
      resourceId: r.resourceId || r.id || programId,
      name: r.name,
      handle: r.handle,
    });
  }
  return [...byProgram.values()];
}

/** The @handles an answer mentions, in document order, lowercased (no leading @). */
export function parseAnswerMentionsOrdered(answer) {
  const out = [];
  const seen = new Set();
  const re = /(^|[^a-z0-9_-])@([a-z0-9][a-z0-9_-]*)/gi;
  let m;
  while ((m = re.exec(String(answer || "")))) {
    const h = m[2].toLowerCase();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

/** The distinct @handles an answer mentions, lowercased (no leading @). */
function parseAnswerMentions(answer) {
  return new Set(parseAnswerMentionsOrdered(answer));
}

/**
 * True when the answer is sequencing teammates (B needs A first) rather than
 * launching independent work in parallel. Independent mentions stay parallel.
 */
export function isSequentialHandoff(answer) {
  const text = String(answer || "");
  if (!text.trim()) return false;
  if (/\bthen\s+@[a-z0-9]/i.test(text)) return true;
  if (/\bafter(?:wards)?(?:\s+that)?\s+@[a-z0-9]/i.test(text)) return true;
  if (/\bfirst\s+@[a-z0-9]/i.test(text)) return true;
  if (/\bonce\s+@[a-z0-9]/i.test(text)) return true;
  if (/\b(?:wait for|blocked on|depends on|needs)\s+@[a-z0-9]/i.test(text)) return true;
  if (/@[a-z0-9][a-z0-9_-]*[\s\S]{0,140}\bthen\b[\s\S]{0,80}@[a-z0-9]/i.test(text)) return true;
  const numbered = (text.match(/\d+[\.)]\s*@[a-z0-9]/gi) || []).length;
  if (numbered >= 2) return true;
  return false;
}

/** Which agents in `agents` did `answer` @mention (excluding self / visited)?
 * Matching is robust: an agent matches if a mention equals its roster handle OR
 * its name slug (the two can differ when the roster didn't reach the backbone
 * and the handle was derived from the program-index name). Only a handle/name +
 * program id are required — the launch signals the proxy by program id + entity,
 * so a missing creatureId must NOT drop a teammate. */
function mentionExactHit(a, mention) {
  const m = normHandle(mention);
  if (!m) return false;
  return normHandle(a.handle) === m || toHandle(a.name) === m;
}

/**
 * Resolve an answer's @mentions to the teammates to launch.
 *
 * Every mention is tried against EVERY agent it could name, not just the first
 * row that matches: a mention whose best match is blocked (it is the agent that
 * wrote the answer, or it is already launched in this wave) falls through to the
 * next agent that answers to the same handle instead of being dropped.
 *
 * The outcome is reported per mention so the chain can say what actually
 * happened: `unknown` (no agent in this space answers to that handle),
 * `capped` (that agent already took its turns on this branch), `selfOnly` (the
 * answer named its own author) — the three used to collapse into one misleading
 * "no teammate matched".
 */
function mentionedTeammates(answer, agents, { visited, selfProgram, maxHops } = {}) {
  const mentions = parseAnswerMentionsOrdered(answer);
  const nothing = { teammates: [], capped: [], selfOnly: [], unknown: [], deferred: [], serial: false, visitCap: visitCapFor(maxHops) };
  if (!mentions.length) return nothing;
  const visitCap = visitCapFor(maxHops);
  const visitedList = Array.isArray(visited) ? visited.map(String) : [...(visited || [])].map(String);
  const visitCount = (id) => visitedList.filter((v) => v === id).length;
  const out = [];
  const seen = new Set();
  const capped = [];
  const selfOnly = [];
  const resolved = new Set();
  const take = (a) => {
    if (!a.programId || a.programId === selfProgram || seen.has(a.programId)) return false;
    if (visitCount(a.programId) >= visitCap) {
      if (!capped.some((x) => x.programId === a.programId)) capped.push(a);
      return false;
    }
    seen.add(a.programId);
    out.push(a);
    return true;
  };
  /** Launch the first agent this mention names that can still take the work. */
  const claim = (mention, rows) => {
    if (!rows.length) return false;
    const m = normHandle(mention);
    resolved.add(m);
    for (const row of rows) if (take(row)) return true;
    if (rows.every((row) => row.programId === selfProgram) && !selfOnly.includes(m)) selfOnly.push(m);
    return false;
  };
  // Exact handles first, for every mention, so a loose name-token match can
  // never steal the agent another mention names outright.
  const used = new Set();
  for (const mention of mentions) {
    if (claim(mention, agents.filter((row) => mentionExactHit(row, mention)))) used.add(normHandle(mention));
  }
  for (const mention of mentions) {
    const m = normHandle(mention);
    if (used.has(m)) continue;
    if (claim(mention, agents.filter((row) => agentHandleForms(row).has(m)))) used.add(m);
  }
  const unknown = [];
  for (const mention of mentions) {
    const m = normHandle(mention);
    if (!resolved.has(m) && !unknown.includes(m)) unknown.push(m);
  }
  // "@a, then @b" is one agent's work followed by another's: launch only the
  // unblocked one — @b runs when @a hands off. Independent mentions stay parallel.
  const serial = isSequentialHandoff(answer) && out.length > 1;
  return {
    teammates: serial ? out.slice(0, 1) : out,
    deferred: serial ? out.slice(1) : [],
    capped,
    selfOnly,
    unknown,
    serial,
    visitCap,
  };
}

/** Signal a teammate's proxy to run one turn; the proxy injects its skill/LLM
 * config and forwards to this backbone, where it re-enters as a delivery. */
async function signalProxyRun(bridge, teammate, task, { spaceId, correlationId, streamTo }) {
  const packet = {
    action: "single",
    user: { id: String(streamTo || bridge.programId || "") },
    store: { id: spaceId },
    data: JSON.stringify({
      programId: teammate.programId,
      entity: teammate.entityId || "agent",
      payload: JSON.stringify(task),
    }),
    entityId: teammate.entityId || "agent",
    correlationId,
  };
  await bridge.signalUser("creatures/signal", teammate.programId, packet);
}

/** Fields carried forward unchanged onto every hand-off in the chain. */
function forwardContext(task) {
  const out = {};
  for (const k of [
    "billingEndpoint",
    "adminEndpoint",
    "routinesEndpoint",
    "schedulerProgramId",
    "projectBrief",
    "brief",
    "roster",
  ]) {
    if (task[k] !== undefined) out[k] = task[k];
  }
  return out;
}

/**
 * Start one run per teammate: a delegated quote each, then their proxy signalled
 * with the work. Shared by the two ways an agent hands work over — the @mentions
 * in its final answer (`planAndLaunchFollowups`) and the @mentions in a message
 * it sends mid-run (`handOffMentions`, the `send_message` tool) — so both cost a
 * hop, both draw on the same autonomous budget, and both land on the receiving
 * agent's task board rather than starting a second instance of it.
 *
 * Returns `{ launched, blocked }`: `blocked` are the teammates whose delegated
 * quote was refused or whose proxy could not be reached, which the caller reports
 * rather than dropping in silence.
 */
export async function launchTeammates(
  bridge,
  { task, teammates, spaceId, threadId, prompt, payer, poolId, billingEndpoint, depth, maxHops, visitedList },
) {
  const base = forwardContext(task || {});
  const visited = Array.isArray(visitedList) ? visitedList : [];
  let launched = 0;
  const blocked = [];
  for (const teammate of teammates || []) {
    const correlationId = crypto.randomBytes(16).toString("hex");
    const auth = await buildDelegatedAuthorization(bridge, {
      billingEndpoint,
      payer,
      poolId,
      proxyProgramId: teammate.programId,
      spaceId,
      correlationId,
    });
    if (!auth) {
      // Budget reached or quote failed: stop expanding down this teammate rather
      // than spend past the cap. The answer that named them is already persisted.
      log("GROK_ORCH", { skip_teammate: teammate.programId, reason: "no-delegated-quote" });
      blocked.push(teammate);
      continue;
    }
    const childTask = {
      ...base,
      prompt,
      objective: prompt,
      streamTo: payer,
      spaceId,
      groupChat: true,
      threadId,
      proxyProgramId: teammate.programId,
      agentProgramId: teammate.programId,
      agentCreatureId: teammate.creatureId,
      targetAgentId: teammate.resourceId,
      self: { id: teammate.resourceId, name: teammate.name, handle: teammate.handle, programId: teammate.programId },
      mentions: [{ programId: teammate.programId, name: teammate.name, handle: teammate.handle, kind: "agent" }],
      billingAuthorization: auth,
      autonomousQuote: true,
      correlationId,
      serverOrchestrate: true,
      // Attribution for the receiving agent's task board: a hand-off should read
      // as "from <the agent that asked>", not as an anonymous autonomous run.
      taskOrigin: "agent",
      ...(task && task.self && task.self.name ? { requestedByName: String(task.self.name) } : {}),
      // Only mark THIS teammate visited on their branch. Pre-claiming every
      // sibling blocked later hand-offs ("@builder please wire the tracking
      // the researcher just found") even when handles matched.
      orchestration: {
        depth: Number(depth || 0) + 1,
        maxHops,
        visited: [...visited, teammate.programId],
        poolId,
        payerUserId: payer,
      },
    };
    try {
      await signalProxyRun(bridge, teammate, childTask, { spaceId, correlationId, streamTo: payer });
      launched += 1;
    } catch (err) {
      log("GROK_ORCH", { launch_error: teammate.programId, error: String(err?.message || err).slice(0, 160) });
      blocked.push(teammate);
    }
  }
  if (launched) log("GROK_ORCH", { launched, depth: Number(depth || 0) + 1, spaceId, threadId });
  return { launched, blocked };
}

/**
 * The billing context a hand-off needs: who pays, out of which pool, through
 * which billing creature. Returns null when any of the three is missing — with
 * no way to bill an unattended run there is nothing to launch.
 */
export async function handOffContext(bridge, task) {
  const orch = task && typeof task.orchestration === "object" && task.orchestration ? task.orchestration : {};
  const payer = String(orch.payerUserId || (task && task.streamTo) || "");
  const billingEndpoint = billingEndpointFromTask(task);
  if (!payer || !billingEndpoint) return null;
  const poolId = String(orch.poolId || "") || (await resolvePoolId(bridge, payer));
  if (!poolId) return null;
  return { payer, poolId, billingEndpoint, orch };
}

/**
 * Hand work to whoever `text` @mentions, WITHOUT ending this agent's turn.
 *
 * This is what makes an agent's mid-run message a real hand-off rather than a
 * note in the chat: the same launch path an answer's mentions take, so the
 * teammate's task lands on its board and it starts when it is free. Returns
 * `{ launched, blocked, unknown }` for the tool to report back to the model —
 * an agent that mistyped a handle should be told, not left assuming.
 */
export async function handOffMentions(bridge, task, text, options = {}) {
  const nothing = { launched: [], blocked: [], unknown: [] };
  if (!bridge || !task) return nothing;
  const spaceId = spaceIdOf(task);
  if (!spaceId) return nothing;
  const mentioned = parseAnswerMentionsOrdered(text);
  if (!mentioned.length) return nothing;

  const orchIn = task.orchestration && typeof task.orchestration === "object" ? task.orchestration : {};
  const depth = Number(orchIn.depth || 0);
  const maxHops = Number(orchIn.maxHops || DEFAULT_MAX_HOPS);
  if (depth + 1 >= maxHops) {
    return { ...nothing, hopCapped: true };
  }
  const context = await handOffContext(bridge, task);
  if (!context) return { ...nothing, noBilling: true };

  const visitedList = (Array.isArray(orchIn.visited) ? orchIn.visited : []).map(String);
  const selfProgram = String(task.proxyProgramId || task.agentProgramId || (task.self && task.self.programId) || "");
  if (selfProgram && !visitedList.includes(selfProgram)) visitedList.push(selfProgram);

  const agents = await agentAddressBook(bridge, spaceId, task.roster);
  const { teammates, unknown } = mentionedTeammates(text, agents, { visited: visitedList, selfProgram, maxHops });
  if (!teammates.length) return { ...nothing, unknown };

  const { launched, blocked } = await launchTeammates(bridge, {
    task,
    teammates,
    spaceId,
    threadId: String(task.threadId || "main") || "main",
    // The teammate is answering the message that named it, not this agent's
    // eventual final answer — which has not been written yet.
    prompt: String(options.prompt || text || ""),
    payer: context.payer,
    poolId: context.poolId,
    billingEndpoint: context.billingEndpoint,
    depth,
    maxHops,
    visitedList,
  });
  const blockedIds = new Set(blocked.map((t) => t.programId));
  return {
    launched: teammates.filter((t) => !blockedIds.has(t.programId)),
    blocked,
    unknown,
    count: launched,
  };
}

/**
 * After a server-orchestrated run finishes, launch every teammate its answer
 * @mentioned. Each teammate gets a fresh correlation, a delegated quote, and the
 * advanced orchestration state (visited set + hop depth) so the chain cannot
 * loop or double-launch an agent. Returns the number launched.
 */
export async function planAndLaunchFollowups(bridge, delivery, result) {
  const task = (delivery && delivery.task) || {};
  if (!bridge) return 0;
  const answer = result && typeof result.answer === "string" ? result.answer : "";
  const hasMention = /(^|[^a-z0-9-])@[a-z0-9-]+/i.test(answer);
  if (!isServerOrchestrated(task)) {
    log("GROK_ORCH", { followups: "not-orchestrated", serverOrchestrate: task.serverOrchestrate ?? null });
    // The answer named teammates but this run never carried serverOrchestrate —
    // almost always a stale client/backbone that isn't sending the flag yet.
    if (hasMention && result && result.success !== false) {
      await noteStall(bridge, task, "this run wasn't marked for server orchestration (serverOrchestrate absent). Redeploy the client and the davinci backbone so runs carry it.");
    }
    return 0;
  }
  if (!result || result.success === false || result.pausedForFunds) {
    log("GROK_ORCH", { followups: "run-not-ok", success: result ? result.success : null, paused: Boolean(result && result.pausedForFunds) });
    return 0;
  }
  if (!answer.trim()) {
    log("GROK_ORCH", { followups: "empty-answer" });
    return 0;
  }
  const spaceId = spaceIdOf(task);
  if (!spaceId) {
    log("GROK_ORCH", { followups: "no-space" });
    return 0;
  }

  const orch = task.orchestration && typeof task.orchestration === "object" ? task.orchestration : {};
  const depth = Number(orch.depth || 0);
  const maxHops = Number(orch.maxHops || DEFAULT_MAX_HOPS);

  // The @handles this answer actually mentioned, minus the ones that name a
  // PERSON in the roster (a human @mention is not a fan-out target, so it must
  // not read as a stall). What remains is the set of agent-directed mentions
  // used both for diagnostics and to decide whether a stall is worth flagging.
  const personHandles = new Set(
    (Array.isArray(task.roster) ? task.roster : [])
      .filter((r) => r && (r.kind === "user" || r.kind === "person"))
      .flatMap((r) => [r.handle, toHandle(r.name)])
      .filter((v) => v && typeof v === "string")
      .map((v) => v.toLowerCase()),
  );
  const answerHandles = [...parseAnswerMentions(answer)].filter((h) => !personHandles.has(h));

  // The hop budget is the chain's loop guard, so it is also the one place the
  // chain ends while an answer is still asking for someone: say so in the trail
  // instead of stopping in silence.
  if (depth + 1 >= maxHops) {
    log("GROK_ORCH", { followups: "hop-cap", depth, maxHops, answerMentions: answerHandles });
    if (answerHandles.length) {
      await noteStall(
        bridge,
        task,
        `this chain reached its ${maxHops}-hop limit, so ${answerHandles.map((h) => "@" + h).join(", ")} weren't started. Send a new message to carry the work on.`,
      );
    }
    return 0;
  }
  const visitedList = (Array.isArray(orch.visited) ? orch.visited : []).map(String);
  const selfProgram = String(task.proxyProgramId || task.agentProgramId || (task.self && task.self.programId) || "");
  if (selfProgram && !visitedList.includes(selfProgram)) visitedList.push(selfProgram);

  const payer = String(orch.payerUserId || task.streamTo || "");
  let poolId = String(orch.poolId || "");
  if (!poolId) poolId = await resolvePoolId(bridge, payer);
  const billingEndpoint = billingEndpointFromTask(task);
  if (!payer || !poolId || !billingEndpoint) {
    log("GROK_ORCH", { followups: "no-billing-context", payer: Boolean(payer), poolId: Boolean(poolId), billingEndpoint: Boolean(billingEndpoint) });
    if (answerHandles.length) {
      await noteStall(
        bridge,
        task,
        `billing context missing (payer:${Boolean(payer)} pool:${Boolean(poolId)} billingEndpoint:${Boolean(billingEndpoint)}).`,
      );
    }
    return 0;
  }

  const agents = await agentAddressBook(bridge, spaceId, task.roster);
  const { teammates, capped, selfOnly, unknown, deferred, serial, visitCap } = mentionedTeammates(answer, agents, {
    visited: visitedList,
    selfProgram,
    maxHops,
  });
  if (!teammates.length) {
    const known = agents.map((a) => a.handle).filter(Boolean);
    log("GROK_ORCH", {
      followups: "no-teammates",
      agents: known,
      capped: capped.map((a) => a.handle),
      selfOnly,
      unknown,
      rosterSize: Array.isArray(task.roster) ? task.roster.length : 0,
      answerMentions: answerHandles,
    });
    if (answerHandles.length) {
      // Say which of the three actually happened. Collapsing them into "no
      // teammate matched" sent people hunting for a handle typo when the handle
      // was fine and the chain had simply vetoed the agent.
      const reasons = [];
      if (capped.length) {
        reasons.push(
          `${capped.map((a) => "@" + a.handle).join(", ")} already took ${visitCap} turn${visitCap === 1 ? "" : "s"} in this chain`,
        );
      }
      if (selfOnly.length) {
        reasons.push(`${selfOnly.map((h) => "@" + h).join(", ")} names the agent that wrote this answer`);
      }
      const stillUnknown = unknown.filter((h) => !personHandles.has(h));
      if (stillUnknown.length) {
        reasons.push(
          `no agent in this project answers to ${stillUnknown.map((h) => "@" + h).join(", ")} (known agents: ${known.length ? known.map((h) => "@" + h).join(", ") : "none resolved"})`,
        );
      }
      await noteStall(
        bridge,
        task,
        reasons.length
          ? `${reasons.join("; ")}.`
          : `no teammate matched. Mentioned: ${answerHandles.map((h) => "@" + h).join(", ")}. Known agents: ${known.length ? known.map((h) => "@" + h).join(", ") : "(none resolved)"}.`,
      );
    }
    return 0;
  }

  if (serial) {
    log("GROK_ORCH", { followups: "serial-first", handle: teammates[0]?.handle, deferred: deferred.map((a) => a.handle) });
    // A deferred teammate is waiting on the one that just started, not lost —
    // but nothing else would ever say so, so record it in the run's trail.
    if (deferred.length) {
      await noteChain(
        bridge,
        task,
        `⏳ ${deferred.map((a) => "@" + a.handle).join(", ")} wait${deferred.length === 1 ? "s" : ""} on @${teammates[0]?.handle || "the first teammate"} — this answer sequenced them.`,
        "orch-deferred",
      );
    }
  }

  const threadId = String(task.threadId || "main") || "main";
  const { launched, blocked } = await launchTeammates(bridge, {
    task,
    teammates,
    spaceId,
    threadId,
    prompt: answer,
    payer,
    poolId,
    billingEndpoint,
    depth,
    maxHops,
    visitedList,
  });
  // Every teammate this answer named either started or is accounted for here —
  // a hand-off that quietly went nowhere is the failure this whole module exists
  // to make impossible to miss.
  if (blocked.length) {
    await noteStall(
      bridge,
      task,
      `couldn't authorize a delegated run for ${blocked.map((t) => "@" + t.handle).join(", ")} (budget reached, no open pool, or billing rejected). Check the project's autonomous budget and that the wallet has a funded pool.`,
    );
  }
  return launched;
}

/**
 * A server-orchestrated delivery that arrived without a billing authorization —
 * a routine firing with no client to mint one — needs a delegated quote built
 * before it can run. Mutates `delivery.task` in place; returns true on success.
 */
export async function ensureDelegatedAuthorization(bridge, delivery) {
  const task = (delivery && delivery.task) || {};
  if (!bridge || !isServerOrchestrated(task)) return true;
  if (task.billingAuthorization && typeof task.billingAuthorization === "object") return true;
  const spaceId = spaceIdOf(task);
  const proxyProgramId = String(task.proxyProgramId || task.agentProgramId || (task.self && task.self.programId) || "");
  const payer = String((task.orchestration && task.orchestration.payerUserId) || task.streamTo || task.ownerUserId || "");
  const correlationId = String(delivery.correlationId || task.correlationId || "");
  const billingEndpoint = billingEndpointFromTask(task);
  if (!spaceId || !proxyProgramId || !payer || !correlationId || !billingEndpoint) {
    log("GROK_ORCH", { ensure_auth: "missing-context", spaceId: Boolean(spaceId), proxyProgramId: Boolean(proxyProgramId), payer: Boolean(payer) });
    return false;
  }
  const poolId = String((task.orchestration && task.orchestration.poolId) || "") || (await resolvePoolId(bridge, payer));
  if (!poolId) {
    log("GROK_ORCH", { ensure_auth: "no-pool", payer });
    return false;
  }
  const auth = await buildDelegatedAuthorization(bridge, {
    billingEndpoint,
    payer,
    poolId,
    proxyProgramId,
    spaceId,
    correlationId,
  });
  if (!auth) return false;
  task.billingAuthorization = auth;
  task.autonomousQuote = true;
  const orch = task.orchestration && typeof task.orchestration === "object" ? { ...task.orchestration } : {};
  orch.poolId = poolId;
  orch.payerUserId = payer;
  if (orch.depth === undefined) orch.depth = 0;
  task.orchestration = orch;
  return true;
}

/**
 * Record a delegated run's actual charge against the project's autonomous
 * budget and release its reservation. Only runs whose quote the backbone minted
 * (`autonomousQuote`) touch the ledger — a user-initiated seed keeps its own
 * client quote and must not count as autonomous spend. Best-effort.
 */
export async function settleAutonomousSpend(bridge, delivery, result) {
  const task = (delivery && delivery.task) || {};
  if (!bridge || !task.autonomousQuote) return;
  const auth = task.billingAuthorization;
  const quoteId = auth && typeof auth === "object" ? String(auth.quoteId || "") : "";
  const spaceId = spaceIdOf(task);
  const billingEndpoint = billingEndpointFromTask(task);
  if (!quoteId || !spaceId || !billingEndpoint) return;
  const charged = Math.max(0, Number((result && result.chargedMinor) || 0) || 0);
  // Fire-and-forget: recording spend must not block the chain, and a miss only
  // leaves the reservation to be swept at its expiry. The ledger write is the
  // effect; there is nothing to read back.
  await sendCreatureSignal(
    bridge,
    billingEndpoint,
    { action: "settleAutonomous", payload: { spaceId, quoteId, chargedMinor: charged } },
    { spaceId },
  );
}

function adminEndpointFromTask(task) {
  return endpointFrom(task && (task.adminEndpoint || task.admin_endpoint));
}

/**
 * Record a backbone-launched (autonomousQuote) run in the shared work log the
 * same way the client records its own runs — so the app's Status shows the
 * teammate/routine agents actually working, instead of "no agents working",
 * while the backbone drives the chain server-side. Only backbone-launched runs
 * are recorded here (the client already records the seed it started).
 * Fire-and-forget; visibility must never block or fail a run.
 */
export async function recordServerRun(bridge, delivery, fields = {}) {
  const task = (delivery && delivery.task) || {};
  if (!bridge || !task.autonomousQuote) return;
  const endpoint = adminEndpointFromTask(task);
  const spaceId = spaceIdOf(task);
  const correlationId = String((delivery && delivery.correlationId) || task.correlationId || "");
  if (!endpoint || !spaceId || !correlationId) return;
  const self = task.self && typeof task.self === "object" ? task.self : {};
  try {
    await sendCreatureSignal(
      bridge,
      endpoint,
      {
        action: "recordRun",
        payload: {
          correlationId,
          spaceId,
          agentProgramId: String(task.proxyProgramId || task.agentProgramId || self.programId || ""),
          agentName: String(self.name || task.agentName || ""),
          updatedAt: Date.now(),
          ...fields,
        },
      },
      { spaceId },
    );
  } catch {
    /* visibility is best-effort */
  }
}
