/**
 * The project's shared PLAN — the one thing this platform was missing.
 *
 * A space already had a chat log (what was said), a per-agent board (what each
 * agent is working on next) and a shared machine (where files land). What it did
 * not have was a shared model of **the work itself**: the outcome, what "done"
 * means, which tasks exist, who owns each one, what each must produce, and what
 * has already been produced.
 *
 * Without that, coordination between agents was prose: a hand-off carried the
 * previous agent's entire chat reply as its whole task specification. Nothing
 * said what was already done, so every hand-off invited the receiving agent to
 * restart the problem — which is exactly what a room full of capable agents did,
 * forever, until the wallet stopped them.
 *
 * ── Where the plan lives ─────────────────────────────────────────────────────
 * Nowhere new, and no creature. Like the task board, the plan is a projection of
 * signals on the space's own log — `kind=plan`, tagged `plan=<planTaskId>` for
 * the task-scoped ones:
 *
 *     goal → task → claim → complete | blocked | cancel      (+ artifact)
 *
 * So the app renders it live off the fan-out it already listens to, a reload
 * replays it, the backbone rebuilds it after a restart by folding the same rows,
 * and there is no second copy to drift. Plan rows are state about the work, never
 * a chat bubble.
 *
 * ── Why it ends the loop ─────────────────────────────────────────────────────
 * Three things become possible that were not:
 *
 *   1. A hand-off can carry a CONTRACT (`assign_task`): a task id, an objective,
 *      the inputs that already exist, and what makes it done. The receiving agent
 *      no longer has to guess the job from a paragraph.
 *   2. Every prompt can state WHAT ALREADY EXISTS — the artifact manifest and the
 *      closed tasks — so nobody rebuilds a teammate's work.
 *   3. "Done" becomes a thing that can be true. The acceptance criteria are
 *      written down once, so a chain has somewhere to stop (see acceptance.mjs).
 */

import crypto from "node:crypto";

import { creatureNumber } from "./env.mjs";
import { KIND, SIGNAL_TAGS, postSpaceSignal, readSpaceSignals } from "./spaceHistory.mjs";

/** The lifecycle of one task in the plan. */
export const PLAN_STATUS = {
  /** Written down, nobody working on it yet. */
  OPEN: "open",
  /** An agent has taken it and is working on it. */
  CLAIMED: "claimed",
  /** Finished, with the artifacts it produced. */
  DONE: "done",
  /** Cannot proceed, with the reason. */
  BLOCKED: "blocked",
  /** Withdrawn — the plan changed. */
  CANCELLED: "cancelled",
};

/** The `event` field on a `kind=plan` row. */
export const PLAN_EVENT = {
  GOAL: "goal",
  TASK: "task",
  CLAIM: "claim",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  CANCEL: "cancel",
  ARTIFACT: "artifact",
};

/** Statuses that still need somebody to do something. */
const OPEN_STATUSES = new Set([PLAN_STATUS.OPEN, PLAN_STATUS.CLAIMED, PLAN_STATUS.BLOCKED]);

/** How many plan rows one read replays. Bounded so a long project's log never
 * turns a plan read into a full-history scan. */
const PLAN_READ_COUNT = creatureNumber("PLAN_READ_COUNT", 300);
/** Caps, so a plan row always fits a signal frame. */
const MAX_GOAL_CHARS = 2000;
const MAX_OBJECTIVE_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 200;
/** How many artifacts and tasks a rendered plan block may carry into a prompt. */
const MAX_RENDERED_ARTIFACTS = creatureNumber("PLAN_RENDER_ARTIFACTS", 40);
const MAX_RENDERED_TASKS = creatureNumber("PLAN_RENDER_TASKS", 30);

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value, { items = MAX_LIST_ITEMS, chars = MAX_ITEM_CHARS } = {}) {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [value] : [];
  const out = [];
  for (const entry of raw) {
    const text = str(typeof entry === "string" ? entry : entry && (entry.text || entry.path || entry.name));
    if (!text || out.includes(text)) continue;
    out.push(text.slice(0, chars));
    if (out.length >= items) break;
  }
  return out;
}

/** A tag-safe id: hex only, so it can never be rejected by the node's tag rules. */
export function newPlanTaskId() {
  return crypto.randomBytes(10).toString("hex");
}

function spaceIdOf(task) {
  return str(task && (task.spaceId || task.storeId || task.space_id));
}

function threadIdOf(task) {
  return str(task && (task.threadId || task.thread_id)) || "main";
}

/** The running agent, as the plan records authorship. */
export function planActor(task) {
  const self = task && task.self && typeof task.self === "object" ? task.self : {};
  return {
    programId: str(task && (task.proxyProgramId || task.agentProgramId)) || str(self.programId),
    name: str(self.name || (task && task.agentName)),
    handle: str(self.handle),
  };
}

/**
 * Fold `kind=plan` rows into the plan they describe.
 *
 * Pure, so the same fold runs in the tests and (in TypeScript form) in the app —
 * the projection is the contract between them. `packets` arrive newest-first
 * from `readSpaceSignals`; they are replayed oldest-first here.
 */
export function foldPlanEvents(packets) {
  const plan = {
    goal: "",
    acceptance: [],
    goalSetAt: 0,
    tasks: new Map(),
    artifacts: new Map(),
    updatedAt: 0,
  };
  const rows = (Array.isArray(packets) ? packets.slice() : []).reverse();
  for (const row of rows) {
    const data = row && row.data && typeof row.data === "object" ? row.data : null;
    if (!data) continue;
    const event = str(data.event);
    if (!event) continue;
    const at = Number(row.time || 0) || 0;
    if (at > plan.updatedAt) plan.updatedAt = at;

    if (event === PLAN_EVENT.GOAL) {
      const goal = str(data.goal);
      if (goal) plan.goal = goal;
      const acceptance = list(data.acceptance);
      if (acceptance.length) plan.acceptance = acceptance;
      plan.goalSetAt = at;
      continue;
    }

    if (event === PLAN_EVENT.ARTIFACT) {
      const path = str(data.path);
      if (!path) continue;
      plan.artifacts.set(path, {
        path,
        producedBy: str(data.producedByName || data.producedBy),
        planTaskId: str(data.planTaskId),
        note: str(data.note),
        updatedAt: at,
      });
      continue;
    }

    const planTaskId = str(data.planTaskId);
    if (!planTaskId) continue;
    const prev = plan.tasks.get(planTaskId) || {
      planTaskId,
      status: PLAN_STATUS.OPEN,
      createdAt: at,
      artifacts: [],
    };
    const next = { ...prev };
    for (const field of [
      "title",
      "objective",
      "owner",
      "ownerName",
      "ownerHandle",
      "createdBy",
      "createdByName",
    ]) {
      if (str(data[field])) next[field] = str(data[field]);
    }
    for (const field of ["dependsOn", "produces", "doneWhen"]) {
      if (Array.isArray(data[field]) && data[field].length) next[field] = list(data[field]);
    }
    next.updatedAt = at;

    if (event === PLAN_EVENT.TASK) {
      next.status = prev.status === PLAN_STATUS.DONE ? prev.status : PLAN_STATUS.OPEN;
      if (!next.createdAt) next.createdAt = at;
    } else if (event === PLAN_EVENT.CLAIM) {
      next.status = PLAN_STATUS.CLAIMED;
      next.claimedAt = at;
    } else if (event === PLAN_EVENT.COMPLETE) {
      next.status = PLAN_STATUS.DONE;
      next.endedAt = at;
      if (str(data.summary)) next.summary = str(data.summary).slice(0, MAX_ITEM_CHARS * 2);
      const produced = list(data.artifacts);
      if (produced.length) next.artifacts = [...new Set([...(prev.artifacts || []), ...produced])];
      for (const path of produced) {
        plan.artifacts.set(path, {
          path,
          producedBy: str(data.ownerName || next.ownerName || next.owner),
          planTaskId,
          note: str(data.summary).slice(0, MAX_ITEM_CHARS),
          updatedAt: at,
        });
      }
    } else if (event === PLAN_EVENT.BLOCKED) {
      next.status = PLAN_STATUS.BLOCKED;
      if (str(data.reason)) next.reason = str(data.reason).slice(0, MAX_ITEM_CHARS);
    } else if (event === PLAN_EVENT.CANCEL) {
      next.status = PLAN_STATUS.CANCELLED;
      if (str(data.reason)) next.reason = str(data.reason).slice(0, MAX_ITEM_CHARS);
    }
    plan.tasks.set(planTaskId, next);
  }
  return plan;
}

/** An empty plan — the shape every reader can rely on. */
export function emptyPlan() {
  return { goal: "", acceptance: [], goalSetAt: 0, tasks: new Map(), artifacts: new Map(), updatedAt: 0 };
}

/** Read the project's plan straight out of the space's log. */
export async function readProjectPlan(bridge, { spaceId, threadId, count = PLAN_READ_COUNT } = {}) {
  if (!bridge || !spaceId) return emptyPlan();
  try {
    const packets = await readSpaceSignals(bridge, {
      spaceId,
      threadId,
      kinds: [KIND.PLAN],
      count,
    });
    return foldPlanEvents(packets);
  } catch {
    return emptyPlan();
  }
}

/** Tasks still needing work, oldest first. */
export function openPlanTasks(plan) {
  return [...plan.tasks.values()]
    .filter((t) => OPEN_STATUSES.has(String(t.status)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** Tasks that are finished. */
export function donePlanTasks(plan) {
  return [...plan.tasks.values()]
    .filter((t) => String(t.status) === PLAN_STATUS.DONE)
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
}

/** Does this plan say enough for a chain to be judged against it? */
export function planIsUsable(plan) {
  return Boolean(plan && (plan.goal || plan.tasks.size));
}

/** Post one plan event. The plan is the team's shared state, so a lost write is
 * a lost decision — this throws and the caller decides. */
export async function postPlanEvent(bridge, { spaceId, threadId, planTaskId, event, data }) {
  return postSpaceSignal(bridge, {
    spaceId,
    kind: KIND.PLAN,
    threadId: threadId || "main",
    ...(planTaskId ? { tags: [SIGNAL_TAGS.plan(planTaskId)] } : {}),
    data: {
      event,
      ...(planTaskId ? { planTaskId } : {}),
      at: new Date().toISOString(),
      ...data,
    },
  });
}

/**
 * Write the project's goal and, more importantly, its ACCEPTANCE CRITERIA — the
 * checkable statements that decide when the team is finished. Without them there
 * is no condition under which a chain of agents is allowed to stop.
 */
export async function setPlanGoal(bridge, task, { goal, acceptance }) {
  const spaceId = spaceIdOf(task);
  if (!spaceId) return { ok: false, error: "this run has no project to plan for" };
  const text = str(goal).slice(0, MAX_GOAL_CHARS);
  const criteria = list(acceptance, { items: MAX_LIST_ITEMS, chars: MAX_ITEM_CHARS * 2 });
  if (!text && !criteria.length) return { ok: false, error: "goal or acceptance is required" };
  const actor = planActor(task);
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    event: PLAN_EVENT.GOAL,
    data: {
      ...(text ? { goal: text } : {}),
      ...(criteria.length ? { acceptance: criteria } : {}),
      setBy: actor.programId,
      setByName: actor.name,
    },
  });
  return { ok: true, goal: text, acceptance: criteria };
}

/**
 * Add one task to the plan. This is the unit a hand-off addresses, so it carries
 * everything the receiving agent would otherwise have to infer from prose: what
 * to do, what it may build on, what it must produce, and what makes it done.
 */
export async function addPlanTask(bridge, task, args = {}) {
  const spaceId = spaceIdOf(task);
  if (!spaceId) return { ok: false, error: "this run has no project to plan for" };
  const title = str(args.title).slice(0, MAX_TITLE_CHARS);
  const objective = str(args.objective || args.description).slice(0, MAX_OBJECTIVE_CHARS);
  if (!title && !objective) return { ok: false, error: "title or objective is required" };
  const actor = planActor(task);
  const planTaskId = str(args.planTaskId) || newPlanTaskId();
  const record = {
    title: title || objective.split(/(?<=[.!?])\s/)[0].slice(0, MAX_TITLE_CHARS),
    objective: objective || title,
    ...(str(args.owner) ? { owner: str(args.owner) } : {}),
    ...(str(args.ownerName) ? { ownerName: str(args.ownerName) } : {}),
    ...(str(args.ownerHandle) ? { ownerHandle: str(args.ownerHandle).replace(/^@/, "") } : {}),
    dependsOn: list(args.dependsOn || args.depends_on),
    produces: list(args.produces),
    doneWhen: list(args.doneWhen || args.done_when),
    createdBy: actor.programId,
    createdByName: actor.name,
  };
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    planTaskId,
    event: PLAN_EVENT.TASK,
    data: record,
  });
  return { ok: true, planTaskId, ...record };
}

/** Take a task: the plan now says this agent owns it and is working on it. */
export async function claimPlanTask(bridge, task, { planTaskId }) {
  const spaceId = spaceIdOf(task);
  const id = str(planTaskId);
  if (!spaceId || !id) return { ok: false, error: "planTaskId is required" };
  const actor = planActor(task);
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    planTaskId: id,
    event: PLAN_EVENT.CLAIM,
    data: { owner: actor.programId, ownerName: actor.name, ownerHandle: actor.handle },
  });
  return { ok: true, planTaskId: id, status: PLAN_STATUS.CLAIMED };
}

/**
 * Close a task and register what it produced.
 *
 * The artifact list is the point: it is what every later prompt shows every
 * other agent, and it is what an acceptance check reads. A task closed with no
 * artifact is allowed — some work is a decision — but it is the artifacts that
 * stop the next agent rebuilding this one's output.
 */
export async function completePlanTask(bridge, task, args = {}) {
  const spaceId = spaceIdOf(task);
  const id = str(args.planTaskId);
  if (!spaceId || !id) return { ok: false, error: "planTaskId is required" };
  const actor = planActor(task);
  const artifacts = list(args.artifacts, { items: MAX_LIST_ITEMS * 2 });
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    planTaskId: id,
    event: PLAN_EVENT.COMPLETE,
    data: {
      artifacts,
      summary: str(args.summary).slice(0, MAX_ITEM_CHARS * 2),
      owner: actor.programId,
      ownerName: actor.name,
    },
  });
  return { ok: true, planTaskId: id, status: PLAN_STATUS.DONE, artifacts };
}

/** Say a task cannot proceed, and why. */
export async function blockPlanTask(bridge, task, { planTaskId, reason }) {
  const spaceId = spaceIdOf(task);
  const id = str(planTaskId);
  if (!spaceId || !id) return { ok: false, error: "planTaskId is required" };
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    planTaskId: id,
    event: PLAN_EVENT.BLOCKED,
    data: { reason: str(reason).slice(0, MAX_ITEM_CHARS), ...planActor(task) },
  });
  return { ok: true, planTaskId: id, status: PLAN_STATUS.BLOCKED };
}

/** Register an artifact without closing a task (a shared file, a preview URL). */
export async function registerArtifact(bridge, task, { path, note, planTaskId }) {
  const spaceId = spaceIdOf(task);
  const target = str(path);
  if (!spaceId || !target) return { ok: false, error: "path is required" };
  const actor = planActor(task);
  await postPlanEvent(bridge, {
    spaceId,
    threadId: threadIdOf(task),
    event: PLAN_EVENT.ARTIFACT,
    data: {
      path: target.slice(0, MAX_ITEM_CHARS),
      note: str(note).slice(0, MAX_ITEM_CHARS),
      producedBy: actor.programId,
      producedByName: actor.name,
      ...(str(planTaskId) ? { planTaskId: str(planTaskId) } : {}),
    },
  });
  return { ok: true, path: target };
}

/**
 * The plan as a prompt section: the outcome, what makes it done, what already
 * exists, and who owes what.
 *
 * This block is the direct antidote to the two failures this whole module
 * exists for — an agent rebuilding a teammate's artifact, and a chain with no
 * condition under which it may stop. Empty when the plan is empty, so a project
 * that never plans is unaffected.
 */
export function renderPlanForPrompt(plan, { self } = {}) {
  if (!plan || !planIsUsable(plan)) return "";
  const me = self && typeof self === "object" ? self : {};
  const myProgram = str(me.programId);
  const parts = ["=== PROJECT PLAN (shared — every agent reads and writes this) ==="];
  if (plan.goal) parts.push(`OUTCOME: ${plan.goal}`);
  if (plan.acceptance.length) {
    parts.push(
      "DONE WHEN (all of these are true — when they are, the work is finished and nobody should start more):",
      ...plan.acceptance.map((c) => `  ☐ ${c}`),
    );
  }

  const artifacts = [...plan.artifacts.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_RENDERED_ARTIFACTS);
  if (artifacts.length) {
    parts.push(
      "ALREADY PRODUCED — these exist. Read them before you write anything; do NOT recreate them:",
      ...artifacts.map((a) => `  • ${a.path}${a.producedBy ? ` (by ${a.producedBy})` : ""}${a.note ? ` — ${a.note}` : ""}`),
    );
  }

  const done = donePlanTasks(plan).slice(-MAX_RENDERED_TASKS);
  if (done.length) {
    parts.push(
      "ALREADY DONE — do not redo these:",
      ...done.map((t) => `  ✔ ${t.title}${t.ownerName ? ` (${t.ownerName})` : ""}${t.summary ? ` — ${t.summary}` : ""}`),
    );
  }

  const open = openPlanTasks(plan).slice(0, MAX_RENDERED_TASKS);
  if (open.length) {
    parts.push(
      "STILL OPEN:",
      ...open.map((t) => {
        const owner = t.ownerName || t.ownerHandle || "";
        const who = owner ? (myProgram && t.owner === myProgram ? " — YOURS" : ` — ${owner}`) : " — unassigned";
        const blocked = t.status === PLAN_STATUS.BLOCKED ? ` [BLOCKED: ${t.reason || "no reason given"}]` : "";
        return `  ☐ [${t.planTaskId}] ${t.title}${who}${blocked}`;
      }),
    );
  }
  parts.push("=== END PROJECT PLAN ===");
  return `${parts.join("\n")}\n`;
}

/**
 * The plan's own view of whether the project is finished: every acceptance
 * criterion written down, no open task left, and at least one artifact produced.
 *
 * Deliberately structural — it asks "is there anything left on the board?", not
 * "is the work good?". Judging quality is `acceptance.mjs`'s job; this is the
 * cheap check that runs on every hop.
 */
export function planLooksComplete(plan) {
  if (!plan || !planIsUsable(plan)) return false;
  if (openPlanTasks(plan).length) return false;
  if (!donePlanTasks(plan).length) return false;
  return true;
}
