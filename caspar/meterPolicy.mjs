/**
 * Which tool calls are infrastructure peeks, not billable machine work.
 * Status/log polls (and the computer install wait) must not accrue per-minute
 * sandbox time — otherwise watching a desktop or listing files taxes the wallet
 * harder than the agents using the machine.
 */
export function isUnmeteredToolFunction(entry, fn) {
  const name = `${entry?.name || ""} ${entry?.tool_id || ""} ${entry?.toolId || ""} ${entry?.key || ""}`.toLowerCase();
  const f = String(fn || "").toLowerCase();
  if (/computer/.test(name) && ["status", "logs", "poll", "url", "get_url"].includes(f)) {
    return true;
  }
  return false;
}
