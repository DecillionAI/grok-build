/**
 * Live in-space discovery: what tools, apps, creatures and sub-agents does this
 * space contain, fetched from the node **at prompt time**.
 *
 * The Decillion backend already sends a `config.tools` catalog with each prompt
 * (its `DiscoveryService`: the space's member programs, each paired with the
 * creature's `public.decillion` descriptor metadata). This module lets the
 * creature fetch that same set itself, directly over the gateway, so it is not
 * blind when the backend sends a thin catalog and so the model always sees the
 * space's live roster of employable creatures — the user asked for the agent to
 * "see all the tools, agents and creatures in the space by first fetching their
 * list each time it is prompted."
 *
 * It mirrors `DiscoveryService.catalogForSpace`, but from inside the container
 * using the node's unified host functions (see the node's `vm_host_functions.rs`,
 * reachable from a docker creature via the gateway):
 *
 *   1. `getJson` on `Json::StoreProgramIndex::<space>` → the space's attached
 *      **programs**, each carrying its routing ids, its descriptor and the
 *      platform-pinned `defaults` (the bound `space_id`) inline. This is where a
 *      space's tools + sub-agents actually live — a platform tool (the sandbox,
 *      the github tool) is attached as a *program*, **never a store member**, so
 *      the earlier members-only scan found none of them (the bug this fixes: the
 *      agent "could not see the tools in the space"). Same record Nest's
 *      `listSpacePrograms` reads.
 *   2. `readMembers` + `getCreature` per member → a supplement for creatures
 *      attached the older way, and a full fallback when the index is unavailable.
 *      The creature's `public.decillion` block is the descriptor (usecases,
 *      how-to-talk, arg schema, kind: tool | agent | frontend).
 *
 * Everything here is **best-effort and defensive**: a space id it cannot resolve,
 * a host op the node does not expose, or an unexpected response shape all yield
 * an empty list — never an exception and never a broken prompt. The result is
 * *merged into* `config.tools` (which stays authoritative, because it carries the
 * platform-pinned `defaults` such as the bound `space_id`); discovery only adds
 * creatures the backend did not already send. See `catalog.mergeCatalogs`.
 */

import { creatureEnv } from "./env.mjs";

/**
 * Every id that identifies the *calling* agent, so discovery never lists the agent
 * to itself. An agent is a proxy entity in the space, so its own program shows up
 * in the program index like any other; handing it back as an employable "tool"
 * makes the model call itself — and invoking an agent proxy over the tool protocol
 * never yields a `tools/result`, so the run hangs until the tool timeout. The
 * backend's `catalogForSpace` avoids this with `excludeProgramId`; we mirror it
 * with every id spelling the signal carries for "me": the proxy program the signal
 * was sent to, this agent's resource id (`self.id`), and the backbone's own ids.
 */
function selfIds(task, bridge) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  };
  add(task?.proxyProgramId);
  add(task?.proxy_program_id);
  add(task?.self?.id);
  add(task?.self?.resourceId);
  add(task?.resourceId);
  add(task?.agentId);
  add(task?.targetAgentId);
  add(bridge?.programId);
  add(bridge?.machineId);
  return out;
}

/** Resolve the space (Caspar store) id for this task, or "" when there is none. */
export function resolveSpaceId(task) {
  const direct = task?.spaceId || task?.storeId || task?.space_id || task?.store_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // The backend's session id is `space:<spaceId>:<agentId|orbit>`.
  const session = task?.sessionId || task?.session_id;
  if (typeof session === "string") {
    const m = session.match(/^space:([^:]+):/);
    if (m) return m[1];
  }
  return "";
}

/** First array found under any of `keys` on `obj` (host responses vary in shape). */
function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  // A nested single wrapper (`{ result: { members: [...] } }`).
  for (const k of ["result", "data", "obj", "value"]) {
    if (obj[k] && typeof obj[k] === "object") {
      const nested = firstArray(obj[k], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** Normalise one store-member record into `{ creatureId, programId, entityId }`. */
function memberRouting(entry) {
  if (!entry || typeof entry !== "object") return null;
  const creatureId = pick(entry, ["creatureId", "creature_id", "userId", "user_id", "id"]);
  const programId = pick(entry, ["programId", "program_id", "pid"]);
  const entityId = pick(entry, ["entityId", "entity_id"]);
  if (!creatureId && !programId) return null;
  return { creatureId, programId, entityId };
}

/**
 * Pull a `public.decillion` (or `decillion`) descriptor out of whatever shape a
 * `getCreature` response takes — the record may nest metadata under `obj`,
 * `meta`, `metadata`, `public`, or be the descriptor object itself.
 */
export function extractDescriptor(resp) {
  if (!resp || typeof resp !== "object") return undefined;
  const roots = [resp, resp.obj, resp.meta, resp.metadata, resp.result, resp.data, resp.creature, resp.record].filter(
    (r) => r && typeof r === "object",
  );
  for (const root of roots) {
    const d = root?.public?.decillion || root?.decillion || (root?.kind && Array.isArray(root?.usecases) ? root : undefined);
    if (d && typeof d === "object" && d.kind) return d;
  }
  return undefined;
}

/** Build the human/LLM description from a descriptor (usecases + how-to-talk). */
function describeDescriptor(d) {
  const uses = Array.isArray(d.usecases) && d.usecases.length ? `Use when: ${d.usecases.join("; ")}.` : "";
  const how = d.howToTalk ? ` How to talk to it: ${d.howToTalk}` : "";
  return `${uses}${how}`.trim() || String(d.name || "creature");
}

/**
 * A `config.tools`-shaped catalog entry from a descriptor + routing ids, matching
 * `descriptor.toCatalogEntry` in the backend so `catalog.buildToolDefinitions`
 * consumes it identically. No platform `defaults` are known on-chain (those are
 * backend-injected), so a discovered entry never *replaces* a backend one that
 * carries them — it only fills a gap.
 */
export function entryFromDescriptor(d, routing) {
  const kind =
    d.kind === "agent" || d.kind === "frontend" || d.kind === "mcp" ? d.kind : "tool";
  const argSchema = d.argSchema || (kind === "agent" ? { prompt: { type: "string", description: "the request for this sub-agent" } } : {});
  const entityId = routing.entityId || (kind === "agent" ? "agent" : kind === "mcp" ? "mcp" : "main");
  const mcpUrl = String(d.mcpUrl || d.mcp_url || "").trim();
  const mcpToken = String(d.mcpToken || d.mcp_token || "").trim();
  return {
    name: String(d.name || routing.programId || routing.creatureId || "creature"),
    kind,
    category: d.category || (kind === "agent" ? "agent" : kind === "mcp" ? "mcp" : "general"),
    description: describeDescriptor(d),
    arg_schema: argSchema,
    ...(Array.isArray(d.requiredArgs) ? { required: d.requiredArgs } : {}),
    ...(d.function ? { function: d.function } : {}),
    ...(Number(d.maxExecSeconds || d.max_exec_seconds) > 0
      ? { max_exec_seconds: Number(d.maxExecSeconds || d.max_exec_seconds) }
      : {}),
    ...(Array.isArray(d.tools) ? { tools: d.tools } : {}),
    ...(Array.isArray(d.functions) ? { functions: d.functions } : {}),
    requires_network: kind === "mcp" ? true : !!d.requiresNetwork,
    risk: d.risk || "low",
    tool_id: routing.programId || routing.creatureId,
    program_id: routing.programId,
    creature_id: routing.creatureId,
    entity_id: entityId,
    discovered: true,
    ...(mcpUrl ? { mcp_url: mcpUrl, mcpUrl } : {}),
    ...(mcpToken ? { mcp_token: mcpToken, mcpToken } : {}),
    ...(d.mcpHeaders && typeof d.mcpHeaders === "object" ? { mcp_headers: d.mcpHeaders, mcpHeaders: d.mcpHeaders } : {}),
  };
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The space's **program index** (`Json::StoreProgramIndex::<space>`), read straight
 * over the gateway — the same on-chain record Nest's `listSpacePrograms` reads.
 *
 * This is where a space's tools *actually live*: a platform tool (the per-space
 * sandbox, the github tool) and a sub-agent are attached to a space as **programs**
 * — entries the spaces creature writes here — and are **never store members**. So
 * reading members alone (the previous behaviour) found none of them, which is why
 * an agent "could not see the tools in the space". Each entry carries its routing
 * ids, its descriptor, and the platform-pinned `defaults` (e.g. the bound
 * `space_id`) inline, so no per-member `getCreature` round-trip is needed.
 */
async function readProgramIndex(bridge, spaceId, timeoutMs) {
  let resp;
  try {
    resp = await bridge.call("getJson", { key: "Json::StoreProgramIndex::" + spaceId, path: "" }, { timeoutMs });
  } catch {
    return [];
  }
  // getJson returns the stored value under `data` (sometimes nested one wrapper
  // deep). The value itself is a map of programId → record.
  let data = resp && typeof resp === "object" ? resp.data : null;
  if (!data || typeof data !== "object") {
    for (const k of ["obj", "result", "value"]) {
      const v = resp?.[k];
      if (v && typeof v === "object" && v.data && typeof v.data === "object") {
        data = v.data;
        break;
      }
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return Array.isArray(data) ? data.filter((v) => v && typeof v === "object") : [];
  }
  return Object.values(data).filter((v) => v && typeof v === "object");
}

/** The decillion descriptor of a program-index record: inline under
 * `metadata.descriptor`, or a nested public.decillion block. A descriptor that
 * carries no `kind` of its own (e.g. the thin `{name, category, avatar}` the app
 * writes when attaching a recommended team) is still returned — the caller
 * classifies it from the record's top-level `kind`. */
function descriptorFromProgram(rec) {
  const meta = rec && typeof rec.metadata === "object" && rec.metadata ? rec.metadata : {};
  const d = meta.descriptor && typeof meta.descriptor === "object" ? meta.descriptor : undefined;
  if (d) return d;
  return extractDescriptor(rec) || extractDescriptor(meta);
}

/** The record's classification, from wherever it was written: the descriptor's
 * own `kind`, or the program-index record's top-level `metadata.kind` / `kind`.
 * Only the on-chain kinds count — anything else is treated as absent. */
function programKind(rec, descriptor) {
  const raw = String(
    (descriptor && descriptor.kind) || pick(rec?.metadata, ["kind"]) || pick(rec, ["kind"]) || "",
  ).toLowerCase();
  return raw === "agent" || raw === "frontend" || raw === "tool" || raw === "mcp" ? raw : "";
}

/**
 * A catalog entry from one program-index record: routing + descriptor + the
 * platform-pinned `defaults` (the bound `space_id`) carried inline. Falls back to
 * a name-only tool entry when a record has no descriptor yet (older spaces whose
 * sandbox entry predates descriptor propagation still carry its name).
 */
export function entryFromProgram(rec, spaceId) {
  const routing = {
    creatureId: pick(rec, ["creatureId", "creature_id", "userId", "user_id"]),
    programId: pick(rec, ["programId", "program_id", "pid", "id"]),
    entityId: pick(rec, ["entityId", "entity_id"]),
  };
  if (!routing.programId && !routing.creatureId) return null;
  const meta = rec && typeof rec.metadata === "object" && rec.metadata ? rec.metadata : {};
  if (!routing.entityId) routing.entityId = pick(meta, ["entityId", "entity_id"]);
  const resourceId = pick(rec, ["resourceId", "resource_id"]) || pick(meta, ["resourceId", "resource_id"]);
  const d = descriptorFromProgram(rec);
  // The record's classification. An agent proxy is attached to a space with its
  // kind recorded on the index record — sometimes on the descriptor, sometimes
  // only as a top-level `metadata.kind` (the app's `assignAgent` writes it there,
  // as the tool-attach path does), and the team-recommend flow historically wrote
  // a thin descriptor with no kind at all. Read every spelling: a teammate agent
  // that classifies as a `tool` here leaks straight into the callable-tool
  // surface (`catalog.buildToolDefinitions` only drops `kind:"agent"`), so other
  // agents call it as a tool instead of @mentioning it. Descriptor kind wins;
  // the record's top-level kind is the fallback; "tool" only when neither says so.
  const recordKind = programKind(rec, d);
  let entry;
  if (d) {
    entry = entryFromDescriptor(d.kind ? d : { ...d, kind: recordKind || "tool" }, routing);
  } else {
    const name = pick(meta, ["name"]) || pick(rec, ["name"]);
    if (!name) return null; // nothing describable — don't list a bare routing id
    entry = {
      name,
      kind: recordKind || "tool",
      category: recordKind === "agent" ? "agent" : "general",
      description: String(pick(meta, ["description"]) || ""),
      arg_schema: {},
      requires_network: false,
      risk: "low",
      tool_id: routing.programId || routing.creatureId,
      program_id: routing.programId,
      creature_id: routing.creatureId,
      entity_id: routing.entityId || "main",
      discovered: true,
    };
  }
  // Carry the platform-pinned defaults so a per-space tool call stays bound; even
  // when the record carries none, pin the space id we discovered it under.
  const defaults = meta.defaults && typeof meta.defaults === "object" ? { ...meta.defaults } : {};
  if (spaceId && !defaults.space_id && !defaults.spaceId) defaults.space_id = spaceId;
  entry.defaults = defaults;
  if (resourceId) entry.resource_id = resourceId;
  return entry;
}

/** The space store's members. Op + store-id field names vary by node build; try
 * the known aliases and pass every id spelling — the node ignores extras. */
async function readMembers(bridge, spaceId, timeoutMs) {
  const idInput = { storeId: spaceId, id: spaceId, store: spaceId, storeID: spaceId };
  for (const op of ["readMembers", "listStoreMembers", "listStoreAccess", "listAccess"]) {
    try {
      const resp = await bridge.call(op, idInput, { timeoutMs });
      const list = firstArray(resp, ["members", "list", "access", "creatures", "results", "items", "entries"])
        .map(memberRouting)
        .filter(Boolean);
      if (list.length) return list;
      // An explicit ok:false means the op exists but rejected — stop guessing ops.
      if (resp && typeof resp === "object" && resp.ok === false && !/unknown|unsupported|not.*found/i.test(String(resp.error || ""))) {
        return [];
      }
    } catch {
      /* try the next alias */
    }
  }
  return [];
}

/**
 * Fetch the space's employable creatures from the node, as catalog entries — the
 * tools, sub-agents and apps the space contains, discovered by the creature
 * itself over the gateway (no backend participation).
 *
 * Reads the **program index** first (where tools/agents are attached), then
 * supplements with any store **members** that advertise a descriptor (for
 * creatures attached the older way, or as a full fallback on a node whose index
 * is unavailable). De-duplicated by routing id, with the creature's own program
 * excluded.
 *
 * @param bridge  connected `CasparBridgeClient` (null → returns []).
 * @param task    the decoded task (for the space id).
 * @param opts    `{ timeoutMs, maxMembers, log, programIndexOnly }`.
 *                `programIndexOnly` skips the per-member `getCreature` fan-out
 *                (used for the cheap live refresh on every `search_tool`, where
 *                the program index is authoritative and the members supplement
 *                is not worth N node round-trips per tool-list).
 * @returns catalog entries (possibly empty). Never throws.
 */
export async function discoverSpaceCatalog(bridge, task, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!bridge || typeof bridge.call !== "function") return [];
  const spaceId = resolveSpaceId(task);
  if (!spaceId) return [];
  const programIndexOnly = Boolean(opts.programIndexOnly);

  const timeoutMs = num(opts.timeoutMs, num(creatureEnv("DISCOVER_TIMEOUT_MS"), 8000));
  const maxMembers = num(opts.maxMembers, num(creatureEnv("DISCOVER_MAX"), 50));

  const mine = selfIds(task, bridge);
  const isSelf = (e) =>
    (e.program_id && mine.has(e.program_id)) ||
    (e.creature_id && mine.has(e.creature_id)) ||
    (e.resource_id && mine.has(e.resource_id));
  const byKey = new Map();
  const keyOf = (e) => `${e.creature_id || ""}|${e.program_id || ""}`;
  const add = (entry) => {
    if (!entry) return;
    if (isSelf(entry)) return; // never hand the agent itself back as an employable tool
    if (byKey.size >= maxMembers) return;
    const key = keyOf(entry);
    if (byKey.has(key)) return; // first writer wins — the program index is authoritative
    byKey.set(key, entry);
  };

  // 1) The program index — where the space's tools + sub-agents are attached.
  try {
    const programs = await readProgramIndex(bridge, spaceId, timeoutMs);
    for (const rec of programs) add(entryFromProgram(rec, spaceId));
    log({ space: spaceId, programs: programs.length, fromIndex: byKey.size });
  } catch (err) {
    log({ space: spaceId, programIndexError: String(err?.message || err) });
  }

  // 2) Store members — a supplement / fallback. Descriptor per member, so only
  //    creatures that advertise one are employable. Skipped for the cheap live
  //    refresh (`programIndexOnly`): the program index above already carries
  //    every attached tool + sub-agent, and the per-member `getCreature`
  //    fan-out is what made a per-`search_tool` refresh block the whole run.
  if (!programIndexOnly && byKey.size < maxMembers) {
    const members = await readMembers(bridge, spaceId, timeoutMs);
    const seen = new Set();
    const unique = [];
    for (const m of members) {
      const key = `${m.creatureId}|${m.programId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if ((m.programId && mine.has(m.programId)) || (m.creatureId && mine.has(m.creatureId))) continue;
      unique.push(m);
      if (unique.length >= maxMembers) break;
    }
    const settled = await Promise.all(
      unique.map(async (m) => {
        if (!m.creatureId) return null;
        try {
          const resp = await bridge.call("getCreature", { userId: m.creatureId, creatureId: m.creatureId }, { timeoutMs });
          const descriptor = extractDescriptor(resp);
          if (!descriptor) return null; // no decillion descriptor → not an employable creature
          return entryFromDescriptor(descriptor, m);
        } catch {
          return null;
        }
      }),
    );
    for (const e of settled) add(e);
  }

  const entries = [...byKey.values()];
  log({ space: spaceId, discovered: entries.length });
  return entries;
}
