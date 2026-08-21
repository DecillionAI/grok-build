/**
 * The space's tool catalog, expressed as MCP tools.
 *
 * The Decillion backend sends `config.tools` with every prompt: one entry per
 * creature the space's agents may employ (the project's cloud sandbox, published
 * tools, sub-agents). Each entry carries the routing ids needed to *signal* that
 * creature (`program_id`, `entity_id`, `creature_id`), its input schema
 * (`arg_schema` + `required`), its default routing `function`, and — crucially —
 * `defaults`: arguments the platform pins onto every call (e.g. the space id a
 * per-space tool is bound to).
 *
 * We surface each entry to Grok as an MCP tool so the model can call it
 * with real argument names, and execute the call by signalling the creature over
 * the gateway (see `toolInvoker.mjs`). Pinned `defaults` are applied AFTER the
 * model's own arguments, so an agent can neither forget the binding nor point a
 * tool at another space's resources by naming a different id.
 */

/** MCP tool names must be stable, unique and free of protocol-hostile characters. */
export function mcpToolName(entry, taken = new Set()) {
  const raw = String(entry.name || entry.tool_id || entry.toolId || "tool");
  let base = raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!base) base = "tool";
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}_${n++}`;
  }
  taken.add(name);
  return name;
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

/** Normalise a catalog `arg_schema` into a JSON-Schema `properties` map. */
function properties(entry) {
  const argSchema = entry.arg_schema || entry.argSchema || {};
  const props = {};
  for (const [name, spec] of Object.entries(argSchema)) {
    if (!name) continue;
    const raw = spec && typeof spec === "object" ? spec : {};
    const type = SCHEMA_TYPES.has(String(raw.type || "").toLowerCase()) ? String(raw.type).toLowerCase() : "string";
    props[name] = { type, description: String(raw.description || raw.desc || "") };
    if (Array.isArray(raw.enum) && raw.enum.length) props[name].enum = raw.enum;
  }
  return props;
}

/**
 * Enumerate the operations a multi-function creature (per-space sandbox:
 * exec/write/read/…, github: clone/commit/push/…) accepts. Historical entries
 * only carried the *default* function so the model had to guess the rest and
 * routinely tried `use_tool("caspar__sandbox_exec", …)` — a compound
 * tool name that does not exist — which came back as "no such tool" and the
 * model paraphrased as "doesn't have access to that action". Sources, in
 * priority order (most explicit first):
 *
 *   1. `entry.functions` — an explicit list, already respected upstream.
 *   2. `entry.arg_schema.function.enum` — the standard JSON-Schema way to
 *      declare it.
 *   3. `entry.tools[].name` — every checked-in creature descriptor lists its
 *      operations in a `tools[]` array (see e.g. the sandbox / github
 *      `point.metadata.json`); this is the source of truth today.
 *   4. Parse `entry.arg_schema.function.description` for the pattern
 *      "`exec` (default) | `write` | `read`" — the human-readable form the
 *      descriptors already use as a fallback for older ones.
 */
export function extractFunctions(entry) {
  if (!entry || typeof entry !== "object") return [];
  const push = (list, arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === "string" && item.trim() && !list.includes(item.trim())) list.push(item.trim());
    }
  };
  const out = [];
  push(out, entry.functions);
  const schema = entry.arg_schema && typeof entry.arg_schema === "object" ? entry.arg_schema : entry.argSchema;
  push(out, schema?.function?.enum);
  push(
    out,
    Array.isArray(entry.tools)
      ? entry.tools.map((t) => (t && typeof t === "object" ? t.name || t.function : null))
      : null,
  );
  const desc = String(schema?.function?.description || "");
  if (desc && !out.length) {
    // Match `word` (possibly with a "(default)" tag) inside the pipe-separated
    // operation list the descriptors use, e.g.
    //   "operation: exec (default) | write | read | …"
    // Also accept bareword pipes without backticks for looser descriptors.
    const inside = desc.replace(/`([^`]+)`/g, "$1");
    const parts = inside.split(/[|,]/);
    for (const raw of parts) {
      const cleaned = raw
        .replace(/\(default\)/gi, "")
        .replace(/^[^A-Za-z0-9_]*/, "")
        .replace(/[^A-Za-z0-9_]*$/, "");
      // Skip narrative prefixes like "operation: exec" — keep only the word.
      const token = cleaned.split(/[\s:]+/).pop();
      if (token && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(token) && !out.includes(token)) {
        out.push(token);
      }
    }
  }
  return out;
}

/**
 * A multi-function creature (the per-space sandbox: exec/write/read/…) is one
 * catalog entry whose function comes from the model's arguments. Expose that
 * explicitly so the model can pick a function instead of guessing.
 */
function withFunctionArg(props, entry) {
  const functions = extractFunctions(entry);
  if (!functions.length || props.function) return props;
  return {
    ...props,
    function: {
      type: "string",
      description: `Which operation of this creature to run (default "${entry.function || "invoke"}")`,
      enum: functions,
    },
  };
}

/** Describe a catalog entry for the model: what it is and how to talk to it. */
function describe(entry) {
  const bits = [];
  if (entry.description) bits.push(String(entry.description));
  if (entry.kind === "agent") bits.push("This is another agent — talk to it in prose.");
  if (entry.category) bits.push(`Category: ${entry.category}.`);
  if (entry.risk) bits.push(`Risk: ${entry.risk}.`);
  const pinned = entry.defaults && typeof entry.defaults === "object" ? Object.keys(entry.defaults) : [];
  if (pinned.length) bits.push(`The platform pins ${pinned.join(", ")} for you — do not pass them.`);
  return bits.join(" ") || String(entry.name || entry.tool_id || "creature");
}

/**
 * Build the MCP tool definitions for a catalog, plus the name → entry map the
 * invoker needs. Entries with no routable target are dropped: handing a live
 * agent a tool that cannot be reached only produces confident failures.
 *
 * Other AGENTS are never exposed as callable tools. An agent reaches a teammate
 * only by @mentioning them in its chat reply — an asynchronous hand-off the
 * Decillion app turns into a fresh run for that teammate (see the group-chat
 * preamble in `prompt.mjs`). Offering a synchronous "call another agent like a
 * tool" is what made an agent block on a nested run and hang mid-flow, so agent
 * entries are filtered out here at the one point every caller (MCP tools, the
 * invoker's `byName` router, and the capabilities preamble) reads from.
 */
export function buildToolDefinitions(catalog) {
  const tools = [];
  const byName = new Map();
  const taken = new Set();
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry !== "object") continue;
    // Agents are participants, not tools: they collaborate over @mention in the
    // chat, never through a synchronous tool call. Keep them out of the callable
    // surface entirely.
    if (entry.kind === "agent") continue;
    const target = entry.program_id || entry.programId || entry.machine_id || entry.tool_id || entry.creature_id || "";
    if (!target) continue;
    const name = mcpToolName(entry, taken);
    const props = withFunctionArg(properties(entry), entry);
    const required = Array.isArray(entry.required) ? entry.required.filter((r) => r in props) : Object.keys(props).filter((k) => k !== "function");
    tools.push({
      name,
      description: describe(entry),
      inputSchema: { type: "object", properties: props, required },
    });
    byName.set(name, entry);
  }
  return { tools, byName };
}

/**
 * Union two catalogs, keyed by the creature's routing id. `primary`
 * (`config.tools` from the backend) is authoritative and always kept — it
 * carries the platform-pinned `defaults` (e.g. the bound `space_id`) that
 * live-discovered entries cannot know. `extra` (from `discovery.mjs`) only
 * contributes creatures the primary did not already list, so an agent sees the
 * space's full roster without ever losing a binding.
 */
export function mergeCatalogs(primary, extra) {
  const keyOf = (e) => String(e?.program_id || e?.programId || e?.tool_id || e?.creature_id || e?.creatureId || e?.name || "");
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(primary) ? primary : []) {
    if (!entry || typeof entry !== "object") continue;
    const key = keyOf(entry);
    if (key) seen.add(key);
    out.push(entry);
  }
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (!entry || typeof entry !== "object") continue;
    const key = keyOf(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The arguments actually sent to a creature: the model's, with the platform's
 * pinned `defaults` applied on top (they win by design), and nulls dropped.
 */
export function mergeArgs(entry, args) {
  const payload = {};
  for (const [k, v] of Object.entries(args && typeof args === "object" ? args : {})) {
    if (v !== null && v !== undefined) payload[k] = v;
  }
  const defaults = entry.defaults && typeof entry.defaults === "object" ? entry.defaults : {};
  for (const [k, v] of Object.entries(defaults)) {
    if (v !== null && v !== undefined) payload[k] = v;
  }
  return payload;
}
