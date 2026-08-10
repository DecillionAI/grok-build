/**
 * Task-signal decoding.
 *
 * A prompt reaches this creature as a `/creatures/signal` the node wraps as
 * `StoresSend{user, data:"<json>", entityId, correlationId}` and pushes onto our
 * gateway connection. Three envelope shapes have to be peeled, in this order:
 *
 *  1. the StoresSend wrapper — the real packet is the JSON string under `data`;
 *  2. the client convention where the requester's payload travels as another
 *     JSON string under `payload` (`{programId, entity, payload:"…"}`);
 *  3. the Caspar **proxy** envelope: an "agent" proxy entity forwards the
 *     requester's packet with `skill` (the agent's deployed skill file, the
 *     proxy's `attachField`), `correlationId`, `replyTo`, `proxyProgramId` and
 *     `proxyEntityId` stamped on — those keys live on the *wrapper* and must
 *     survive unwrapping of the inner payload.
 *
 * Everything here is pure so the decoding rules are testable without a node.
 */

/** Keys the proxy stamps on the wrapper; kept when an inner payload is unwrapped. */
const PROXY_KEYS = [
  "skill",
  "systemInstruction",
  "correlationId",
  "replyTo",
  "reply_to",
  "proxyProgramId",
  "proxyEntityId",
];

/**
 * Deep-merge `src` onto `base`: nested objects merge recursively, and any
 * non-object value in `src` overwrites `base`. Mirrors the node proxy's own
 * `deep_merge` (`caspar/node/src/drivers/vmm/proxy.rs`) so the agent's injected
 * config wins over a caller-supplied one, exactly as it does on the wire.
 */
function deepMerge(base, src) {
  if (src === null || typeof src !== "object" || Array.isArray(src)) return src;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The authoritative space (Caspar store) id for a signal: the store the node
 * says the signal was sent *within*.
 *
 * The node resolves the originating store from the signal's own context and
 * stamps it on the `StoresSend` envelope (`store.id`) it pushes to us — carried
 * through the proxy relay untouched — so the creature never has to trust a
 * client-supplied `spaceId`. Which store the signal actually came from is what
 * scopes in-space tool/sub-agent discovery, and it cannot be forged by a caller.
 * A flat `storeId` is accepted as a fallback. Empty when the envelope carries no
 * store (a signal not scoped to a space), in which case the caller keeps
 * whatever the payload provided.
 */
export function spaceIdFromEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return "";
  const store = envelope.store;
  if (store && typeof store === "object" && typeof store.id === "string" && store.id.trim()) {
    return store.id.trim();
  }
  if (typeof envelope.storeId === "string" && envelope.storeId.trim()) return envelope.storeId.trim();
  return "";
}

/**
 * Decode one pushed `creatures/signal` into a task, or `null` when the signal is
 * not a task delivery (a tool result, an unrelated push, …).
 *
 * Returns `{ task, replyTo, correlationId, streamTo }`.
 */
export function decodeTaskSignal(key, data) {
  if (key !== "creatures/signal" || !data || typeof data !== "object") return null;

  let inner = parseMaybeJson(data.data);
  if (inner === undefined && typeof data.data === "string") return null; // unparseable
  if (!inner || typeof inner !== "object") inner = data;

  // The requester's real payload may travel as a JSON string (or object) under
  // `payload`. Unwrap it into the task, keeping the proxy envelope keys.
  const wrapped = inner.payload;
  if (typeof wrapped === "string" && wrapped.trim()) {
    const parsed = parseMaybeJson(wrapped);
    const payload = parsed && typeof parsed === "object" ? parsed : { objective: wrapped };
    inner = mergeEnvelope(payload, inner);
  } else if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    inner = mergeEnvelope(wrapped, inner);
  }

  // Only act on a task delivery. A packet relayed by a proxy "agent" entity
  // carries the deployed skill file — that is a task too, even when the
  // requester only sent a bare prompt/data string.
  const isTask =
    inner.kind === "task" ||
    typeof inner.objective === "string" ||
    typeof inner.prompt === "string" ||
    typeof inner.skill === "string";
  if (!isTask) return null;

  // The space is decided by the store the signal came from, not by the client:
  // the node stamps the originating store on the envelope, so this is the id the
  // rest of the creature mechanism (discovery, thread/session key) scopes to.
  // It overrides any `spaceId` the requester embedded in the payload.
  const envelopeSpaceId = spaceIdFromEnvelope(data);
  if (envelopeSpaceId) inner.spaceId = envelopeSpaceId;

  const replyTo = inner.reply_to || inner.replyTo || data.user?.id || "";
  const correlationId = inner.correlationId || data.correlationId || "";
  const streamTo = inner.streamTo || inner.stream_to || "";
  return { task: inner, replyTo: String(replyTo || ""), correlationId: String(correlationId || ""), streamTo: String(streamTo || "") };
}

function mergeEnvelope(payload, wrapper) {
  const merged = { ...payload };
  for (const k of PROXY_KEYS) {
    if (k in wrapper && !(k in merged)) merged[k] = wrapper[k];
  }
  // The agent's own LLM config (its provider/model/**apiKey**) reaches us as the
  // proxy entity's `inject`, which the node deep-merges into the forwarded packet
  // (see proxy.rs). But the requester's real payload travels as a JSON *string*
  // under `payload`, so the node can only merge the inject onto the OUTER
  // envelope — `config` lands on the wrapper, not inside this unwrapped inner.
  // Carry it across, with the injected value winning over any caller-supplied
  // `config` (same precedence as the node's own deep-merge). Without this the
  // agent's key is silently dropped and every run falls back to the creature's
  // default backbone — the exact "agents ignore my LLM key" bug.
  if (wrapper && typeof wrapper.config === "object" && wrapper.config !== null && !Array.isArray(wrapper.config)) {
    merged.config = deepMerge(merged.config, wrapper.config);
  }
  return merged;
}

/** The objective (the current turn's prompt) carried by a task. */
export function taskObjective(task) {
  const candidates = [task.objective, task.prompt, typeof task.data === "string" ? task.data : undefined];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "Run a self-test and report what you can do.";
}

/**
 * Derive a conversation-thread key from the task.
 *
 * The backend sends an explicit `sessionId` (`space:<spaceId>:<agentId|orbit>`),
 * which is authoritative. The space/target fallback mirrors that shape so a
 * caller that sends neither still gets one stable thread per space+agent instead
 * of mixing unrelated conversations onto one workspace.
 */
export function threadSessionId(task, fallback = "grok-default") {
  const explicit = task.session_id || task.sessionId;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const space = task.spaceId || task.storeId || task.space_id;
  if (space) {
    const target = task.self?.id || task.targetAgentId || task.target_agent_id || task.toAgent || "orbit";
    return `space:${space}:${target}`;
  }
  return fallback;
}

/** A filesystem-safe slug for a session id (used as the workspace directory). */
export function sessionSlug(sessionId) {
  const slug = String(sessionId)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || "session";
}
