/**
 * The platform's UNIVERSAL system instruction.
 *
 * An admin sets one text prompt in the Decillion admin panel (Settings →
 * Universal agent instructions). It is stored on-chain by the `settings`
 * creature and applies to EVERY agent on the platform: this backbone reads it
 * here, once per run, and `buildSystemPrompt` concatenates it with the agent's
 * own system instruction (its deployed skill/persona) before the run starts.
 *
 * Read at EXECUTION time on purpose. Baking it into an agent at deploy would
 * mean editing the platform prompt only reached agents deployed afterwards;
 * reading it per run means an admin edit applies to every agent's very next
 * turn, with no redeploy of anything.
 *
 * The prompt lives at its own path (`universalPrompt`) in the settings document
 * — never inside `config`, which also holds the platform provider keys — so this
 * read can only ever return the instruction text.
 */

import { creatureFlag, creatureNumber } from "./env.mjs";

const SETTINGS_KEY = "Json::CreatureNamespace::settings";
const SETTINGS_PATH = "universalPrompt";

/** Mirrors the creature's own cap, so a corrupt document can't flood a prompt. */
export const UNIVERSAL_INSTRUCTION_MAX_CHARS = 20000;

/** Cached between runs for a short window: an admin edit lands within it, and a
 * burst of parallel agent runs does not become a burst of identical KV reads. */
let cached = { text: "", at: 0 };

/** Test seam / redeploy safety: drop the cache. */
export function resetUniversalInstructionCache() {
  cached = { text: "", at: 0 };
}

function textFrom(response) {
  let data = response && typeof response === "object" ? response.data : null;
  // getJson answers `{ok, data}`; some transports nest one wrapper deeper.
  if (data && typeof data === "object" && typeof data.text !== "string" && data.data && typeof data.data === "object") {
    data = data.data;
  }
  const text = data && typeof data === "object" ? data.text : null;
  if (typeof text !== "string") return "";
  return text.trim().slice(0, UNIVERSAL_INSTRUCTION_MAX_CHARS);
}

/**
 * The universal instruction for this run, or "" when the admin has set none
 * (the platform default) — also on any read failure, because a transient node
 * read must never stop an agent from answering.
 */
export async function readUniversalInstruction(bridge, { timeoutMs, now = Date.now() } = {}) {
  if (!creatureFlag("UNIVERSAL_INSTRUCTION", true)) return "";
  if (!bridge || typeof bridge.call !== "function") return "";
  const ttlMs = Math.max(0, creatureNumber("UNIVERSAL_INSTRUCTION_TTL_MS", 30000));
  if (cached.at && now - cached.at < ttlMs) return cached.text;
  try {
    const response = await bridge.call(
      "getJson",
      { key: SETTINGS_KEY, path: SETTINGS_PATH },
      { timeoutMs: timeoutMs || creatureNumber("UNIVERSAL_INSTRUCTION_TIMEOUT_MS", 5000) },
    );
    cached = { text: textFrom(response), at: now };
  } catch {
    // Keep whatever we last read (possibly ""), and retry on the next run
    // rather than pinning a stale value for the full TTL.
    cached = { text: cached.text, at: 0 };
  }
  return cached.text;
}
