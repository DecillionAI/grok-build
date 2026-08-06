/**
 * Creature environment knobs.
 *
 * Every runtime knob of this creature is `GROK_CREATURE_*`. The backbone this
 * creature replaced (the Claude Code creature, and davinci before it) used
 * `CLAUDE_CREATURE_*`, and a deployed host may still have those baked into an
 * older image or exported by an older CI — so each name falls back to the legacy
 * spelling rather than silently reverting to a default. Nothing else in the tree
 * reads `process.env` for a creature knob; it all goes through here.
 */

/** `GROK_CREATURE_MODEL` → also accepts the legacy `CLAUDE_CREATURE_MODEL`. */
export function creatureEnv(name, env = process.env) {
  const primary = env[`GROK_CREATURE_${name}`];
  if (primary !== undefined && String(primary).trim() !== "") return primary;
  const legacy = env[`CLAUDE_CREATURE_${name}`];
  if (legacy !== undefined && String(legacy).trim() !== "") return legacy;
  // An explicitly-empty value is meaningful for some knobs (e.g. USER=""), so it
  // is returned as-is once we know neither name carries content.
  if (primary !== undefined) return primary;
  return legacy;
}

/** A boolean knob: unset/empty → `fallback`; `0|false|no|off` → false. */
export function creatureFlag(name, fallback, env = process.env) {
  const raw = creatureEnv(name, env);
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

/** A numeric knob, with a fallback for unset/unparseable values. */
export function creatureNumber(name, fallback, env = process.env) {
  const raw = creatureEnv(name, env);
  const value = Number(raw);
  return Number.isFinite(value) && String(raw ?? "").trim() !== "" ? value : fallback;
}

/** A comma-separated list knob; empty when unset. */
export function creatureList(name, env = process.env) {
  const raw = creatureEnv(name, env);
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
