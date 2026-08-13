/**
 * Attachments delivered with a prompt.
 *
 * A task may carry files (`attachments: [{name, mime_type, data | path, description}]`,
 * `data` base64-encoded). Grok works on a filesystem, so the useful thing
 * to do with an attachment is *materialise* it into the session workspace and
 * tell the agent where it is — it can then read, run or edit it with its own
 * tools, including files no LLM could ingest directly (archives, binaries).
 *
 * **Multimodal.** Materialising is enough for the agent to *work on* a file, but
 * an image or audio clip the person dropped into the chat is usually meant to be
 * *looked/listened to* by the model directly. Grok's headless CLI accepts a
 * prompt as ACP content blocks (a `.json` `--prompt-file`), so image/audio
 * attachments are additionally handed to the model inline as
 * `{type:"image"|"audio", data, mimeType}` blocks (`mediaContentBlocks`) — the
 * model sees the pixels/samples, not just a path. Every attachment is still
 * materialised too, so the agent can also open, run or edit the same bytes with
 * its filesystem tools. Non-media (video, archives, binaries, documents) stay
 * file-only.
 */

import fs from "node:fs";
import path from "node:path";

import { creatureNumber } from "./env.mjs";

/**
 * Ceiling on the bytes of a single attachment we inline into the prompt as a
 * content block. A chat image/clip is normally small; a huge one would bloat the
 * prompt (and the model would reject it), so past this size we keep it as a
 * materialised file the agent can open on demand instead of inlining it.
 */
const MAX_INLINE_MEDIA_BYTES = creatureNumber("MAX_INLINE_MEDIA_BYTES", 16 * 1024 * 1024);

/** Ceiling on the bytes we fetch for a single URL-referenced attachment. */
const MAX_ATTACHMENT_BYTES = creatureNumber("MAX_ATTACHMENT_BYTES", 32 * 1024 * 1024);

/**
 * True for a MIME type the model can ingest directly as an ACP content block.
 * Images only: the model's message content is text + image (the ACP prompt path
 * forwards only image blocks — an audio block is dropped), so audio is handled by
 * transcription-to-text instead (see `extract.mjs`), not inlined here.
 */
export function isInlineMediaMime(mime) {
  return String(mime || "").toLowerCase().startsWith("image/");
}

/** Keep a caller-supplied name from escaping the attachments directory. */
function safeName(name, index) {
  const base = path.basename(String(name || "")).replace(/[^A-Za-z0-9._-]+/g, "_");
  return base && base !== "." && base !== ".." ? base : `attachment-${index + 1}`;
}

/** Fetch an attachment's bytes from its URL, size-bounded, with a timeout. */
async function fetchAttachmentBytes(url, { maxBytes, timeoutMs = 15000 }) {
  if (typeof fetch !== "function") throw new Error("no fetch available to load attachment URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write every attachment into `<workspace>/attachments/` and return the
 * descriptors the prompt renderer lists. An attachment's bytes come from inline
 * `data` (base64), inline `text`, a local `path`, or — for the platform's chat
 * attachments, which travel as small references to keep the prompt signal under
 * the node's frame limit — a `url` fetched here (bytes live off-chain in Caspar
 * storage). Never throws: an attachment that cannot be written is reported with
 * its error instead of failing the whole prompt.
 *
 * Async because the `url` source is fetched over the network; the inline sources
 * resolve without I/O beyond the file write.
 */
export async function materializeAttachments(task, workspace, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const specs = Array.isArray(task?.attachments) ? task.attachments : [];
  if (!specs.length) return [];
  const dir = path.join(workspace, "attachments");
  const out = await Promise.all(
    specs.map(async (spec, index) => {
      if (!spec || typeof spec !== "object") return null;
      const name = safeName(spec.name || spec.filename, index);
      const target = path.join(dir, name);
      const url = typeof spec.url === "string" ? spec.url.trim() : "";
      const descriptor = {
        name,
        path: target,
        mimeType: spec.mime_type || spec.mimeType || "",
        description: spec.description || "",
        ...(url ? { url } : {}),
      };
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (typeof spec.data === "string" && spec.data) {
          fs.writeFileSync(target, Buffer.from(spec.data, "base64"));
        } else if (typeof spec.text === "string") {
          fs.writeFileSync(target, spec.text, "utf-8");
        } else if (typeof spec.path === "string" && spec.path && fs.existsSync(spec.path)) {
          fs.copyFileSync(spec.path, target);
        } else if (url) {
          fs.writeFileSync(target, await fetchAttachmentBytes(url, { maxBytes }));
        } else {
          descriptor.error = "attachment carried no data";
          descriptor.path = spec.path || target;
        }
      } catch (err) {
        descriptor.error = err?.message || String(err);
      }
      return descriptor;
    }),
  );
  return out.filter(Boolean);
}

/**
 * Turn the image attachments among the materialised descriptors into ACP image
 * content blocks the headless CLI ingests inline (`{type:"image", data,
 * mimeType}`), so the model actually sees the picture instead of only being told
 * a path. Reads the bytes back from the file `materializeAttachments` just wrote —
 * so it works uniformly whether the attachment arrived as inline `data` or was
 * copied from a local `path`. Audio/PDF/documents are NOT inlined here (the model
 * cannot ingest them as blocks); they are turned into text by `extract.mjs`.
 * Never throws: a block that cannot be built is skipped (the file is still there
 * for the agent to open), so a media hiccup never fails the prompt.
 *
 * `maxBytes` caps a single inline block; anything larger stays file-only.
 */
export function mediaContentBlocks(descriptors, { maxBytes = MAX_INLINE_MEDIA_BYTES, log } = {}) {
  const blocks = [];
  for (const a of Array.isArray(descriptors) ? descriptors : []) {
    if (!a || typeof a !== "object" || a.error) continue;
    if (!isInlineMediaMime(a.mimeType) || !a.path) continue;
    try {
      const stat = fs.statSync(a.path);
      if (stat.size > maxBytes) {
        log?.({ skipped: a.name, reason: "over inline size cap", bytes: stat.size, maxBytes });
        continue;
      }
      const data = fs.readFileSync(a.path).toString("base64");
      if (!data) continue;
      const block = { type: "image", data, mimeType: a.mimeType, uri: `file://${a.path}` };
      blocks.push(block);
    } catch (err) {
      log?.({ skipped: a.name, error: err?.message || String(err) });
    }
  }
  return blocks;
}
