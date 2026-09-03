/**
 * Which tool calls are infrastructure peeks, not billable *work*.
 * Peeks still heartbeat the space's machine ledger. Wall-clock computer
 * time is charged separately when the VM is on (see machineSession.mjs).
 */
import { isMachineTool } from "./machineSession.mjs";

export { isMachineTool };

export function isUnmeteredToolFunction(entry, fn) {
  const name = `${entry?.name || ""} ${entry?.tool_id || ""} ${entry?.toolId || ""} ${entry?.key || ""}`.toLowerCase();
  const f = String(fn || "").toLowerCase();
  if (/computer/.test(name) && ["status", "logs", "poll", "url", "get_url"].includes(f)) {
    return true;
  }
  if (
    (isMachineTool(entry) || /sandbox/.test(name)) &&
    ["info", "status", "list", "list_dir"].includes(f)
  ) {
    return true;
  }
  return false;
}
