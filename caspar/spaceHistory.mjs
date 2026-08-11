/**
 * Fetching the space's group-chat transcript — creature → creature.
 *
 * A Decillion space is a shared group chat, and its transcript lives on-chain in
 * the space store, owned by the decillion `spaces/history` creature (written by
 * `spaces/signal` with `persist:true`). The prompting client no longer ships the
 * transcript in the task; it passes only the *address* of that creature
 * (`task.historyEndpoint`, resolved from the manifest). This backbone — the
 * creature that "handles prompts and messages to the agents" — fetches the
 * history itself before building the prompt, by signalling `spaces/history` and
 * awaiting its reply.
 *
 * How the round trip works (and why it is shaped the way it is):
 *
 *   • The `spaces/*` endpoints are WASM creatures that peel Nest's
 *     `/creatures/signal` envelope with a shared `unwrapSignal`. The node's pvp
 *     signal handler builds a `StoresSend` value and hands it to `signal_user`;
 *     the WASM `run` receives that value serialised. So to invoke the endpoint we
 *     reproduce the *same* `StoresSend` shape and push it with `signalUser` — an
 *     identical delivery to what the app's shell request produces.
 *       data = JSON.stringify({ programId, entity,
 *                payload: JSON.stringify({ action:"history", correlationId,
 *                                         payload:{ storeId } }) })
 *
 *   • The reply. A WASM endpoint answers via `signalResult`, which emits on
 *     `creatures/signal/result`. But a docker creature (this backbone) only ever
 *     receives signals on `creatures/signal` — the node's machine listener drops
 *     every other key for a connected container. So `spaces/history` *also*
 *     emits its result on `creatures/signal` (see the decillion server's
 *     `SPACES["history"]`); that is the copy we listen for here, matched by
 *     `correlationId`.
 *
 * The reply target is this creature's own machine id (`selfId`): `signalResult`
 * addresses `p.RequesterID`, which is the `user.id` we stamp on the request, and
 * that id must be the one the node has this container registered under — the same
 * id `ToolInvoker` uses as `reply_to`.
 */

import crypto from "node:crypto";

import { creatureNumber } from "./env.mjs";

const HISTORY_FETCH_TIMEOUT_MS = creatureNumber("HISTORY_FETCH_TIMEOUT_MS", 8000);
const MAX_TURN_CHARS = creatureNumber("HISTORY_TURN_CHARS", 4000);

/**
 * The `spaces/history` endpoint address the client put on the task, normalised.
 * Returns `null` when the task carries none (no space, or an older client) — the
 * caller then simply runs without fetched history.
 */
export function historyEndpointFromTask(task) {
  const raw = task && typeof task === "object" ? task.historyEndpoint || task.history_endpoint : null;
  if (!raw || typeof raw !== "object") return null;
  const programId = String(raw.programId || raw.program_id || "").trim();
  if (!programId) return null;
  const entityId = String(raw.entityId || raw.entity_id || "main").trim() || "main";
  return {
    programId,
    creatureId: String(raw.creatureId || raw.creature_id || "").trim(),
    entityId,
  };
}

/**
 * Signal `spaces/history` and resolve with its raw persisted records (or `[]`).
 * Never throws — a failed or slow fetch just yields no history, so the run
 * proceeds rather than dying on a history hiccup.
 */
export async function fetchSpaceHistoryRecords(
  bridge,
  { endpoint, spaceId, selfId, timeoutMs = HISTORY_FETCH_TIMEOUT_MS },
) {
  if (!bridge || !endpoint || !spaceId) return [];
  const correlationId = crypto.randomBytes(16).toString("hex");
  const inner = JSON.stringify({
    action: "history",
    correlationId,
    payload: { storeId: spaceId },
  });
  const packet = {
    action: "single",
    user: { id: String(selfId || "") },
    store: { id: spaceId },
    data: JSON.stringify({ programId: endpoint.programId, entity: endpoint.entityId, payload: inner }),
    entityId: endpoint.entityId,
    correlationId,
  };

  let unsub = null;
  const settled = new Promise((resolve) => {
    unsub = bridge.onSignal((key, raw) => {
      if (key !== "creatures/signal" && key !== "creatures/signal/result") return;
      // The reply may arrive as the result object itself, or wrapped in a
      // StoresSend whose `data` is the object's JSON string.
      let pkt = raw;
      if (pkt && typeof pkt === "object" && typeof pkt.data === "string") {
        try {
          pkt = JSON.parse(pkt.data);
        } catch {
          return;
        }
      }
      if (!pkt || typeof pkt !== "object") return;
      if (String(pkt.correlationId || "") !== correlationId) return;
      if (!Array.isArray(pkt.history)) return;
      resolve(pkt.history);
    });
  });

  try {
    await bridge.signalUser("creatures/signal", endpoint.programId, packet);
  } catch {
    if (unsub) unsub();
    return [];
  }

  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const records = await Promise.race([settled, timedOut]);
    return Array.isArray(records) ? records : [];
  } finally {
    clearTimeout(timer);
    if (unsub) unsub();
  }
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Text of a persisted turn — the client stores it as `text` on the record. */
function recordText(record) {
  const direct = firstString(record.text, record.message, record.content, record.answer);
  return direct;
}

/**
 * Turn the raw persisted records into the history shape `prompt.mjs` renders:
 * `{ role, content, from, to, directedToMe }`. Every human message and every
 * agent's final answer is included — an agent sees the whole group chat — with
 * `role: "assistant"` only for the running agent's own past turns (rendered as
 * "you"), and `directedToMe` set when the turn `@mentioned` this agent.
 *
 * `self` is the running agent's identity (`task.self`: `{ id, name, handle }`).
 * `excludeText` drops the current message being answered (handed to the model
 * separately as the objective), mirroring the old
 * `HistoryStore.conversationFor(..., { excludeText })`.
 */
export function buildHistoryTurns(records, self, { excludeText } = {}) {
  if (!Array.isArray(records) || !records.length) return [];
  const me = self && typeof self === "object" ? self : {};
  const myKeys = new Set(
    [me.id, me.name, me.handle]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase()),
  );
  const isMe = (v) => typeof v === "string" && myKeys.has(v.trim().toLowerCase());

  // Sort by the node's zero-padded sequence (arrival order); fall back to `at`.
  const sorted = [...records].sort((a, b) => {
    const ai = firstString(a?.id, a?.seq);
    const bi = firstString(b?.id, b?.seq);
    if (ai && bi && ai !== bi) return ai < bi ? -1 : 1;
    return firstString(a?.at).localeCompare(firstString(b?.at));
  });

  const skip = typeof excludeText === "string" ? excludeText.trim() : "";
  // Drop only the *latest* record matching the current message.
  let skipped = false;
  const kept = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const record = sorted[i];
    if (!record || typeof record !== "object") continue;
    const content = recordText(record);
    if (!content) continue;
    if (!skipped && skip && content === skip) {
      skipped = true;
      continue;
    }
    kept.push(record);
  }
  kept.reverse();

  return kept.map((record) => {
    const isAgent = firstString(record.from, record.senderRole).toLowerCase() === "agent" || Boolean(record.agentName);
    const mentions = Array.isArray(record.mentions) ? record.mentions : [];
    const authoredByMe = isAgent && isMe(record.agentName);
    const directedToMe = mentions.some((m) => {
      if (!m || typeof m !== "object") return false;
      return isMe(m.id) || isMe(m.name) || isMe(m.handle);
    });
    return {
      role: authoredByMe ? "assistant" : "user",
      content: recordText(record).slice(0, MAX_TURN_CHARS),
      from: isAgent ? firstString(record.agentName, "agent") : firstString(record.fromName, record.username, "user"),
      to: mentions
        .filter((m) => m && typeof m === "object")
        .map((m) => ({ name: typeof m.name === "string" ? m.name : undefined, handle: typeof m.handle === "string" ? m.handle : undefined })),
      directedToMe,
    };
  });
}
