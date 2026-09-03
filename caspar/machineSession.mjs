/**
 * Wall-clock computer time for a space's sandbox (Modal/Vercel VM).
 *
 * Modal bills while the sandbox is alive, including idle until shutdown.
 * Agent think-time is not computer time unless that VM is actually on.
 * This ledger is the session from create/start until stop/idle-timeout.
 */

export const MACHINE_JSON_KEY = (spaceId) => `Json::SpaceMachineBill::${spaceId}`;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_GRACE_MS = 60_000;

const locks = new Map();

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function peel(value) {
  let cur = value;
  for (let i = 0; i < 6; i += 1) {
    const obj = object(cur);
    if (!obj || Object.keys(obj).length === 0) break;
    if (
      obj.status != null ||
      obj.phase != null ||
      obj.ready != null ||
      obj.exists != null
    ) {
      return obj;
    }
    const next = obj.result ?? obj.data ?? obj.obj ?? obj.info;
    if (next && next !== cur) {
      cur = next;
      continue;
    }
    break;
  }
  return object(cur);
}

export function emptyLedger() {
  return {
    startedAtMs: 0,
    billedThroughMs: 0,
    lastSeenAtMs: 0,
    running: false,
  };
}

export function normalizeLedger(raw) {
  const src = object(raw);
  const n = (v) => {
    const x = Number(v);
    return Number.isSafeInteger(x) && x > 0 ? x : 0;
  };
  return {
    startedAtMs: n(src.startedAtMs),
    billedThroughMs: n(src.billedThroughMs),
    lastSeenAtMs: n(src.lastSeenAtMs),
    running: src.running === true,
  };
}

export function applyMachineSnapshot(ledger, snapshot, now) {
  const next = { ...normalizeLedger(ledger) };
  const ts = Number(now);
  if (!Number.isSafeInteger(ts) || ts <= 0) return next;
  if (snapshot?.running === true) {
    if (!next.startedAtMs) next.startedAtMs = ts;
    if (!next.billedThroughMs) next.billedThroughMs = next.startedAtMs;
    next.running = true;
    next.lastSeenAtMs = ts;
  } else if (snapshot?.running === false) {
    next.running = false;
    if (!next.lastSeenAtMs) next.lastSeenAtMs = ts;
  } else if (next.running) {
    next.lastSeenAtMs = ts;
  }
  return next;
}

/**
 * Unbilled ms from create/start through now, capped at last-seen + idle
 * timeout when the VM looks stopped or the heartbeat is stale.
 */
export function unbilledMachineMs(ledger, now, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
  const row = normalizeLedger(ledger);
  const billed = row.billedThroughMs || row.startedAtMs;
  if (!billed) return 0;
  const ts = Number(now);
  if (!Number.isSafeInteger(ts) || ts <= billed) return 0;
  const idle = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  const lastSeen = row.lastSeenAtMs || row.startedAtMs;
  const stale = lastSeen > 0 && ts - lastSeen > idle + STALE_GRACE_MS;
  let end = ts;
  if (!row.running || stale) {
    end = Math.min(ts, lastSeen + idle);
  }
  return Math.max(0, end - billed);
}

export function commitMachineMs(ledger, taken) {
  const row = normalizeLedger(ledger);
  const n = Number(taken);
  const add = Number.isSafeInteger(n) && n > 0 ? n : 0;
  const base = row.billedThroughMs || row.startedAtMs || 0;
  return { ...row, billedThroughMs: base + add };
}

export function machineSnapshotFromToolResult(result, entry) {
  const computer = isComputerNamed(entry);
  const obj = peel(result);
  const status = String(obj.status || obj.phase || "").toLowerCase();
  if (computer) {
    if (["ready", "installing", "live", "running"].includes(status)) return { running: true };
    if (obj.ready === true) return { running: true };
    // Computer idle ≠ sandbox shutdown (the VM may still be up).
    return null;
  }
  if (["running", "ready", "installing", "live", "starting"].includes(status)) {
    return { running: true };
  }
  if (["stopped", "off", "deleted", "none"].includes(status)) return { running: false };
  if (obj.ready === true) return { running: true };
  if (obj.exists === true && (status === "" || status === "stopped")) return { running: false };
  return null;
}

function isComputerNamed(entry) {
  const name = `${entry?.name || ""} ${entry?.tool_id || ""} ${entry?.toolId || ""} ${entry?.key || ""} ${entry?.category || ""}`.toLowerCase();
  return /computer/.test(name) && !/sandbox/.test(name);
}

export function isMachineTool(entry) {
  const name = `${entry?.name || ""} ${entry?.tool_id || ""} ${entry?.toolId || ""} ${entry?.key || ""}`.toLowerCase();
  const category = String(entry?.category || "").toLowerCase();
  return category === "execution" || /sandbox/.test(name) || /computer/.test(name);
}

function dataObject(response) {
  if (!response || typeof response !== "object") return null;
  const data = response.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

async function withLock(spaceId, fn) {
  const prev = locks.get(spaceId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(spaceId, prev.then(() => gate, () => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(spaceId) === gate) locks.delete(spaceId);
  }
}

/**
 * Heartbeat and/or take unbilled wall-clock. `commit:false` updates last-seen
 * without charging (status peeks). `commit:true` advances billedThrough.
 * Stop / stale sessions still flush on commit.
 */
export async function takeMachineMs(bridge, spaceId, snapshot, opts = {}) {
  const id = String(spaceId || "").trim();
  if (!id || !bridge) return 0;
  const now = Number.isSafeInteger(opts.now) ? opts.now : Date.now();
  const idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
    ? opts.idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  const capMs = Number.isSafeInteger(opts.capMs) && opts.capMs > 0 ? opts.capMs : 600_000;
  const commit = opts.commit !== false;
  return withLock(id, async () => {
    const key = MACHINE_JSON_KEY(id);
    let ledger = emptyLedger();
    try {
      ledger = normalizeLedger(dataObject(await bridge.call("getJson", { key, path: "session" })));
    } catch {
      ledger = emptyLedger();
    }
    ledger = applyMachineSnapshot(ledger, snapshot, now);
    let taken = 0;
    if (commit) {
      taken = Math.min(unbilledMachineMs(ledger, now, idleTimeoutMs), capMs);
      ledger = commitMachineMs(ledger, taken);
      if (!ledger.running && unbilledMachineMs(ledger, now, idleTimeoutMs) === 0) {
        ledger = {
          startedAtMs: 0,
          billedThroughMs: 0,
          lastSeenAtMs: ledger.lastSeenAtMs,
          running: false,
        };
      }
    }
    try {
      await bridge.call("putJson", {
        key,
        path: "session",
        data: ledger,
        merge: false,
      });
    } catch {
      // Settlement can still use `taken`; the next read may overlap. The lock
      // covers in-process races. A failed put retries on the next call.
    }
    return taken;
  });
}
