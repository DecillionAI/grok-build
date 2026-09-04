/**
 * The space's group chat, read and written through the node's own signal log.
 *
 * A Decillion space is a Caspar store, and everything said in it — a person's
 * message, an agent's answer, each tool call, each step of an agent's work — is
 * one persisted signal on that store, labelled with tags. There is no second
 * transcript: this backbone reads the same rows the app reads, with the same tag
 * filter, through two host calls:
 *
 *   • `readSignals` — a tag-filtered read of the store's log.
 *   • `signal`      — post into the store; the node persists it (the space is
 *                     `persHist`) and fans it out live to every participant.
 *
 * Both are node host functions, so they are a direct request/response with the
 * node rather than a creature→creature signal round trip. Nothing here matches
 * correlation ids, listens on `creatures/signal`, or reads the store's key/value
 * space: the log is the transcript.
 *
 * The tag vocabulary is shared with the client and the creatures — see
 * `SIGNAL_TAGS` below. It is the whole filtering contract, so keep it in step
 * with `new-decillion/src/caspar/signalTags.ts`.
 */

import { creatureNumber } from "./env.mjs";

const HISTORY_FETCH_TIMEOUT_MS = creatureNumber("HISTORY_FETCH_TIMEOUT_MS", 8000);
const MAX_TURN_CHARS = creatureNumber("HISTORY_TURN_CHARS", 800);
/** How many of a thread's most recent conversational turns a prompt may carry. */
const HISTORY_TURN_LIMIT = creatureNumber("HISTORY_TURN_LIMIT", 16);

/** What a signal is. One `kind=` tag per signal, always present. */
export const KIND = {
  /** A person's chat message. */
  MESSAGE: "message",
  /** An agent's final answer — the only agent output rendered as a chat turn. */
  ANSWER: "answer",
  /** One step of an agent's work: a thought, a plan write, a tool result. */
  STEP: "step",
  /** A structured log entry for one tool call an agent made. */
  TOOLCALL: "toolcall",
  /** A tool's reply to a person's `@tool <command>`. */
  TOOLREPLY: "toolreply",
  /** A thread lifecycle marker (created / renamed / deleted). */
  THREAD: "thread",
  /**
   * One event in an agent's task board (the per-agent kanban): a task queued
   * for an agent, claimed, finished, requeued or cancelled. The board is a
   * projection of these rows — there is no second store — so the app renders
   * live from the same fan-out and the backbone rebuilds the queue after a
   * restart by replaying them. Never a chat bubble.
   */
  TASK: "task",
};

/** The tags this backbone builds and filters on. */
export const SIGNAL_TAGS = {
  kind: (k) => `kind=${k}`,
  thread: (id) => `thread=${id || "main"}`,
  agent: (programId) => `agent=${programId}`,
  run: (correlationId) => `run=${correlationId}`,
  mention: (programId) => `mention=${programId}`,
  /** The task board row an event belongs to (see `KIND.TASK`). */
  task: (taskId) => `task=${taskId}`,
};

/** The kinds that are conversation — what an agent should read as the chat. */
const CONVERSATION_KINDS = [KIND.MESSAGE, KIND.ANSWER];

/**
 * Tags may only contain the characters the node accepts (see the node's
 * `signal_tags.rs`), so an id carrying anything else would have its whole signal
 * rejected. Ids are `<n>@<origin>` and thread ids are client-generated hex, both
 * already within that set; anything else is a bug worth failing on rather than
 * silently mangling, so this only strips whitespace.
 */
function tagValue(raw) {
  return String(raw ?? "").trim();
}

/**
 * Read a slice of the store's signal log.
 *
 * Returns the raw packets, newest first, each `{ id, userId, data, tags, time }`
 * with `data` parsed from its JSON string. Throws nothing — a failed read yields
 * no history, and the run proceeds against an empty transcript rather than dying
 * on a history hiccup.
 */
export async function readSpaceSignals(
  bridge,
  { spaceId, threadId, kinds, tagsAll: extraTagsAll, count = HISTORY_TURN_LIMIT, timeoutMs = HISTORY_FETCH_TIMEOUT_MS } = {},
) {
  if (!bridge || !spaceId) return [];
  const tagsAll = [];
  if (threadId) tagsAll.push(SIGNAL_TAGS.thread(tagValue(threadId)));
  // Extra `tagsAll` narrow the read further — an agent's own task board is
  // `kind=task` AND `agent=<programId>`, which the node answers as one indexed
  // query instead of a full-log scan this side has to filter.
  for (const extra of Array.isArray(extraTagsAll) ? extraTagsAll : []) {
    const t = tagValue(extra);
    if (t && !tagsAll.includes(t)) tagsAll.push(t);
  }
  const tagsAny = (kinds || []).map((k) => SIGNAL_TAGS.kind(k));
  let res;
  try {
    res = await bridge.call(
      "readSignals",
      { storeId: spaceId, tagsAll, tagsAny, count },
      { timeoutMs },
    );
  } catch {
    return [];
  }
  const rows = res && Array.isArray(res.signals) ? res.signals : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let data = null;
    if (typeof row.data === "string" && row.data) {
      try {
        data = JSON.parse(row.data);
      } catch {
        data = null;
      }
    } else if (row.data && typeof row.data === "object") {
      data = row.data;
    }
    if (!data || typeof data !== "object") continue;
    out.push({
      id: String(row.id || ""),
      userId: String(row.userId || ""),
      time: Number(row.time || 0) || 0,
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      data,
    });
  }
  return out;
}

/**
 * The conversation an agent should see: this thread's human messages and agent
 * answers, oldest first. Work steps and tool-call logs are persisted too, but
 * they are not conversation and never enter a prompt.
 */
export async function fetchSpaceConversation(bridge, { spaceId, threadId, limit = HISTORY_TURN_LIMIT }) {
  const packets = await readSpaceSignals(bridge, {
    spaceId,
    threadId,
    kinds: CONVERSATION_KINDS,
    count: limit,
  });
  // The log reads newest-first; a transcript reads oldest-first.
  return packets.slice().reverse();
}

/**
 * Post one signal into the space. The node persists it in the store's log with
 * these tags and fans it out live to every participant — one call, one record,
 * one delivery.
 *
 * Throws on failure. A turn that cannot be recorded is a real failure of the
 * run: swallowing it would leave the chat silently missing an answer the user
 * was billed for.
 */
export async function postSpaceSignal(
  bridge,
  { spaceId, kind, threadId, data, agentProgramId, correlationId, mentions, tags: extraTags, temp = false, timeoutMs = HISTORY_FETCH_TIMEOUT_MS },
) {
  if (!bridge) throw new Error("postSpaceSignal: no bridge");
  if (!spaceId) throw new Error("postSpaceSignal: no spaceId");
  if (!kind) throw new Error("postSpaceSignal: no kind");
  const tags = [SIGNAL_TAGS.kind(kind), SIGNAL_TAGS.thread(tagValue(threadId))];
  if (agentProgramId) tags.push(SIGNAL_TAGS.agent(tagValue(agentProgramId)));
  if (correlationId) tags.push(SIGNAL_TAGS.run(tagValue(correlationId)));
  for (const m of mentions || []) {
    const programId = tagValue(m && typeof m === "object" ? m.programId || m.id : m);
    if (programId) tags.push(SIGNAL_TAGS.mention(programId));
  }
  // Caller-supplied tags (the task board's `task=<id>`) ride the same list. The
  // node caps a signal at 24 tags and rejects the whole signal on a malformed
  // one, so they are trimmed and de-duplicated here like every other tag.
  for (const extra of Array.isArray(extraTags) ? extraTags : []) {
    const t = tagValue(extra);
    if (t && !tags.includes(t)) tags.push(t);
  }
  const res = await bridge.call(
    "signal",
    {
      type: "all",
      storeId: spaceId,
      data: JSON.stringify(data ?? {}),
      tags,
      // `temp` delivers live without recording. Reserved for traffic that is
      // meaningless once seen — the keep-alive heartbeat — so the log holds the
      // work an agent did, not the pings proving it was still breathing.
      ...(temp ? { temp: true } : {}),
    },
    { timeoutMs },
  );
  // The host call answering at all is not the same as the signal landing. A
  // refusal — no `signal` permission on this store, a log that cannot be
  // written — comes back in the payload, and ignoring it is how a run posts a
  // full trajectory and an answer into nothing while reporting success.
  if (!res || res.ok === false) {
    throw new Error(String(res?.error || "store refused the signal"));
  }
  // Accepted is not the same as recorded. A store that does not keep history
  // fans a signal out live and drops it, so an agent's whole trajectory — and
  // its answer — would be shown to whoever happened to be connected and be gone
  // by the next read, while every post reported success. Only `temp` traffic is
  // allowed to be unrecorded, because that is what `temp` means.
  if (!temp && res.persisted !== true) {
    throw new Error("the store did not record the signal (the space keeps no history)");
  }
  return res;
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Text of a persisted turn. */
function recordText(record) {
  return firstString(record.text, record.message, record.content, record.answer);
}

/**
 * Turn the signal packets into the history shape `prompt.mjs` renders:
 * `{ role, content, from, to, directedToMe }`. Every human message and every
 * agent's final answer is included — an agent sees the whole group chat — with
 * `role: "assistant"` only for the running agent's own past turns (rendered as
 * "you"), and `directedToMe` set when the turn `@mentioned` this agent.
 *
 * `self` is the running agent's identity (`task.self`: `{ id, name, handle }`).
 * `excludeText` drops the current message being answered, which is handed to the
 * model separately as the objective.
 *
 * Packets arrive oldest-first from `fetchSpaceConversation` (the log's own time
 * order), so nothing is re-sorted here.
 */
export function buildHistoryTurns(packets, self, { excludeText } = {}) {
  if (!Array.isArray(packets) || !packets.length) return [];
  const me = self && typeof self === "object" ? self : {};
  const myKeys = new Set(
    [me.id, me.name, me.handle]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase()),
  );
  const isMe = (v) => typeof v === "string" && myKeys.has(v.trim().toLowerCase());

  const skip = typeof excludeText === "string" ? excludeText.trim() : "";
  // Drop only the *latest* record matching the current message.
  let skipped = false;
  const kept = [];
  for (let i = packets.length - 1; i >= 0; i--) {
    const record = packets[i] && packets[i].data;
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
    const isAgent =
      firstString(record.from, record.senderRole).toLowerCase() === "agent" || Boolean(record.agentName);
    const mentions = Array.isArray(record.mentions) ? record.mentions : [];
    const authoredByMe = isAgent && isMe(record.agentName);
    const directedToMe = mentions.some((m) => {
      if (!m || typeof m !== "object") return false;
      return isMe(m.id) || isMe(m.name) || isMe(m.handle);
    });
    return {
      role: authoredByMe ? "assistant" : "user",
      content: recordText(record).slice(0, MAX_TURN_CHARS),
      from: isAgent
        ? firstString(record.agentName, "agent")
        : firstString(record.fromName, record.username, "user"),
      to: mentions
        .filter((m) => m && typeof m === "object")
        .map((m) => ({
          name: typeof m.name === "string" ? m.name : undefined,
          handle: typeof m.handle === "string" ? m.handle : undefined,
        })),
      directedToMe,
    };
  });
}
