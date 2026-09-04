/**
 * The plan, as tools an agent can actually call.
 *
 * `projectPlan.mjs` is the state; this is the surface. Six native tools, all
 * cheap, all backed by one signal each:
 *
 *   read_plan      — what is the outcome, what already exists, what is open
 *   set_plan_goal  — write the outcome and, crucially, the acceptance criteria
 *   add_task       — put a piece of work in the plan
 *   claim_task     — take one
 *   complete_task  — close one and register what it produced
 *   assign_task    — hand one to a teammate, WITH a contract
 *
 * `assign_task` is the important one. Before it, the only way to reach a teammate
 * was to @mention them in prose and hope they inferred the job; the receiving
 * agent got the sender's entire reply as its whole specification. Now a hand-off
 * names a task, an objective, the inputs that already exist and what makes it
 * done — and it is the same launch path a mention takes, so it costs a hop, bills
 * the same way, and lands on the teammate's board rather than starting a second
 * instance of them.
 *
 * This module is where the plan meets orchestration, which is why it lives apart
 * from `projectPlan.mjs`: that stays free of orchestration imports so the app and
 * the tests can fold a plan without pulling in billing.
 */

import { handOffContext, launchTeammates, rootRunIdOf } from "./orchestrate.mjs";
import {
  addPlanTask,
  blockPlanTask,
  claimPlanTask,
  completePlanTask,
  donePlanTasks,
  openPlanTasks,
  readProjectPlan,
  registerArtifact,
  setPlanGoal,
} from "./projectPlan.mjs";

const DEFAULT_MAX_HOPS = 6;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function spaceIdOf(task) {
  return str(task && (task.spaceId || task.storeId || task.space_id));
}

function threadIdOf(task) {
  return str(task && (task.threadId || task.thread_id)) || "main";
}

export const READ_PLAN_TOOL = {
  name: "read_plan",
  description:
    "Read this project's shared plan: the outcome, the acceptance criteria that decide when the " +
    "work is finished, every artifact the team has already produced, and every task still open " +
    "with its owner. Call this BEFORE starting work — it is how you avoid rebuilding something a " +
    "teammate already made, and how you know whether anything is actually left to do.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const SET_PLAN_GOAL_TOOL = {
  name: "set_plan_goal",
  description:
    "Write the project's outcome and its ACCEPTANCE CRITERIA — the short, checkable statements " +
    "that decide when this project is done. Do this once, early, when you are the agent shaping " +
    "the work. Good criteria are things somebody could verify ('the landing page is live at a " +
    "public URL', 'README documents the deploy'), not aspirations ('the site is great'). " +
    "Without them nothing can ever tell the team it has finished.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "The outcome this project exists to produce, in a sentence or two." },
      acceptance: {
        type: "array",
        items: { type: "string" },
        description: "Checkable statements that are all true exactly when the project is done.",
      },
    },
    required: ["goal"],
  },
};

export const ADD_TASK_TOOL = {
  name: "add_task",
  description:
    "Add one piece of work to the shared plan so the whole team can see it. Use it when you break " +
    "an outcome into steps, or when you discover work nobody has written down. Say what it must " +
    "produce and what makes it done — a task without those is what makes the next agent guess.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short name for the task." },
      objective: { type: "string", description: "What doing this task actually involves." },
      ownerHandle: { type: "string", description: "The @handle of the agent who should own it, if you know." },
      produces: { type: "array", items: { type: "string" }, description: "Files, URLs or artifacts it must produce." },
      doneWhen: { type: "array", items: { type: "string" }, description: "Checkable statements that make it done." },
      dependsOn: { type: "array", items: { type: "string" }, description: "Plan task ids that must finish first." },
    },
    required: ["title"],
  },
};

export const CLAIM_TASK_TOOL = {
  name: "claim_task",
  description:
    "Take a task from the plan: it is now yours and the team can see you are on it. Claim before " +
    "you start, so two agents never work the same task in parallel.",
  inputSchema: {
    type: "object",
    properties: { planTaskId: { type: "string", description: "The task id, from read_plan." } },
    required: ["planTaskId"],
  },
};

export const COMPLETE_TASK_TOOL = {
  name: "complete_task",
  description:
    "Close a task and register what it produced. ALWAYS list the artifacts — the file paths on the " +
    "shared machine, the public URL, whatever the team can now open. That list is what every other " +
    "agent is shown before it starts, so registering it is what stops somebody rebuilding your work. " +
    "Closing the last open task is how a project reaches its end.",
  inputSchema: {
    type: "object",
    properties: {
      planTaskId: { type: "string", description: "The task id, from read_plan." },
      artifacts: {
        type: "array",
        items: { type: "string" },
        description: "Paths on the shared machine or public URLs this task produced.",
      },
      summary: { type: "string", description: "One line: what is now true that was not before." },
    },
    required: ["planTaskId"],
  },
};

export const ASSIGN_TASK_TOOL = {
  name: "assign_task",
  description:
    "Hand a piece of work to a teammate WITH a proper brief — the preferred way to bring somebody " +
    "in. Unlike mentioning them in prose, this gives them a task in the shared plan: what to do, " +
    "what already exists that they should build on, and what makes it done. They start as soon as " +
    "they are free; you do not wait for them, and you must not repeat the request. Only assign work " +
    "somebody actually needs to do — if the outcome is already met, close your task instead.",
  inputSchema: {
    type: "object",
    properties: {
      toHandle: { type: "string", description: "The teammate's @handle (with or without the @)." },
      objective: { type: "string", description: "What you need them to do, specifically." },
      inputs: {
        type: "array",
        items: { type: "string" },
        description: "Artifacts that already exist and that they should build on, not recreate.",
      },
      doneWhen: { type: "array", items: { type: "string" }, description: "What makes their task done." },
      title: { type: "string", description: "Optional short name for the task." },
    },
    required: ["toHandle", "objective"],
  },
};

export const BLOCK_TASK_TOOL = {
  name: "block_task",
  description:
    "Say a task cannot proceed, and why. Use it instead of doing something adjacent that nobody " +
    "asked for: a blocked task with a stated reason is progress, silently substituting different " +
    "work is not.",
  inputSchema: {
    type: "object",
    properties: {
      planTaskId: { type: "string" },
      reason: { type: "string", description: "What is missing or in the way." },
    },
    required: ["planTaskId", "reason"],
  },
};

export const REGISTER_ARTIFACT_TOOL = {
  name: "register_artifact",
  description:
    "Register something you produced (a file on the shared machine, a public URL) without closing a " +
    "task. Everything you register is shown to every other agent before it starts work.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path on the shared machine, or a URL." },
      note: { type: "string", description: "One line on what it is." },
    },
    required: ["path"],
  },
};

/** Every plan tool, in the order they are advertised to the model. */
export const PLAN_TOOLS = [
  READ_PLAN_TOOL,
  SET_PLAN_GOAL_TOOL,
  ADD_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
  ASSIGN_TASK_TOOL,
  BLOCK_TASK_TOOL,
  REGISTER_ARTIFACT_TOOL,
];

export const PLAN_TOOL_NAMES = new Set(PLAN_TOOLS.map((t) => t.name));

/** The plan, shaped for a model to read back from a tool call. */
function planPayload(plan) {
  return {
    goal: plan.goal || "",
    acceptance: plan.acceptance,
    artifacts: [...plan.artifacts.values()].map((a) => ({
      path: a.path,
      producedBy: a.producedBy || undefined,
      note: a.note || undefined,
    })),
    open: openPlanTasks(plan).map((t) => ({
      planTaskId: t.planTaskId,
      title: t.title,
      objective: t.objective,
      owner: t.ownerName || t.ownerHandle || undefined,
      status: t.status,
      doneWhen: t.doneWhen,
      produces: t.produces,
      ...(t.reason ? { blockedBecause: t.reason } : {}),
    })),
    done: donePlanTasks(plan).map((t) => ({
      planTaskId: t.planTaskId,
      title: t.title,
      owner: t.ownerName || undefined,
      artifacts: t.artifacts,
      summary: t.summary || undefined,
    })),
  };
}

/**
 * Resolve a teammate handle against the space's roster. Kept deliberately simple
 * and EXACT: an assignment names somebody outright, so a near-miss is told to the
 * model rather than guessed at — a guessed hand-off is a wasted run and a wrong
 * artifact somebody else then has to undo.
 */
function findTeammate(task, handle) {
  const wanted = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  if (!wanted) return null;
  const slug = (v) =>
    String(v || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const selfProgram = str(task.proxyProgramId || task.agentProgramId || (task.self && task.self.programId));
  const roster = Array.isArray(task.roster) ? task.roster : [];
  for (const row of roster) {
    if (!row || typeof row !== "object") continue;
    if (row.kind && row.kind !== "agent") continue;
    const programId = str(row.programId || row.id);
    if (!programId || programId === selfProgram) continue;
    if (slug(row.handle) === slug(wanted) || slug(row.name) === slug(wanted)) {
      return {
        programId,
        creatureId: str(row.creatureId),
        entityId: str(row.entityId) || "agent",
        resourceId: str(row.resourceId || row.id) || programId,
        name: str(row.name),
        handle: str(row.handle) || slug(row.name),
      };
    }
  }
  return null;
}

/** The handles this agent could have meant, for a "no such teammate" reply. */
function knownHandles(task) {
  return (Array.isArray(task.roster) ? task.roster : [])
    .filter((r) => r && (!r.kind || r.kind === "agent"))
    .map((r) => str(r.handle) || str(r.name))
    .filter(Boolean);
}

/**
 * Hand a task to a teammate with a contract.
 *
 * The task is written into the plan first (so it exists, and is visible, even if
 * the launch is refused for budget) and only then is the teammate started. That
 * ordering is deliberate: an assignment nobody can pay for should still be a
 * visible piece of open work, not a silently dropped intention.
 */
async function assignTask(bridge, task, args) {
  const spaceId = spaceIdOf(task);
  if (!spaceId) return { ok: false, error: "this run has no project to assign work in" };
  const teammate = findTeammate(task, args.toHandle);
  if (!teammate) {
    const known = knownHandles(task);
    return {
      ok: false,
      error: `no agent in this project answers to @${String(args.toHandle || "").replace(/^@/, "")}.`,
      knownAgents: known,
    };
  }
  const objective = str(args.objective);
  if (!objective) return { ok: false, error: "objective is required — say what you need them to do" };

  const created = await addPlanTask(bridge, task, {
    title: str(args.title) || objective.split(/(?<=[.!?])\s/)[0],
    objective,
    owner: teammate.programId,
    ownerName: teammate.name,
    ownerHandle: teammate.handle,
    produces: args.produces,
    doneWhen: args.doneWhen,
  });
  if (!created.ok) return created;

  const context = await handOffContext(bridge, task);
  if (!context) {
    return {
      ok: true,
      planTaskId: created.planTaskId,
      started: false,
      note:
        "The task is in the plan and visible to the team, but it could not be started right now " +
        "(no billing context on this run). Do not repeat the assignment.",
    };
  }

  const orch = task.orchestration && typeof task.orchestration === "object" ? task.orchestration : {};
  const depth = Number(orch.depth || 0);
  const maxHops = Number(orch.maxHops || DEFAULT_MAX_HOPS);
  if (depth + 1 >= maxHops) {
    return {
      ok: true,
      planTaskId: created.planTaskId,
      started: false,
      note:
        "The task is in the plan, but this chain has reached its hop limit so it was not started " +
        "now. It stays open for the next message. Do not repeat the assignment.",
    };
  }

  const visitedList = (Array.isArray(orch.visited) ? orch.visited : []).map(String);
  const selfProgram = str(task.proxyProgramId || task.agentProgramId || (task.self && task.self.programId));
  if (selfProgram && !visitedList.includes(selfProgram)) visitedList.push(selfProgram);

  const inputs = Array.isArray(args.inputs) ? args.inputs.filter((v) => str(v)).map((v) => str(v)) : [];
  const briefed = [
    objective,
    inputs.length ? `Build on what already exists — do not recreate it: ${inputs.join(", ")}.` : "",
    Array.isArray(args.doneWhen) && args.doneWhen.length
      ? `This is done when: ${args.doneWhen.filter(Boolean).join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { launched, blocked, budgetExhausted } = await launchTeammates(bridge, {
    task,
    teammates: [teammate],
    spaceId,
    threadId: threadIdOf(task),
    prompt: briefed,
    payer: context.payer,
    poolId: context.poolId,
    billingEndpoint: context.billingEndpoint,
    depth,
    maxHops,
    visitedList,
    rootRunId: rootRunIdOf(task),
  });

  if (budgetExhausted && budgetExhausted.length) {
    return {
      ok: true,
      planTaskId: created.planTaskId,
      started: false,
      note:
        "The task is in the plan, but this request has already used its budget of agent turns, so " +
        "it was not started now. It stays open. Do not repeat the assignment.",
    };
  }
  if (!launched || blocked.length) {
    return {
      ok: true,
      planTaskId: created.planTaskId,
      started: false,
      note:
        "The task is in the plan, but the project's autonomous budget or wallet refused the run. " +
        "It stays open for a person to pick up. Do not repeat the assignment.",
    };
  }
  return {
    ok: true,
    planTaskId: created.planTaskId,
    started: true,
    assignedTo: teammate.handle || teammate.name,
    note: `@${teammate.handle || teammate.name} has the task and starts when free. Do not wait for them, and do not send it again.`,
  };
}

/**
 * Run one plan tool. Returns the MCP-friendly `{ ok, … }` the model reads back.
 * Never throws: a plan write that fails is a message to the model, not a dead run.
 */
export async function runPlanTool(bridge, task, name, args = {}) {
  if (!bridge) return { ok: false, error: "the plan needs a live Caspar bridge" };
  const spaceId = spaceIdOf(task);
  if (!spaceId) return { ok: false, error: "this run has no project, so it has no plan" };
  const input = args && typeof args === "object" ? args : {};
  try {
    switch (name) {
      case READ_PLAN_TOOL.name: {
        const plan = await readProjectPlan(bridge, { spaceId, threadId: threadIdOf(task) });
        return { ok: true, ...planPayload(plan) };
      }
      case SET_PLAN_GOAL_TOOL.name:
        return await setPlanGoal(bridge, task, input);
      case ADD_TASK_TOOL.name:
        return await addPlanTask(bridge, task, input);
      case CLAIM_TASK_TOOL.name:
        return await claimPlanTask(bridge, task, input);
      case COMPLETE_TASK_TOOL.name:
        return await completePlanTask(bridge, task, input);
      case ASSIGN_TASK_TOOL.name:
        return await assignTask(bridge, task, input);
      case BLOCK_TASK_TOOL.name:
        return await blockPlanTask(bridge, task, input);
      case REGISTER_ARTIFACT_TOOL.name:
        return await registerArtifact(bridge, task, input);
      default:
        return { ok: false, error: `unknown plan tool ${name}` };
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  }
}
