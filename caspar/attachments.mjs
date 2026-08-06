/**
 * Attachments delivered with a prompt.
 *
 * A task may carry files (`attachments: [{name, mime_type, data | path, description}]`,
 * `data` base64-encoded). Grok works on a filesystem, so the useful thing
 * to do with an attachment is *materialise* it into the session workspace and
 * tell the agent where it is — it can then read, run or edit it with its own
 * tools, including files no LLM could ingest directly (archives, binaries).
 */

import fs from "node:fs";
import path from "node:path";

/** Keep a caller-supplied name from escaping the attachments directory. */
function safeName(name, index) {
  const base = path.basename(String(name || "")).replace(/[^A-Za-z0-9._-]+/g, "_");
  return base && base !== "." && base !== ".." ? base : `attachment-${index + 1}`;
}

/**
 * Write every inline attachment into `<workspace>/attachments/` and return the
 * descriptors the prompt renderer lists. Never throws: an attachment that cannot
 * be written is reported with its error instead of failing the whole prompt.
 */
export function materializeAttachments(task, workspace) {
  const specs = Array.isArray(task?.attachments) ? task.attachments : [];
  if (!specs.length) return [];
  const dir = path.join(workspace, "attachments");
  const out = [];
  specs.forEach((spec, index) => {
    if (!spec || typeof spec !== "object") return;
    const name = safeName(spec.name || spec.filename, index);
    const target = path.join(dir, name);
    const descriptor = {
      name,
      path: target,
      mimeType: spec.mime_type || spec.mimeType || "",
      description: spec.description || "",
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (typeof spec.data === "string" && spec.data) {
        fs.writeFileSync(target, Buffer.from(spec.data, "base64"));
      } else if (typeof spec.text === "string") {
        fs.writeFileSync(target, spec.text, "utf-8");
      } else if (typeof spec.path === "string" && spec.path && fs.existsSync(spec.path)) {
        fs.copyFileSync(spec.path, target);
      } else {
        descriptor.error = "attachment carried no data";
        descriptor.path = spec.path || target;
      }
    } catch (err) {
      descriptor.error = err?.message || String(err);
    }
    out.push(descriptor);
  });
  return out;
}
