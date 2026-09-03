import { releaseBillingRun } from "./finance.mjs";
import {
  isMachineTool,
  machineSnapshotFromToolResult,
  takeMachineMs,
} from "./machineSession.mjs";
import { isUnmeteredToolFunction } from "./meterPolicy.mjs";
import { ToolInvoker } from "./toolInvoker.mjs";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function authoritativeTool(bridge, resourceId) {
  const response = object(await bridge.call("getJson", {
    key: "Json::CreatureNamespace::market",
    path: "tools",
  }));
  const tools = object(response.data);
  const entry = object(tools[resourceId]);
  if (
    String(entry.programId || "") !== resourceId ||
    String(entry.status || "") !== "approved"
  ) {
    throw new Error("authorized tool is not an approved global market resource");
  }
  if (String(entry.billingMeterProgramId || "") !== String(bridge.programId || "")) {
    throw new Error("this meter is no longer the tool's registered execution coordinator");
  }
  return entry;
}

function executionBinding(quote, resourceId) {
  const resources = Array.isArray(quote?.executionPlan?.resources)
    ? quote.executionPlan.resources
    : [];
  const binding = resources.find(
    (row) => row?.kind === "tool" && String(row?.resourceId || "") === resourceId,
  );
  if (!binding) throw new Error("tool execution binding is missing from the quote");
  return binding;
}

function timeoutSeconds(entry, authorizedRuntimeMs) {
  const quoted = Math.max(1, Math.ceil(authorizedRuntimeMs / 1000));
  const listed = Number(entry.max_exec_seconds || entry.maxExecSeconds || quoted);
  return Number.isFinite(listed) && listed > 0 ? Math.min(quoted, Math.ceil(listed)) : quoted;
}

/**
 * Execute one user-initiated tool call through the trusted meter. The client
 * supplies only the function and arguments; the global market registry and the
 * signed quote decide the target program, entity, host node, meter, and rates.
 */
export async function runDirectTool(bridge, delivery, billingSession) {
  const resourceId = String(billingSession.quote.resourceId || "");
  const entry = await authoritativeTool(bridge, resourceId);
  const binding = executionBinding(billingSession.quote, resourceId);
  if (
    String(entry.hostNodeOwnerAccountId || "") !== String(binding.nodeOwnerAccountId || "") ||
    String(entry.hostOriginId || "") !== String(binding.hostOriginId || "") ||
    String(entry.nodeRegistrationRevision || "") !== String(binding.nodeRegistrationRevision || "")
  ) {
    throw new Error("tool host registration changed after the quote was issued");
  }

  const task = object(delivery.task);
  const args = object(task.payload);
  const fn = String(task.function || "").trim();
  if (!fn || fn.length > 128) throw new Error("invalid tool function");
  const authorizedRuntimeMs = Number(billingSession.quote?.priceSnapshot?.authorizedRuntimeMs);
  if (!Number.isSafeInteger(authorizedRuntimeMs) || authorizedRuntimeMs <= 0) {
    throw new Error("tool quote has no valid runtime authorization");
  }

  const catalogEntry = {
    ...entry,
    program_id: resourceId,
    entity_id: String(entry.entityId || "main"),
    function: fn,
    max_exec_seconds: timeoutSeconds(entry, authorizedRuntimeMs),
  };
  const name = "direct_tool";
  const invoker = new ToolInvoker(
    bridge,
    new Map([[name, catalogEntry]]),
    bridge.machineId || bridge.programId || "",
    {
      authorizedToolIds: [resourceId],
      // A direct tool call is a PERSON pressing a button in a tool's mini-app.
      // Take who they are from the signed quote (`payerUserId`, read back from
      // the on-chain quote document) rather than from anything the client sent,
      // so a tool that gates on the member who connected something — github's
      // sharing toggle, zapier's per-member Zapier account — sees the real
      // person instead of this meter.
      callerId: String(billingSession.quote?.payerUserId || ""),
    },
  );
  try {
    const invoked = await invoker.invoke(name, {
      ...args,
      function: fn,
      space_id: String(task.spaceId || ""),
    });
    const spaceId = String(task.spaceId || args.space_id || args.spaceId || "");
    const snapshot = isMachineTool(entry)
      ? machineSnapshotFromToolResult(invoked.ok ? invoked.response : invoked, entry)
      : null;
    const unmetered = isUnmeteredToolFunction(entry, fn);
    const stopped = snapshot?.running === false;
    let machineMs = 0;
    if (spaceId && isMachineTool(entry)) {
      try {
        machineMs = await takeMachineMs(bridge, spaceId, snapshot, {
          capMs: authorizedRuntimeMs,
          commit: !unmetered || stopped,
        });
      } catch {
        machineMs = 0;
      }
    }
    if (unmetered && machineMs <= 0) {
      await releaseBillingRun(bridge, billingSession, "unmetered tool peek");
      return {
        settled: false,
        result: invoked.ok
          ? invoked.response
          : { ok: false, error: String(invoked?.error || "tool execution failed") },
      };
    }
    const usage = invoker.usageSnapshot()[0];
    if (!unmetered && (!usage || usage.outcome === "timeout")) {
      await releaseBillingRun(
        bridge,
        billingSession,
        usage?.outcome === "timeout"
          ? "direct tool timed out without a completion receipt"
          : "direct tool signal failed before execution was receipted",
      );
      return {
        settled: false,
        result: { ok: false, error: String(invoked?.error || "tool execution failed") },
      };
    }
    return {
      settled: true,
      observed: {
        resourceId,
        calls: unmetered ? 0 : usage.calls,
        runtimeMs: unmetered ? 0 : usage.runtimeMs,
        machineMs,
        outcome: unmetered ? "ok" : usage.outcome,
      },
      result: invoked.ok
        ? invoked.response
        : { ok: false, error: String(invoked?.error || "tool execution failed") },
    };
  } finally {
    invoker.dispose();
  }
}
