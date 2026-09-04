/**
 * `send_message` — a platform-owned native tool that lets an agent speak in the
 * project chat WHILE it is still working, instead of only at the end.
 *
 * Until now an agent had exactly one thing it could say per turn: its final
 * answer. Everything before that was a work step — visible in the run's
 * placeholder, but not a message anyone is addressed by. That made a long task
 * silent ("posting the progress note" was never a thing an agent could do) and
 * made handing work over mid-task impossible: the only way to reach a teammate
 * was to end the turn.
 *
 * This tool is the missing channel. One call posts one real chat message from
 * the running agent, as many times as the task needs, and — because a message
 * that @mentions someone is how this platform hands work over — any teammate it
 * names is handed the work right then: the mention becomes a task on that
 * agent's board (`agentQueue.mjs`), which they start as soon as they are free.
 * The sender does not wait for them; that is the whole point of an asynchronous
 * hand-off, and it is why an agent can now say "@researcher start on the market
 * data, I'll keep drafting" without stopping.
 *
 * What it is NOT: the final answer. The run's own answer is still posted by the
 * runtime when the turn ends, and it is still the one writer for that record.
 * Messages sent here are separate turns in the same chat, tagged `kind=answer`
 * with `interim: true` so the app renders them as the agent's chat bubbles in
 * order, exactly where the reader expects them.
 */

import { KIND, postSpaceSignal } from "./spaceHistory.mjs";
import { handOffMentions } from "./orchestrate.mjs";

/** Longest single message. Chat, not a file dump — long output belongs in the answer. */
const MAX_TEXT_CHARS = 8000;

/** The MCP tool definition advertised to the model. */
export const SEND_MESSAGE_TOOL = {
  name: "send_message",
  description:
    "Post a message into this project's chat RIGHT NOW, without ending your turn. " +
    "Use it to tell the team something while you work — progress on a long task, a " +
    "partial finding, a question for a person — and to hand work to a teammate mid-task " +
    "by @mentioning them in the message: they are queued to start on it immediately " +
    "while you carry on. You may call this several times in one turn. It is NOT your " +
    "final answer: whatever you return at the end of the turn is still posted as that.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The message, exactly as it should appear in the chat. @mention a handle " +
          "(e.g. @some-agent) to address someone; mentioning a teammate hands them the work.",
      },
      mention: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional handles to address in addition to any already written in `text` " +
          "(with or without the leading @). They are appended to the message.",
      },
    },
    required: ["text"],
  },
};

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** `["@a", "b"]` → the handles not already written into the text. */
function extraMentionSuffix(text, mention) {
  const list = Array.isArray(mention) ? mention : [];
  const body = String(text || "");
  const missing = [];
  for (const raw of list) {
    const handle = str(raw).replace(/^@+/, "");
    if (!handle) continue;
    const already = new RegExp(`(^|[^a-z0-9_-])@${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (already.test(body) || missing.includes(handle)) continue;
    missing.push(handle);
  }
  return missing.length ? ` ${missing.map((h) => `@${h}`).join(" ")}` : "";
}

/**
 * Send one message from the running agent.
 *
 * Returns the MCP-friendly `{ ok, ... }` the model reads back: what was posted,
 * and — because an agent that mistyped a handle must be told rather than left
 * assuming a teammate is on it — exactly who was handed the work and who could
 * not be resolved.
 */
export async function sendAgentMessage(bridge, task, args, { log } = {}) {
  const say = typeof log === "function" ? log : () => {};
  if (!bridge) return { ok: false, error: "sending a message needs a live Caspar bridge" };
  const spaceId = str(task?.spaceId || task?.storeId || task?.space_id);
  if (!spaceId) return { ok: false, error: "this run has no project chat to post into" };

  const body = str(args?.text);
  if (!body) return { ok: false, error: "text is required" };
  const text = `${body}${extraMentionSuffix(body, args?.mention)}`.slice(0, MAX_TEXT_CHARS);

  const threadId = str(task?.threadId || task?.thread_id) || "main";
  const correlationId = str(task?.correlationId);
  const self = task?.self && typeof task.self === "object" ? task.self : {};
  const agentProgramId = str(task?.proxyProgramId || task?.agentProgramId || self.programId);
  const agentName = str(self.name || task?.agentName);

  // Hand the work over FIRST, so the teammates named in the message are resolved
  // and the message can name them accurately as `mentions` — one record that says
  // both what was said and who it actually reached.
  let handOff = { launched: [], blocked: [], unknown: [] };
  try {
    handOff = await handOffMentions(bridge, task, text);
  } catch (err) {
    say({ send_message_handoff_error: String(err?.message || err).slice(0, 200) });
  }
  const mentions = (handOff.launched || []).map((t) => ({
    programId: t.programId,
    name: t.name,
    handle: t.handle,
    kind: "agent",
  }));

  try {
    await postSpaceSignal(bridge, {
      spaceId,
      // An interim message is a chat turn — the reader sees it as the agent
      // speaking — so it rides the same kind the chat renders. `interim` marks it
      // as not-the-final-answer for anything that cares (the run's own answer is
      // still written once, by the runtime, when the turn ends).
      kind: KIND.ANSWER,
      threadId,
      agentProgramId,
      correlationId,
      mentions,
      data: {
        text,
        from: "agent",
        role: "agent",
        interim: true,
        runId: correlationId,
        at: new Date().toISOString(),
        ...(agentName ? { agentName } : {}),
        ...(agentProgramId ? { agentProgramId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(mentions.length ? { mentions } : {}),
      },
    });
  } catch (err) {
    return { ok: false, error: `the project did not record the message: ${String(err?.message || err).slice(0, 200)}` };
  }

  const handed = mentions.map((m) => m.handle || m.name || m.programId).filter(Boolean);
  const notes = [];
  if (handed.length) {
    notes.push(
      `Queued for ${handed.map((h) => `@${String(h).replace(/^@/, "")}`).join(", ")} — ` +
        "they will pick it up when free. Do not wait for them; carry on.",
    );
  }
  if (handOff.unknown?.length) {
    notes.push(`No agent in this project answers to ${handOff.unknown.map((h) => `@${h}`).join(", ")}.`);
  }
  if (handOff.blocked?.length) {
    notes.push(
      `Could not start ${handOff.blocked.map((t) => `@${t.handle || t.name}`).join(", ")} — ` +
        "the project's autonomous budget or wallet refused the run.",
    );
  }
  if (handOff.hopCapped) notes.push("This chain reached its hop limit, so no teammate was started.");
  if (handOff.noBilling) notes.push("No billing context on this run, so no teammate could be started.");

  say({ send_message: { spaceId, threadId, chars: text.length, handedTo: handed.length } });
  return {
    ok: true,
    posted: true,
    message: "Message posted to the project chat.",
    handedTo: handed,
    ...(handOff.unknown?.length ? { unknownHandles: handOff.unknown } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
