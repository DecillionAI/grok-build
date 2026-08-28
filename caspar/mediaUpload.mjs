/**
 * Putting media an agent shared into Caspar's blob storage.
 *
 * The terminal result may carry bounded base64 bytes (an image the agent
 * generated, a file it chose to share). Bytes must never enter the space's
 * signal log — the node's frame limit aside, a transcript full of base64 is
 * unreadable and unbounded. So this backbone uploads them itself and records
 * only a reference: `{name, mimeType, kind, storageId, size}`.
 *
 * It uploads as ITSELF. `execShellAction` with `asSelf: true` runs the node's
 * `/storage/upload` action under the creature identity the node resolved for
 * this container — not an identity this process names — so the stored file is
 * owned by the runtime that produced it, and the same bounds and storage layout
 * apply as when a person uploads from the app.
 *
 * No URL is stored. A file's address is `<storage base>/storage/file/<id>`, and
 * every client already builds that from the id against its own configured base;
 * baking one host into an on-chain record would break the moment the platform
 * moved or a federation served the same space from elsewhere.
 */

import { creatureNumber } from "./env.mjs";

const UPLOAD_TIMEOUT_MS = creatureNumber("MEDIA_UPLOAD_TIMEOUT_MS", 30000);

/**
 * Upload one attachment's bytes. Resolves to its storage id.
 *
 * Throws on refusal — an upload that fails is media the chat will not show, and
 * the caller decides whether that sinks the turn or is merely reported.
 */
async function uploadOne(bridge, attachment, timeoutMs) {
  const res = await bridge.call(
    "execShellAction",
    {
      path: "/storage/upload",
      // Act as this creature. The node supplies the identity; naming one here
      // would be ignored.
      asSelf: true,
      payload: {
        dataBase64: attachment.dataBase64,
        contentType: attachment.mimeType || "application/octet-stream",
      },
    },
    { timeoutMs },
  );
  if (!res || res.ok === false) {
    throw new Error(String(res?.error || "storage upload refused"));
  }
  // execShellAction wraps the action's own response.
  const result = res.result && typeof res.result === "object" ? res.result : res;
  const id = String(result.id || "").trim();
  if (!id) throw new Error("storage upload returned no id");
  return id;
}

/**
 * Upload every attachment carrying bytes and return chat-ready references.
 *
 * Returns `{ refs, failed }`: `refs` are what goes in the answer's record,
 * `failed` names the attachments that could not be stored so the run can say so
 * instead of dropping them silently. An attachment that already carries a
 * `storageId` is passed through untouched.
 */
export async function uploadOutboundMedia(bridge, attachments, { timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const refs = [];
  const failed = [];
  if (!bridge || !Array.isArray(attachments) || !attachments.length) {
    return { refs, failed };
  }
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const base = {
      name: String(attachment.name || "attachment"),
      mimeType: String(attachment.mimeType || "application/octet-stream"),
      kind: String(attachment.kind || "file"),
      ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
      ...(attachment.description ? { description: String(attachment.description) } : {}),
      ...(attachment.source ? { source: String(attachment.source) } : {}),
    };
    const existing = String(attachment.storageId || "").trim();
    if (existing) {
      refs.push({ ...base, storageId: existing });
      continue;
    }
    if (!attachment.dataBase64) continue;
    try {
      refs.push({ ...base, storageId: await uploadOne(bridge, attachment, timeoutMs) });
    } catch (err) {
      failed.push({ name: base.name, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return { refs, failed };
}
