/**
 * Pre-warm the space's tool + agent containers.
 *
 * Every tool and sub-agent the model can reach runs in its OWN docker container
 * that the Caspar node COLD-SPAWNS on first use. Under gVisor that routinely
 * takes >1 min (see `toolInvoker.mjs`), and the sandbox additionally creates its
 * micro-VM lazily on the first `exec`/`read`. So the first time an agent reaches
 * for a tool the run appears to freeze for minutes — then continues the instant
 * the container answers. We hide that latency by kicking the spawns off at run
 * start, in the background, while the model is still reading history and
 * planning its first move.
 *
 * Warming is best-effort and side-effect-free:
 *   - the sandbox is warmed with `start`, which boots its container AND
 *     creates/resumes the VM — exactly what the first bash/read would otherwise
 *     block on;
 *   - every other target is warmed with a reserved no-op function. Merely
 *     reaching the machine makes the node spawn the container; the function does
 *     no real work. A plain tool replies "unknown function" (cheap), and a
 *     grok/davinci agent proxy sees a signal with no `objective`/`prompt`/`skill`
 *     and no `kind:"task"`, so `decodeTaskSignal` drops it — warming a sub-agent
 *     spawns its backbone container but never starts an LLM run.
 *
 * Fire-and-forget: the invocations are never awaited on the run's critical path,
 * and a failure never touches the run. Targets are de-duplicated so a space with
 * several agents that share one backbone machine is warmed once per machine.
 */

import { creatureFlag } from "./env.mjs";

/** The reserved warm function — recognised by nothing, which is the point. */
export const WARM_FUNCTION = "__caspar_warm__";

/** Resolve the machine a catalog entry routes to (the cold-spawn target). */
function targetOf(entry) {
  return (
    entry.program_id ||
    entry.programId ||
    entry.machine_id ||
    entry.tool_id ||
    entry.creature_id ||
    ""
  );
}

/**
 * Kick off a background spawn of every attached tool/agent container.
 *
 * @param invoker         a live `ToolInvoker` (null → no-op)
 * @param toolDefs        the installed catalog (`lastToolDefs`)
 * @param byName          MCP name → catalog entry
 * @param opts.sandboxToolName  the sandbox tool's MCP name (warmed via `start`)
 * @param opts.log        `(info) => void` for a `GROK_PREWARM` trace line
 * @param opts.env        env (for the `GROK_CREATURE_PREWARM_TOOLS` flag)
 * @returns the list of `{ tool, function }` warms actually fired (for logging/tests)
 */
export function prewarmToolContainers(invoker, toolDefs, byName, opts = {}) {
  const { sandboxToolName = null, log = () => {}, env = process.env } = opts;
  if (!invoker) return [];
  // Master switch: `GROK_CREATURE_PREWARM_TOOLS=0` turns pre-warming off.
  if (!creatureFlag("PREWARM_TOOLS", true, env)) return [];

  const seen = new Set();
  const fired = [];
  for (const def of toolDefs || []) {
    const entry = byName?.get(def.name) || {};
    // Frontends are UI surfaces with no server-side container to warm.
    if (entry.kind === "frontend") continue;
    // In-process platform tools (media) have no machine — nothing to spawn.
    const target = targetOf(entry);
    if (!target || seen.has(target)) continue;
    seen.add(target);

    const fn = def.name === sandboxToolName ? "start" : WARM_FUNCTION;
    fired.push({ tool: def.name, function: fn });
    // Fire-and-forget: `invoke` never throws (it returns `{ok:false,…}`), so a
    // swallowed settle is enough. We do not await — the whole point is to let
    // the spawn happen alongside the model's first turn.
    Promise.resolve(invoker.invoke(def.name, { function: fn })).then(
      (res) => log({ tool: def.name, function: fn, ok: res?.ok !== false }),
      () => {},
    );
  }
  if (fired.length) log({ warming: fired.length, targets: [...seen].length });
  return fired;
}
