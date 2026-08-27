/**
 * `schedule_routine` — a platform-owned native tool that lets an agent schedule
 * its OWN follow-up work in the space it is answering in.
 *
 * When the user asks an agent to do something later (a delay) or on a recurring
 * cadence (a repeat), the agent calls this tool. The backbone signals the
 * decillion `routines/manage` creature to create a routine with the running
 * agent set as the responsible agent and the requesting user as the owner. At
 * the scheduled time the routines creature emits the prompt into this space
 * @mentioning the agent — no client needs to be open for the routine to fire,
 * and the agent runs it like any other mention.
 *
 * This mirrors the creature-to-creature signalling `spaceHistory.mjs` uses: a
 * `StoresSend` packet pushed on `creatures/signal`, with the reply awaited on
 * `creatures/signal` (the routines creature dual-emits its result there so a
 * docker creature — this backbone — can read it).
 */
import crypto from "node:crypto";

const CREATE_TIMEOUT_MS = 12000;

/** The MCP tool definition advertised to the model. */
export const SCHEDULE_ROUTINE_TOOL = {
  name: "schedule_routine",
  description:
    "Schedule your OWN follow-up work in this project for later. Use this whenever the " +
    "user asks you to do something after a delay or on a recurring cadence (e.g. \"remind " +
    "me in an hour\", \"every morning post a digest\", \"check the deploy in 30 minutes\"). " +
    "You become the responsible agent: at the scheduled time the platform posts `prompt` " +
    "into this chat mentioning you, and you run it. Do NOT use this for work to do right now.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "What you should do each time this runs, written as an instruction to yourself.",
      },
      schedule: {
        type: "string",
        enum: ["once", "repeat"],
        description:
          '"once" runs a single time after the delay; "repeat" runs every interval.',
      },
      minutes: {
        type: "number",
        description:
          'Minutes. For "once": how long from now until it runs. For "repeat": the ' +
          "interval between runs. Minimum 1.",
      },
      title: {
        type: "string",
        description: "Short human-readable name for this routine (optional).",
      },
    },
    required: ["prompt", "schedule", "minutes"],
  },
};

/** The `routines/manage` endpoint address the client put on the task. */
export function routinesEndpointFromTask(task) {
  const raw = task && typeof task === "object" ? task.routinesEndpoint || task.routines_endpoint : null;
  if (!raw || typeof raw !== "object") return null;
  const programId = String(raw.programId || raw.program_id || "").trim();
  if (!programId) return null;
  return {
    programId,
    creatureId: String(raw.creatureId || raw.creature_id || "").trim(),
    entityId: String(raw.entityId || raw.entity_id || "main").trim() || "main",
  };
}

function toMentionHandle(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/**
 * Create a routine on behalf of the running agent. Returns an MCP-friendly
 * `{ ok, ... }` object describing the outcome for the model.
 */
export async function scheduleRoutine(bridge, task, ownerUserId, args, { log } = {}) {
  const say = typeof log === "function" ? log : () => {};
  if (!bridge) return { ok: false, error: "scheduling needs a live Caspar bridge" };
  const endpoint = routinesEndpointFromTask(task);
  if (!endpoint) return { ok: false, error: "this space has no routines endpoint configured" };

  const spaceId = String(task.spaceId || task.storeId || task.space_id || "").trim();
  if (!spaceId) return { ok: false, error: "no space to schedule in" };
  const owner = String(ownerUserId || task.streamTo || "").trim();
  if (!owner) return { ok: false, error: "no owner to bill scheduled runs to" };

  const prompt = String(args?.prompt || "").trim();
  if (!prompt) return { ok: false, error: "prompt is required" };
  const schedule = String(args?.schedule || "").trim().toLowerCase();
  const mode = schedule === "repeat" || schedule === "loop" ? "loop" : "delay";
  const minutes = Number(args?.minutes);
  if (!Number.isFinite(minutes) || minutes < 1) {
    return { ok: false, error: "minutes must be a number >= 1" };
  }
  const seconds = Math.round(minutes * 60);

  const self = task.self && typeof task.self === "object" ? task.self : {};
  const agentProgramId = String(task.agentProgramId || self.id || "").trim();
  const agentName = String(self.name || "").trim();
  const handle = String(self.handle || "").trim() || toMentionHandle(agentName);
  const mention = handle ? `@${handle}` : "";
  const threadId = String(task.threadId || "main").trim() || "main";
  const schedulerProgramId = String(task.schedulerProgramId || endpoint.programId || "").trim();

  const payload = {
    action: "create",
    schedulerProgramId,
    spaceId,
    threadId,
    ownerUserId: owner,
    title: String(args?.title || "").trim(),
    prompt,
    mode,
    ...(mode === "loop" ? { intervalSeconds: Math.max(60, seconds) } : { delaySeconds: seconds }),
    ...(agentProgramId ? { agentProgramId } : {}),
    ...(agentName ? { agentName } : {}),
    ...(mention ? { mention } : {}),
  };

  const correlationId = crypto.randomBytes(16).toString("hex");
  const selfId = bridge.machineId || bridge.programId || "";
  const inner = JSON.stringify({ action: "create", correlationId, payload });
  const packet = {
    action: "single",
    user: { id: String(selfId) },
    store: { id: spaceId },
    data: JSON.stringify({ programId: endpoint.programId, entity: endpoint.entityId, payload: inner }),
    entityId: endpoint.entityId,
    correlationId,
  };

  let unsub = null;
  const settled = new Promise((resolve) => {
    unsub = bridge.onSignal((key, raw) => {
      if (key !== "creatures/signal" && key !== "creatures/signal/result") return;
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
      if (pkt.namespace !== undefined && pkt.namespace !== "routines") return;
      resolve(pkt);
    });
  });

  try {
    await bridge.signalUser("creatures/signal", endpoint.programId, packet);
  } catch (err) {
    if (unsub) unsub();
    return { ok: false, error: `could not reach the scheduler: ${err?.message || err}` };
  }

  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), CREATE_TIMEOUT_MS);
  });
  let reply;
  try {
    reply = await Promise.race([settled, timedOut]);
  } finally {
    clearTimeout(timer);
    if (unsub) unsub();
  }

  const when =
    mode === "loop"
      ? `every ${Math.max(1, Math.round(seconds / 60))} min`
      : `in ${Math.max(1, Math.round(seconds / 60))} min`;
  if (!reply) {
    // Fire-and-forget fallback: the creature is idempotent enough that a missed
    // ack does not mean it failed, but report the uncertainty honestly.
    say("SCHEDULE_ROUTINE", { spaceId, mode, seconds, ack: false });
    return { ok: true, scheduled: true, mode, when, note: "submitted (no confirmation received)" };
  }
  if (reply.ok === false) {
    return { ok: false, error: String(reply.error || "the scheduler rejected this routine") };
  }
  say("SCHEDULE_ROUTINE", { spaceId, mode, seconds, ack: true, id: reply?.id });
  return {
    ok: true,
    scheduled: true,
    mode,
    when,
    routineId: reply?.id || reply?.routine?.id,
  };
}
