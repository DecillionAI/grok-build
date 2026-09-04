/**
 * "Which of my waiting tasks should I do next?" — asked of the agent's own model.
 *
 * When an agent finishes a task and more than one is still on its board, the
 * ordering is a judgement call, not a queue discipline: a blocking review should
 * jump ahead of a nice-to-have, and only something that has read the work can
 * say so. So the backbone hands the agent's model the TITLES of everything
 * waiting and asks it to pick one, then runs that task.
 *
 * The call is deliberately tiny — titles in, one number out, no tools, a small
 * token ceiling — because it happens between tasks and must not cost anything
 * like a turn. It runs on the agent's own provider (`config.llm`, remembered
 * from its last run) so an agent that brought its own key keeps using it, and
 * falls back to the creature's configured backbone otherwise.
 *
 * Every failure — no key, a refusal, a timeout, an unparseable answer — falls
 * back to the oldest waiting task. A queue that cannot ask is still a queue that
 * drains; it just drains in order.
 */

import { creatureEnv, creatureNumber } from "./env.mjs";
import { defaultLlm, platformKeyFor } from "./grokRunner.mjs";
import { resolveProvider } from "./llm/providers.mjs";

const CHOICE_TIMEOUT_MS = creatureNumber("TASK_CHOICE_TIMEOUT_MS", 20_000);
/** How many waiting titles are offered at once. Beyond this the oldest win — a
 * board that deep is a scheduling problem no prompt is going to fix. */
const MAX_CHOICES = 24;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstModel(llm) {
  if (!llm || typeof llm !== "object") return "";
  if (Array.isArray(llm.models)) {
    const found = llm.models.find((m) => typeof m === "string" && m.trim());
    if (found) return found.trim();
  }
  return clean(llm.model);
}

/**
 * The endpoint, credential and model this choice runs on: the agent's own LLM
 * config when it has one, else whatever the deploy configured as the default
 * backbone. Returns null when nothing usable is configured — the caller then
 * takes the oldest task.
 */
export function resolveChoiceRoute(llm, env = process.env) {
  const candidates = [llm, defaultLlm(env)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const providerId = clean(candidate.provider) || "xai";
    const descriptor = resolveProvider(providerId, {
      env,
      baseUrlOverride: clean(candidate.base_url || candidate.baseUrl),
      apiBackend: clean(candidate.api_backend || candidate.apiBackend),
    });
    if (!descriptor?.baseUrl) continue;
    const key = clean(candidate.api_key || candidate.apiKey) || platformKeyFor(descriptor.id, env);
    const model = firstModel(candidate) || clean(creatureEnv(`TASK_CHOICE_MODEL_${descriptor.id.toUpperCase()}`, env));
    if (!key || !model) continue;
    return { descriptor, key, model };
  }
  return null;
}

/** The prompt the model answers: the agent, its board, and the one thing to say back. */
export function buildChoicePrompt(agentName, tasks) {
  const lines = tasks.map((t, i) => {
    const who = clean(t.requestedByName) || clean(t.origin);
    const from = who ? ` [from ${who}]` : "";
    return `${i + 1}. ${clean(t.title) || "Untitled task"}${from}`;
  });
  return (
    `You are ${clean(agentName) || "an agent"} working in a shared project. You just finished a task and ` +
    "these tasks are waiting in your queue:\n\n" +
    `${lines.join("\n")}\n\n` +
    "Pick the ONE you should work on next — the one that unblocks the most other work, " +
    "or that someone is waiting on, or that is plainly the most urgent. Prefer earlier " +
    "items when nothing distinguishes them.\n" +
    "Answer with only the number of your choice and nothing else."
  );
}

/** Read a 1-based index out of whatever the model actually said. */
export function parseChoiceIndex(text, count) {
  const match = String(text || "").match(/-?\d+/);
  if (!match) return -1;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n < 1 || n > count) return -1;
  return n - 1;
}

/**
 * One completion, in whichever wire protocol the provider speaks.
 *
 * Exported because the acceptance check (`acceptance.mjs`) asks the same kind of
 * tiny question on the same route — "is this project finished?" — and two copies
 * of provider-shape handling is one too many.
 */
export async function completeOnce(route, prompt, { timeoutMs, fetchImpl, maxTokens = 16 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("no fetch available");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { descriptor, key, model } = route;
    const base = descriptor.baseUrl.replace(/\/+$/, "");
    const headers = { "content-type": "application/json", ...(descriptor.headers || {}) };
    if (descriptor.authScheme === "x_api_key") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;

    let url;
    let body;
    if (descriptor.apiBackend === "messages") {
      url = `${base}/messages`;
      body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
    } else if (descriptor.apiBackend === "responses") {
      url = `${base}/responses`;
      body = { model, max_output_tokens: maxTokens, input: prompt };
    } else {
      url = `${base}/chat/completions`;
      body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
    }
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${String(res.statusText || "").slice(0, 60)}`);
    const json = await res.json();
    return extractText(json);
  } finally {
    clearTimeout(timer);
  }
}

/** The assistant's text, across the three response shapes. */
export function extractText(json) {
  if (!json || typeof json !== "object") return "";
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const chatText = choice?.message?.content ?? choice?.text;
  if (typeof chatText === "string" && chatText.trim()) return chatText;
  const blocks = Array.isArray(json.content) ? json.content : Array.isArray(json.output) ? json.output : [];
  for (const block of blocks) {
    if (typeof block?.text === "string" && block.text.trim()) return block.text;
    const nested = Array.isArray(block?.content) ? block.content : [];
    for (const inner of nested) {
      if (typeof inner?.text === "string" && inner.text.trim()) return inner.text;
    }
  }
  return "";
}

/**
 * Ask the agent which waiting task to run next. Returns the chosen task record,
 * or the oldest one whenever the model cannot be asked or does not answer with a
 * usable choice.
 */
export async function chooseNextTask({ llm, agentName, tasks, env = process.env, log, fetchImpl, timeoutMs = CHOICE_TIMEOUT_MS } = {}) {
  const waiting = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  if (!waiting.length) return null;
  if (waiting.length === 1) return waiting[0];
  const say = typeof log === "function" ? log : () => {};
  const offered = waiting.slice(0, MAX_CHOICES);

  const route = resolveChoiceRoute(llm, env);
  if (!route) {
    say({ pick: "oldest", reason: "no llm route configured for this agent" });
    return waiting[0];
  }
  try {
    const text = await completeOnce(route, buildChoicePrompt(agentName, offered), { timeoutMs, fetchImpl });
    const index = parseChoiceIndex(text, offered.length);
    if (index < 0) {
      say({ pick: "oldest", reason: "unparseable choice", provider: route.descriptor.id, said: String(text).slice(0, 80) });
      return waiting[0];
    }
    say({ pick: offered[index].taskId, index: index + 1, of: offered.length, provider: route.descriptor.id });
    return offered[index];
  } catch (err) {
    say({ pick: "oldest", reason: String(err?.message || err).slice(0, 160), provider: route.descriptor.id });
    return waiting[0];
  }
}
