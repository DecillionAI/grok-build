#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  applyMachineSnapshot,
  commitMachineMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  emptyLedger,
  machineSnapshotFromToolResult,
  takeMachineMs,
  unbilledMachineMs,
} from "../machineSession.mjs";
import { isUnmeteredToolFunction } from "../meterPolicy.mjs";

const t0 = 1_000_000;

{
  let ledger = applyMachineSnapshot(emptyLedger(), { running: true }, t0);
  assert.equal(unbilledMachineMs(ledger, t0 + 30_000), 30_000, "running VM bills wall clock");
  ledger = commitMachineMs(ledger, 30_000);
  assert.equal(unbilledMachineMs(ledger, t0 + 30_000), 0, "committed time is not billed twice");
  assert.equal(unbilledMachineMs(ledger, t0 + 45_000), 15_000, "further uptime is incremental");
}

{
  let ledger = applyMachineSnapshot(emptyLedger(), { running: true }, t0);
  ledger = applyMachineSnapshot(ledger, { running: false }, t0 + 10_000);
  assert.equal(
    unbilledMachineMs(ledger, t0 + 10_000),
    10_000,
    "observed stop shortly after last-seen bills the gap",
  );
  assert.equal(
    unbilledMachineMs(ledger, t0 + DEFAULT_IDLE_TIMEOUT_MS + 120_000),
    DEFAULT_IDLE_TIMEOUT_MS,
    "a late read still caps at last-seen plus idle timeout",
  );
}

{
  let ledger = applyMachineSnapshot(emptyLedger(), { running: true }, t0);
  const idle = 5_000;
  const later = t0 + idle + 60_000 + 1;
  assert.equal(
    unbilledMachineMs(ledger, later, idle),
    idle,
    "stale running flag caps at last-seen plus idle timeout",
  );
}

{
  const snap = machineSnapshotFromToolResult({ status: "running" }, { name: "sandbox" });
  assert.deepEqual(snap, { running: true });
  const off = machineSnapshotFromToolResult({ status: "stopped", exists: true }, { name: "sandbox" });
  assert.deepEqual(off, { running: false });
  const computerIdle = machineSnapshotFromToolResult({ phase: "idle" }, { name: "computer" });
  assert.equal(computerIdle, null, "computer idle is not a sandbox shutdown");
}

{
  const sandbox = { name: "sandbox" };
  assert.equal(isUnmeteredToolFunction(sandbox, "info"), true);
  assert.equal(isUnmeteredToolFunction(sandbox, "exec"), false);
}

{
  const store = new Map();
  const bridge = {
    async call(op, input) {
      if (op === "getJson") return { data: store.get(input.key) || null };
      if (op === "putJson") {
        store.set(input.key, input.data);
        return { ok: true };
      }
      throw new Error(op);
    },
  };
  const a = await takeMachineMs(bridge, "space-1", { running: true }, { now: t0, commit: false });
  assert.equal(a, 0, "heartbeat does not charge");
  const b = await takeMachineMs(bridge, "space-1", { running: true }, { now: t0 + 12_000, commit: true });
  assert.equal(b, 12_000, "commit takes unbilled wall clock");
  const c = await takeMachineMs(bridge, "space-1", { running: false }, { now: t0 + 12_000, commit: true });
  assert.equal(c, 0, "stop at the last billed instant adds nothing");
}

console.log("  ok  machine session");
