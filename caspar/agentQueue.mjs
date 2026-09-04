/**
 * The per-agent task board — Decillion's kanban for agents.
 *
 * An agent in a project works on ONE task at a time. Everything addressed to it
 * — a person @mentioning it in chat, a teammate handing work over, a routine
 * firing — becomes a **task on that agent's board** rather than a run started on
 * the spot. When the agent is free the task is claimed immediately and runs as
 * it always did; when the agent is already working, the task waits in its
 * backlog and the agent picks it up the moment it finishes.
 *
 * Which one it picks next is the agent's own call: with more than one task
 * waiting, the backbone asks the agent's LLM to choose from the task TITLES
 * (`chooseNextTask`, `llmChoice.mjs`), so ordering follows what the work needs
 * rather than arrival order. With one waiting task there is nothing to choose,
 * and any failure falls back to oldest-first — a queue that cannot pick is still
 * a queue that drains.
 *
 * ── Where the board lives ────────────────────────────────────────────────────
 * Nowhere new. A board is a projection of `kind=task` signals on the space's own
 * log, exactly as the chat is a projection of `kind=message`/`kind=answer`:
 *
 *     queued → started → done | failed          (and: cancelled, requeued)
 *
 * Each event is one signal tagged `kind=task`, `agent=<programId>`,
 * `task=<taskId>`, `thread=<threadId>`. So the app renders the board live off
 * the same fan-out it already listens to, a reload replays it, and this backbone
 * rebuilds a queue after a restart by folding the same rows. No creature stores
 * the board, and there is no second copy to drift.
 *
 * ── One instance per agent ───────────────────────────────────────────────────
 * The serialization key is `<spaceId>::<agentProgramId>`: an agent is one worker
 * *per project*, so the same market agent hired into two projects still works in
 * both, but never twice at once in one. One backbone container serves every
 * agent on the platform, so the in-memory `busy` map is the real mutex; the log
 * is what survives a restart, and a claim that never comes back is requeued by
 * its own timer instead of wedging the agent forever.
 *
 * ── How a waiting task is later run ──────────────────────────────────────────
 * By re-signalling the agent's proxy with the payload stored on its `queued`
 * event — the same hop `orchestrate.mjs` uses to launch a teammate. The proxy
 * re-injects the agent's skill and LLM config, and the run re-enters this
 * backbone as an ordinary delivery carrying `queueTaskId` + `queueClaimed`, so
 * it runs straight away instead of being queued a second time. It bills like any
 * other unattended run: a DELEGATED quote against the payer's pool, bounded by
 * the project's autonomous budget (`ensureDelegatedAuthorization`), because by
 * then there is no client holding an authorization open for it.
 */

import crypto from "node:crypto";

import { creatureNumber } from "./env.mjs";
import { chooseNextTask } from "./llmChoice.mjs";
import { KIND, SIGNAL_TAGS, postSpaceSignal, readSpaceSignals } from "./spaceHistory.mjs";

/** The lifecycle of one task on a board. */
export const TASK_EVENT = {
  /** Addressed to this agent; waiting for it to be free. */
  QUEUED: "queued",
  /** The agent claimed it and is working on it now. */
  STARTED: "started",
  /** Finished — archived off the backlog. */
  DONE: "done",
  /** Finished badly — archived off the backlog, with the reason. */
  FAILED: "failed",
  /** A claim that never became a run; back on the backlog. */
  REQUEUED: "requeued",
  /** Withdrawn before it ran (a person cancelled it from the board). */
  CANCELLED: "cancelled",
};

/** Statuses that mean "still waiting to be worked on". */
const OPEN_STATUSES = new Set([TASK_EVENT.QUEUED, TASK_EVENT.REQUEUED]);
/** Statuses that mean "off the board" — archived, one way or another. */
const CLOSED_STATUSES = new Set([TASK_EVENT.DONE, TASK_EVENT.FAILED, TASK_EVENT.CANCELLED]);

/** How many board rows one read replays. Bounded so a long-lived project's log
 * never turns a pick into a full-history scan. */
const BOARD_READ_COUNT = creatureNumber("TASK_BOARD_READ", 240);
/**
 * How long a claimed-but-not-yet-arrived task may hold its agent's slot.
 *
 * Claiming happens here; the run itself only starts once the proxy relays the
 * task back as a delivery. If that hop is lost (the proxy is cold, the node
 * dropped the signal), the agent would sit "busy" on a run that never began, and
 * every later task on its board would wait behind a ghost. So a claim is a lease:
 * unclaimed by then, the task goes back on the board and the slot reopens.
 */
const CLAIM_TIMEOUT_MS = creatureNumber("TASK_CLAIM_TIMEOUT_MS", 180_000);
/**
 * How many times a task may be handed to its agent's proxy before the board
 * gives up on it. Without a cap, a task whose agent can never be reached would
 * be requeued and relayed forever — every attempt another row on the log, and
 * the agent's board never draining past it.
 */
const MAX_RELAY_ATTEMPTS = creatureNumber("TASK_RELAY_ATTEMPTS", 3);
/** Longest a stored payload may be. Beyond it the roster is dropped (the
 * backbone rebuilds it from the program index) and, failing that, the task is
 * still queued — with its prompt, which is what actually runs it. */
const MAX_PAYLOAD_CHARS = creatureNumber("TASK_PAYLOAD_CHARS", 24_000);
/** Longest prompt text carried on a board row. */
const MAX_PROMPT_CHARS = creatureNumber("TASK_PROMPT_CHARS", 4_000);
/** Longest title. A title is a handle for choosing, not a summary. */
const MAX_TITLE_CHARS = 96;

/** Marks a delivery whose task has already been archived (see `finish`). */
const FINISHED = Symbol("boardFinished");

function log(sentinel, payload) {
  try {
    process.stdout.write(`${sentinel} ${JSON.stringify(payload)}\n`);
  } catch {
    /* logging must never break a run */
  }
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A tag-safe id: hex only, so it can never be rejected by the node's tag rules. */
export function newTaskId() {
  return crypto.randomBytes(12).toString("hex");
}

/**
 * A short human title for a task, derived from its prompt.
 *
 * Deterministic on purpose: a title is minted on every enqueue, and paying for
 * an LLM call per enqueue to summarise a sentence would tax the common case (one
 * task, nothing to choose between) for no benefit. The model only sees titles
 * when it actually has a choice to make, and the prompt itself is on the board
 * next to the title.
 */
/**
 * Words too common to tell two tasks apart. Dropped before a similarity check so
 * "please draft the launch post" and "draft the launch post now" are recognised
 * as the same request rather than two.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "at", "by", "from",
  "please", "can", "could", "would", "you", "your", "we", "our", "it", "this", "that", "then",
  "now", "next", "also", "is", "are", "be", "as", "so", "up", "out", "do", "does", "let", "will",
]);

/** The words that actually carry a task's meaning. */
function contentWords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/(^|\s)@[a-z0-9][a-z0-9_-]*/gi, " ")
      .replace(/```[\s\S]*?```/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * How alike two task prompts are, 0…1 (Jaccard over their content words).
 *
 * Used to spot the same request arriving twice — which happens routinely, because
 * two agents who both need the same specialist each hand it the work, and both
 * hand-offs quote the same paragraph. Running it twice is not thoroughness: it is
 * the same output produced twice, and then a third agent reconciling them.
 */
export function promptSimilarity(a, b) {
  const left = contentWords(a);
  const right = contentWords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** At or above this, two waiting tasks are treated as the same request. */
const DUPLICATE_SIMILARITY = Number(creatureNumber("TASK_DUPLICATE_SIMILARITY_PCT", 82)) / 100;

export function deriveTitle(prompt, fallback = "Untitled task") {
  const text = String(prompt || "")
    // Mentions are addressing, not content — a board of "@writer ..." titles
    // says nothing about what each task is.
    .replace(/(^|\s)@[a-z0-9][a-z0-9_-]*/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] || text;
  const title = firstSentence.length > MAX_TITLE_CHARS
    ? `${firstSentence.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : firstSentence;
  return title || fallback;
}

/** Where this task came from: a person, another agent, or a routine firing. */
function taskOrigin(task) {
  const explicit = str(task && task.taskOrigin);
  if (explicit) return explicit;
  return task && task.autonomousQuote ? "agent" : "user";
}

function spaceIdOf(task) {
  return str(task && (task.spaceId || task.storeId || task.space_id));
}

function threadIdOf(task) {
  return str(task && (task.threadId || task.thread_id)) || "main";
}

function promptOf(task) {
  return str(task && (task.objective || task.prompt)) || (typeof task?.data === "string" ? task.data.trim() : "");
}

/**
 * Who this delivery is work FOR, when it is agent work in a project.
 *
 * Returns null for everything the board has no business holding: a direct tool
 * execution, a spaceless run (the market advisor), or a delivery that never
 * names the agent it is for. Those run exactly as they did before.
 */
export function queueIdentity(task) {
  if (!task || typeof task !== "object") return null;
  if (task.kind === "direct_tool") return null;
  const spaceId = spaceIdOf(task);
  if (!spaceId) return null;
  const self = task.self && typeof task.self === "object" ? task.self : {};
  const agentProgramId = str(task.proxyProgramId || task.agentProgramId || self.programId);
  if (!agentProgramId) return null;
  return {
    spaceId,
    agentProgramId,
    agentName: str(self.name || task.agentName),
    agentHandle: str(self.handle),
    agentCreatureId: str(task.agentCreatureId || self.creatureId),
    agentEntityId: str(task.proxyEntityId || task.agentEntityId) || "agent",
    threadId: threadIdOf(task),
  };
}

export function workerKey(spaceId, agentProgramId) {
  return `${spaceId}::${agentProgramId}`;
}

/**
 * The task payload stored on a `queued` event so the task can be run later.
 *
 * Stripped of everything the proxy re-injects (`skill`, `config` — the agent's
 * persona and its LLM credentials, which must never be written to a store) and
 * of the requester's `billingAuthorization`, which is bound to the correlation
 * that is being answered "queued" right now: a deferred run mints its own
 * delegated quote. Trimmed to fit a signal frame, roster first — it is a
 * convenience the backbone can rebuild from the program index, while the prompt
 * is the task itself.
 */
export function storablePayload(task) {
  const out = {};
  const drop = new Set([
    "skill",
    "config",
    "billingAuthorization",
    "billing_authorization",
    "correlationId",
    "correlation_id",
    "replyTo",
    "reply_to",
    "queueTaskId",
    "queueClaimed",
    "history",
  ]);
  for (const [k, v] of Object.entries(task || {})) {
    if (drop.has(k) || v === undefined) continue;
    out[k] = v;
  }
  if (JSON.stringify(out).length > MAX_PAYLOAD_CHARS && out.roster) {
    delete out.roster;
  }
  if (JSON.stringify(out).length > MAX_PAYLOAD_CHARS && Array.isArray(out.attachments)) {
    delete out.attachments;
  }
  return out;
}

/**
 * Fold `kind=task` rows into the board they describe: `taskId → record`, with
 * `status` the latest event and the descriptive fields carried from the row that
 * introduced the task.
 *
 * Pure, so the same fold runs in tests and (in TypeScript form) in the app —
 * the projection is the contract between them. `packets` arrive newest-first
 * from `readSpaceSignals`; they are replayed oldest-first here.
 */
export function foldTaskEvents(packets) {
  const board = new Map();
  const rows = (Array.isArray(packets) ? packets.slice() : []).reverse();
  for (const row of rows) {
    const data = row && row.data && typeof row.data === "object" ? row.data : null;
    if (!data) continue;
    const taskId = str(data.taskId);
    const event = str(data.event);
    if (!taskId || !event) continue;
    const prev = board.get(taskId) || { taskId, createdAt: row.time || 0 };
    const next = { ...prev };
    for (const field of [
      "spaceId",
      "threadId",
      "agentProgramId",
      "agentName",
      "agentHandle",
      "title",
      "prompt",
      "origin",
      "requestedBy",
      "requestedByName",
      "payload",
    ]) {
      if (data[field] !== undefined && data[field] !== null && data[field] !== "") next[field] = data[field];
    }
    next.status = event;
    next.updatedAt = row.time || next.updatedAt || 0;
    if (event === TASK_EVENT.QUEUED && !next.createdAt) next.createdAt = row.time || 0;
    if (event === TASK_EVENT.STARTED) {
      next.startedAt = row.time || 0;
      if (data.runId) next.runId = String(data.runId);
    }
    if (event === TASK_EVENT.REQUEUED) next.requeues = (prev.requeues || 0) + 1;
    if (CLOSED_STATUSES.has(event)) {
      next.endedAt = row.time || 0;
      if (data.error) next.error = String(data.error).slice(0, 300);
    }
    board.set(taskId, next);
  }
  return board;
}

/** The tasks still waiting on a board, oldest first. */
export function openTasks(board) {
  return [...board.values()]
    .filter((t) => OPEN_STATUSES.has(String(t.status)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** Read one agent's board straight out of the space's log. */
export async function readAgentBoard(bridge, { spaceId, agentProgramId, count = BOARD_READ_COUNT }) {
  const packets = await readSpaceSignals(bridge, {
    spaceId,
    kinds: [KIND.TASK],
    tagsAll: [SIGNAL_TAGS.agent(agentProgramId)],
    count,
  });
  return foldTaskEvents(packets);
}

/**
 * Record one board event. Board rows are the queue itself, so a lost write is a
 * lost task — this throws, and callers decide (an enqueue that cannot be
 * recorded must not report the task as queued).
 */
export async function postTaskEvent(bridge, record, event, extra = {}) {
  return postSpaceSignal(bridge, {
    spaceId: record.spaceId,
    kind: KIND.TASK,
    threadId: record.threadId,
    agentProgramId: record.agentProgramId,
    tags: [SIGNAL_TAGS.task(record.taskId)],
    data: {
      event,
      taskId: record.taskId,
      spaceId: record.spaceId,
      threadId: record.threadId,
      agentProgramId: record.agentProgramId,
      ...(record.agentName ? { agentName: record.agentName } : {}),
      ...(record.agentHandle ? { agentHandle: record.agentHandle } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.prompt ? { prompt: String(record.prompt).slice(0, MAX_PROMPT_CHARS) } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
      ...(record.requestedByName ? { requestedByName: record.requestedByName } : {}),
      at: new Date().toISOString(),
      ...extra,
    },
  });
}

/**
 * The one worker per agent, and the backlog behind it.
 *
 * `admit` decides what happens to an arriving delivery — run it now, or put it
 * on the board — and `finish` archives the task the run was for and starts the
 * next one. Everything else on this class serves those two.
 */
export class AgentTaskBoard {
  /**
   * @param options.signalProxy `(bridge, {agentProgramId, agentEntityId, spaceId, correlationId, streamTo, task})`
   *   → relays a stored task back through the agent's proxy. Injected so the
   *   board can be exercised without a node.
   */
  constructor(options = {}) {
    this.signalProxy = options.signalProxy;
    this.claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;
    /** `workerKey` → `{ taskId, phase: "claimed"|"running", timer }`. */
    this.busy = new Map();
    /** `workerKey` → the agent's last known `config.llm`, for the next pick. */
    this.llmByWorker = new Map();
    /** Workers with a dispatch already in flight, so two finishes never both pick. */
    this.dispatching = new Set();
  }

  /** True while this agent is claimed or running in this project. */
  isBusy(spaceId, agentProgramId) {
    return this.busy.has(workerKey(spaceId, agentProgramId));
  }

  /** How many agents are working right now (for the serve loop's log lines). */
  get activeCount() {
    return this.busy.size;
  }

  _release(key) {
    const slot = this.busy.get(key);
    if (slot?.timer) clearTimeout(slot.timer);
    this.busy.delete(key);
  }

  /**
   * Admit one delivery.
   *
   * Returns `"run"` when the caller should serve it now (the agent was free, or
   * this delivery IS a task the board claimed), or `{ queued: record }` when the
   * agent is busy and the work went onto its board instead. A delivery the board
   * does not own — a direct tool call, a spaceless run — is always `"run"`.
   */
  async admit(bridge, delivery) {
    const task = (delivery && delivery.task) || {};
    const identity = queueIdentity(task);
    if (!identity || !bridge) return "run";
    const key = workerKey(identity.spaceId, identity.agentProgramId);

    // A task this board claimed and relayed back through the proxy. The slot is
    // already held for it: convert the claim into a run.
    const claimedId = str(task.queueTaskId);
    if (claimedId && task.queueClaimed) {
      const slot = this.busy.get(key);
      if (slot && slot.taskId === claimedId) {
        // Already running this exact task: a second copy of the same relay (the
        // lease expired, the task was relayed again, and both hops landed).
        // Running it twice is precisely the thing a board exists to prevent.
        if (slot.phase === "running") {
          log("GROK_TASKBOARD", { drop: "duplicate-claim", key, taskId: claimedId });
          return { dropped: true, taskId: claimedId };
        }
        if (slot.timer) clearTimeout(slot.timer);
        this.busy.set(key, { taskId: claimedId, phase: "running" });
      } else {
        // The lease expired and the task went back on the board before the proxy
        // relayed it. Take the slot if it is free; otherwise this arrival is a
        // duplicate of work that is already moving, and re-running it would put
        // two instances of this agent on the same task.
        if (this.busy.has(key)) {
          log("GROK_TASKBOARD", { drop: "late-claim", key, taskId: claimedId, holding: this.busy.get(key)?.taskId });
          return { dropped: true, taskId: claimedId };
        }
        this.busy.set(key, { taskId: claimedId, phase: "running" });
      }
      this._rememberLlm(key, task);
      delivery.queueTaskId = claimedId;
      await this._safeEvent(bridge, { ...identity, taskId: claimedId }, TASK_EVENT.STARTED, {
        runId: str(delivery.correlationId || task.correlationId),
      });
      return "run";
    }

    // Is this the same request the board is already holding?
    //
    // Two agents who both need the same specialist each hand it the work, and
    // both hand-offs quote the same paragraph — so the specialist ran the same
    // job twice and somebody then had to reconcile two versions of one artifact.
    // A duplicate is answered as queued against the row that already exists.
    const duplicate = await this._findDuplicate(bridge, identity, task);
    if (duplicate) {
      log("GROK_TASKBOARD", { deduped: duplicate.taskId, key, title: duplicate.title || "" });
      return { queued: duplicate, duplicate: true };
    }

    const record = {
      taskId: newTaskId(),
      ...identity,
      // An assignment names its own task ("Build the page from copy.md"); prose
      // only yields its first sentence, which for a hand-off is whatever the
      // sender happened to open with. The board is chosen from these titles, so
      // a good one is worth taking where it exists.
      title:
        str(task.taskTitle) ||
        str(task.assignment && task.assignment.title) ||
        deriveTitle(promptOf(task)),
      prompt: promptOf(task),
      origin: taskOrigin(task),
      // Who this work is for and who asked for it. The payer is the person the
      // run streams to; the asker is stamped by whoever handed it over (a
      // teammate's name, a routine) and is absent for a person's own message,
      // where the chat turn beside it already says who spoke.
      requestedBy: str(task.streamTo || (task.orchestration && task.orchestration.payerUserId)),
      requestedByName: str(task.requestedByName),
    };

    // Queue first, then decide who runs it. Recording the task before it can be
    // claimed is what makes a crash between the two recoverable: the row is on
    // the board and gets picked up, rather than the work simply vanishing.
    try {
      await postTaskEvent(bridge, record, TASK_EVENT.QUEUED, { payload: storablePayload(task) });
    } catch (err) {
      // The board could not take it. Running it now is strictly better than
      // dropping the user's message on the floor — the only thing lost is the
      // one-at-a-time guarantee for this one task, and it is said out loud.
      log("GROK_TASKBOARD", {
        queue_failed: String(err?.message || err).slice(0, 200),
        key,
        note: "running this task without a board row",
      });
      return "run";
    }

    if (!this.busy.has(key)) {
      this.busy.set(key, { taskId: record.taskId, phase: "running" });
      this._rememberLlm(key, task);
      delivery.queueTaskId = record.taskId;
      task.queueTaskId = record.taskId;
      await this._safeEvent(bridge, record, TASK_EVENT.STARTED, {
        runId: str(delivery.correlationId || task.correlationId),
      });
      return "run";
    }

    log("GROK_TASKBOARD", {
      queued: record.taskId,
      key,
      title: record.title,
      behind: this.busy.get(key)?.taskId || "",
    });
    return { queued: record };
  }

  /**
   * The run for `delivery` ended. Archive its task, free the agent, and start
   * whatever it should do next. Never throws: the run is already over, and a
   * board hiccup must not turn a delivered answer into a failure.
   */
  async finish(bridge, delivery, result) {
    // Exactly once per delivery: the serve loop calls this on the success path
    // and again from its catch, and a task must not be archived twice (nor an
    // agent's slot freed twice, which would let a second instance start).
    if (!delivery || delivery[FINISHED]) return;
    delivery[FINISHED] = true;
    const task = delivery.task || {};
    const identity = queueIdentity(task);
    const taskId = str(delivery && delivery.queueTaskId) || str(task.queueTaskId);
    if (!identity) return;
    const key = workerKey(identity.spaceId, identity.agentProgramId);
    const slot = this.busy.get(key);
    // Only the run that holds this agent's slot may free it. A delivery with no
    // task of its own (the board refused its row and it ran anyway) and a
    // duplicate arrival that was dropped must both leave the slot alone —
    // freeing it would let a second instance of this agent start beside the one
    // that is genuinely working.
    if (!taskId || (slot && slot.taskId !== taskId)) {
      if (!taskId) await this.dispatch(bridge, identity);
      return;
    }
    this._release(key);
    if (taskId && bridge) {
      const failed = Boolean(result && result.success === false);
      await this._safeEvent(
        bridge,
        { ...identity, taskId },
        failed ? TASK_EVENT.FAILED : TASK_EVENT.DONE,
        {
          runId: str(delivery.correlationId || task.correlationId),
          ...(failed && result?.error ? { error: String(result.error).slice(0, 300) } : {}),
        },
      );
    }
    await this.dispatch(bridge, identity);
  }

  /**
   * Start the next task on this agent's board, if it is free and anything is
   * waiting. This is the whole cycle: it runs after every finish, and again after
   * every new task lands, until the board is empty.
   */
  async dispatch(bridge, identity) {
    if (!bridge || !identity) return null;
    const key = workerKey(identity.spaceId, identity.agentProgramId);
    if (this.busy.has(key) || this.dispatching.has(key)) return null;
    this.dispatching.add(key);
    try {
      const board = await readAgentBoard(bridge, {
        spaceId: identity.spaceId,
        agentProgramId: identity.agentProgramId,
      });
      const allWaiting = openTasks(board);
      // A task that has been handed to this agent this many times without ever
      // starting is not going to start. Close it out with the reason, rather
      // than letting it sit at the head of the board forever.
      const waiting = [];
      for (const task of allWaiting) {
        if ((Number(task.requeues) || 0) < MAX_RELAY_ATTEMPTS) {
          waiting.push(task);
          continue;
        }
        await this._safeEvent(bridge, { ...identity, taskId: task.taskId }, TASK_EVENT.FAILED, {
          error: `this agent could not be started after ${MAX_RELAY_ATTEMPTS} attempts`,
        });
      }
      if (!waiting.length) return null;
      if (this.busy.has(key)) return null;

      // The agent chooses. With one task there is nothing to choose; with more,
      // its own model reads the titles and says which to do first.
      const picked = waiting.length === 1
        ? waiting[0]
        : await chooseNextTask({
            llm: this.llmByWorker.get(key),
            agentName: identity.agentName,
            tasks: waiting,
            log: (info) => log("GROK_TASKPICK", info),
          });
      const next = picked || waiting[0];
      if (!next || !next.taskId) return null;
      // Choosing took a round trip to the model; an arriving delivery may have
      // claimed this agent while it did. The slot is the mutex, so re-check it
      // before taking it — the task is still on the board and will be picked up
      // by whichever run finishes next.
      if (this.busy.has(key)) return null;

      // Hold the slot before the relay so a second dispatch cannot claim the
      // same agent, and lease it so a relay that never lands reopens the slot.
      const timer = setTimeout(() => {
        const held = this.busy.get(key);
        if (!held || held.taskId !== next.taskId || held.phase !== "claimed") return;
        this.busy.delete(key);
        log("GROK_TASKBOARD", { claim_expired: next.taskId, key });
        this._safeEvent(bridge, { ...identity, taskId: next.taskId }, TASK_EVENT.REQUEUED, {
          error: "the agent never picked this task up; back on the board",
        }).then(() => this.dispatch(bridge, identity));
      }, this.claimTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.busy.set(key, { taskId: next.taskId, phase: "claimed", timer });

      const relayed = await this._relay(bridge, identity, next);
      if (!relayed) {
        this._release(key);
        await this._safeEvent(bridge, { ...identity, taskId: next.taskId }, TASK_EVENT.REQUEUED, {
          error: "could not reach this agent's proxy; back on the board",
        });
        return null;
      }
      log("GROK_TASKBOARD", { dispatched: next.taskId, key, title: next.title || "", waiting: waiting.length });
      return next;
    } catch (err) {
      log("GROK_TASKBOARD", { dispatch_error: String(err?.message || err).slice(0, 200), key });
      this._release(key);
      return null;
    } finally {
      this.dispatching.delete(key);
    }
  }

  /**
   * Relay a waiting task back through the agent's proxy so it runs. The proxy
   * injects the agent's skill and LLM config and forwards it here as a normal
   * delivery — marked `queueClaimed` so it runs instead of queueing again, and
   * `serverOrchestrate` with no authorization so it bills as the unattended run
   * it now is (a delegated quote on the payer's pool, inside the project's
   * autonomous budget).
   */
  async _relay(bridge, identity, record) {
    const stored = record.payload && typeof record.payload === "object" ? record.payload : {};
    const payer = str(stored.streamTo || stored.ownerUserId || record.requestedBy);
    const correlationId = crypto.randomBytes(16).toString("hex");
    const orchestration = stored.orchestration && typeof stored.orchestration === "object"
      ? { ...stored.orchestration }
      : {};
    if (!orchestration.payerUserId && payer) orchestration.payerUserId = payer;
    if (orchestration.depth === undefined) orchestration.depth = 0;
    const task = {
      ...stored,
      prompt: stored.prompt || record.prompt || "",
      objective: stored.objective || record.prompt || "",
      spaceId: identity.spaceId,
      threadId: record.threadId || identity.threadId,
      groupChat: true,
      proxyProgramId: identity.agentProgramId,
      agentProgramId: identity.agentProgramId,
      ...(identity.agentCreatureId ? { agentCreatureId: identity.agentCreatureId } : {}),
      self: {
        id: stored.targetAgentId || identity.agentProgramId,
        name: identity.agentName,
        handle: identity.agentHandle,
        programId: identity.agentProgramId,
      },
      ...(payer ? { streamTo: payer } : {}),
      correlationId,
      serverOrchestrate: true,
      orchestration,
      queueTaskId: record.taskId,
      queueClaimed: true,
      taskTitle: record.title || "",
    };
    delete task.billingAuthorization;
    const send = this.signalProxy || defaultSignalProxy;
    try {
      await send(bridge, {
        agentProgramId: identity.agentProgramId,
        agentEntityId: identity.agentEntityId || "agent",
        spaceId: identity.spaceId,
        correlationId,
        streamTo: payer,
        task,
      });
      return true;
    } catch (err) {
      log("GROK_TASKBOARD", { relay_error: String(err?.message || err).slice(0, 200), taskId: record.taskId });
      return false;
    }
  }

  /**
   * A task already waiting on this agent's board that IS this request.
   *
   * Only open rows count — a request that repeats work already finished is a
   * different problem, and the plan (what already exists) is what answers it.
   * Returns null on any read failure: enqueuing a possible duplicate is much
   * cheaper than dropping a real task.
   */
  async _findDuplicate(bridge, identity, task) {
    const prompt = promptOf(task);
    if (!prompt) return null;
    try {
      const board = await readAgentBoard(bridge, {
        spaceId: identity.spaceId,
        agentProgramId: identity.agentProgramId,
      });
      for (const waiting of openTasks(board)) {
        if (waiting.threadId && waiting.threadId !== identity.threadId) continue;
        if (promptSimilarity(waiting.prompt, prompt) >= DUPLICATE_SIMILARITY) return waiting;
      }
    } catch (err) {
      log("GROK_TASKBOARD", { dedupe_read_error: String(err?.message || err).slice(0, 160) });
    }
    return null;
  }

  _rememberLlm(key, task) {
    const llm = task && task.config && typeof task.config === "object" ? task.config.llm : null;
    if (llm && typeof llm === "object") this.llmByWorker.set(key, llm);
  }

  async _safeEvent(bridge, record, event, extra) {
    try {
      await postTaskEvent(bridge, record, event, extra);
    } catch (err) {
      log("GROK_TASKBOARD", { event_lost: event, taskId: record.taskId, error: String(err?.message || err).slice(0, 200) });
    }
  }
}

/** Signal one agent's proxy with a task packet — the same hop a hand-off uses. */
async function defaultSignalProxy(bridge, { agentProgramId, agentEntityId, spaceId, correlationId, streamTo, task }) {
  const packet = {
    action: "single",
    user: { id: String(streamTo || bridge.programId || "") },
    store: { id: spaceId },
    data: JSON.stringify({
      programId: agentProgramId,
      entity: agentEntityId || "agent",
      payload: JSON.stringify(task),
    }),
    entityId: agentEntityId || "agent",
    correlationId,
  };
  await bridge.signalUser("creatures/signal", agentProgramId, packet);
}
