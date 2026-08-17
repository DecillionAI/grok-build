/**
 * Media an agent deliberately sends back to a Decillion space.
 *
 * The terminal result is ephemeral, so it may carry bounded base64 bytes. The
 * signed-in Expo client uploads those bytes to Caspar's off-chain blob storage
 * and persists only `{name,mimeType,kind,storageId,url}` in space history.
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MEDIA_TOOL_NAMES = new Set([
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "video_gen",
]);

export const SHARE_MEDIA_TOOL = {
  name: "share_media",
  description:
    "Attach media or a file to your Decillion chat reply. Use url for something found online, or path for a file you created in the space's shared sandbox. Call once per attachment; do not paste base64.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http(s) URL of media found online." },
      path: { type: "string", description: "Path of a file in the shared space sandbox." },
      name: { type: "string", description: "Filename shown in chat." },
      mime_type: { type: "string", description: "MIME type when known, such as image/png or audio/mpeg." },
      description: { type: "string", description: "Short accessible description of the attachment." },
    },
  },
};

export class OutboundMediaCollector {
  constructor({
    sandboxReader,
    localRoots = [],
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    log,
  } = {}) {
    this.sandboxReader = sandboxReader;
    this.localRoots = localRoots.map((root) => path.resolve(root));
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.log = log;
    this.items = [];
    this.totalBytes = 0;
    this.seen = new Set();
  }

  /** MCP handler used by the model for internet media and sandbox-created files. */
  async share(args = {}) {
    const url = cleanString(args.url);
    const sandboxPath = cleanString(args.path);
    if (Boolean(url) === Boolean(sandboxPath)) {
      return { ok: false, error: "share_media needs exactly one of url or path" };
    }
    try {
      let bytes;
      let detectedMime = "";
      let fallbackName = "attachment";
      let source;
      let key;
      if (url) {
        const fetched = await fetchPublicMedia(url, this.maxFileBytes);
        bytes = fetched.bytes;
        detectedMime = fetched.mimeType;
        fallbackName = nameFromUrl(fetched.url) || "attachment";
        source = "internet";
        key = `url:${fetched.url}`;
      } else {
        if (typeof this.sandboxReader !== "function") {
          return { ok: false, error: "this space has no shared sandbox to export that path from" };
        }
        const exported = await this.sandboxReader(sandboxPath);
        const decoded = decodeSandboxExport(exported);
        bytes = decoded.bytes;
        detectedMime = decoded.mimeType;
        fallbackName = path.basename(sandboxPath) || "attachment";
        source = "generated";
        key = `sandbox:${sandboxPath}`;
      }
      const item = this._add(bytes, {
        key,
        name: cleanString(args.name) || fallbackName,
        mimeType: cleanString(args.mime_type || args.mimeType) || detectedMime,
        description: cleanString(args.description),
        source,
      });
      return item
        ? {
            ok: true,
            attachment: publicSummary(item),
            message: `${item.name} will be attached to your final chat reply.`,
          }
        : { ok: true, duplicate: true, message: "That media is already attached." };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** Discover typed output from Grok's built-in image/video generation tools. */
  async collectGenerated(messages) {
    const toolNames = new Map();
    for (const message of Array.isArray(messages) ? messages : []) {
      const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
      if (message?.type === "assistant") {
        for (const block of blocks) {
          if (block?.type === "tool_use" && block.id) {
            toolNames.set(String(block.id), String(block.name || ""));
          }
        }
        continue;
      }
      if (message?.type !== "user") continue;
      for (const block of blocks) {
        if (block?.type !== "tool_result") continue;
        const rawTool = toolNames.get(String(block.tool_use_id || "")) || "";
        const tool = rawTool.toLowerCase().split(/[:/]/).pop() || "";
        if (!MEDIA_TOOL_NAMES.has(tool)) continue;
        const candidate = mediaCandidate(block.content);
        if (!candidate) continue;
        try {
          if (candidate.url) {
            const fetched = await fetchPublicMedia(candidate.url, this.maxFileBytes);
            this._add(fetched.bytes, {
              key: `generated-url:${fetched.url}`,
              name: candidate.filename || nameFromUrl(fetched.url) || generatedName(tool),
              mimeType: fetched.mimeType || mimeForTool(tool),
              source: "generated",
            });
          } else if (candidate.path) {
            const absolute = path.resolve(candidate.path);
            if (!this._allowedLocalPath(absolute)) throw new Error("generated media path escaped the run workspace");
            const stat = fs.statSync(absolute);
            if (!stat.isFile()) throw new Error("generated media path is not a file");
            if (stat.size > this.maxFileBytes) throw new Error(`generated media exceeds ${this.maxFileBytes} bytes`);
            this._add(fs.readFileSync(absolute), {
              key: `generated-path:${absolute}`,
              name: candidate.filename || path.basename(absolute) || generatedName(tool),
              mimeType: mimeFromName(absolute) || mimeForTool(tool),
              source: "generated",
            });
          }
        } catch (err) {
          this.log?.({ skipped: candidate.path || candidate.url, error: String(err?.message || err) });
        }
      }
    }
    return this.attachments();
  }

  attachments() {
    return this.items.map((item) => ({ ...item }));
  }

  /** Add bytes produced by a provider adapter to the terminal attachment set. */
  addGenerated({ bytes, dataBase64, name, mimeType, description, key, provider, model } = {}) {
    const payload = bytes ?? (cleanString(dataBase64) ? Buffer.from(dataBase64, "base64") : null);
    const provenance = [provider, model].map(cleanString).filter(Boolean).join(" / ");
    const described = cleanString(description);
    const item = this._add(payload, {
      key: cleanString(key) || `generated:${provider || "provider"}:${model || "model"}:${this.items.length}`,
      name: cleanString(name) || "generated-media",
      mimeType: cleanString(mimeType),
      description: [described, provenance ? `Generated by ${provenance}.` : ""].filter(Boolean).join(" "),
      source: "generated",
    });
    return item ? publicSummary(item) : null;
  }

  allowLocalRoot(root) {
    const resolved = cleanString(root) ? path.resolve(root) : "";
    if (resolved && !this.localRoots.includes(resolved)) this.localRoots.push(resolved);
  }

  _allowedLocalPath(candidate) {
    if (!this.localRoots.length) return false;
    return this.localRoots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  }

  _add(bytesLike, meta) {
    if (this.seen.has(meta.key)) return null;
    const bytes = Buffer.isBuffer(bytesLike) ? bytesLike : Buffer.from(bytesLike || []);
    if (!bytes.length) throw new Error("attachment is empty");
    if (bytes.length > this.maxFileBytes) throw new Error(`attachment exceeds ${this.maxFileBytes} bytes`);
    if (this.totalBytes + bytes.length > this.maxTotalBytes) {
      throw new Error(`attachments exceed the ${this.maxTotalBytes}-byte turn limit`);
    }
    const name = safeName(meta.name || "attachment");
    const mimeType = normalizeMime(meta.mimeType) || mimeFromName(name) || "application/octet-stream";
    const item = {
      name,
      mimeType,
      kind: kindForMime(mimeType),
      size: bytes.length,
      dataBase64: bytes.toString("base64"),
      source: meta.source === "internet" ? "internet" : "generated",
      ...(meta.description ? { description: meta.description.slice(0, 500) } : {}),
    };
    this.seen.add(meta.key);
    this.totalBytes += bytes.length;
    this.items.push(item);
    return item;
  }
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeName(value) {
  const base = path.basename(String(value || "attachment")).replace(/[\u0000-\u001f/\\]+/g, "_");
  return (base || "attachment").slice(0, 180);
}

function publicSummary(item) {
  return { name: item.name, mimeType: item.mimeType, kind: item.kind, size: item.size };
}

function kindForMime(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function normalizeMime(value) {
  return cleanString(value).split(";")[0].trim().toLowerCase();
}

function mimeForTool(tool) {
  return /video/.test(tool) ? "video/mp4" : "image/jpeg";
}

function generatedName(tool) {
  return /video/.test(tool) ? "generated-video.mp4" : "generated-image.jpg";
}

function mimeFromName(name) {
  const ext = path.extname(String(name || "")).toLowerCase();
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/opus", ".mp4": "video/mp4",
    ".mov": "video/quicktime", ".webm": "video/webm", ".pdf": "application/pdf",
  })[ext] || "";
}

function nameFromUrl(raw) {
  try {
    return safeName(decodeURIComponent(new URL(raw).pathname.split("/").pop() || ""));
  } catch {
    return "";
  }
}

function mediaCandidate(content) {
  const visit = (value, depth = 0) => {
    if (depth > 8 || value == null) return null;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return null;
      try {
        return visit(JSON.parse(text), depth + 1);
      } catch {
        const match = text.match(/https?:\/\/[^\s"'}]+/i);
        return match ? { url: match[0] } : null;
      }
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    const filename = cleanString(value.filename || value.name);
    const url = cleanString(value.uploaded_url || value.uploadedUrl || value.url);
    const filePath = cleanString(value.path || value.file_path || value.filePath);
    if (url || filePath) return { ...(url ? { url } : {}), ...(filePath ? { path: filePath } : {}), filename };
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(content);
}

function decodeSandboxExport(raw) {
  const visit = (value, depth = 0) => {
    if (depth > 8 || !value || typeof value !== "object") return null;
    const encoding = cleanString(value.encoding).toLowerCase();
    if (typeof value.content === "string" && (encoding === "base64" || encoding === "text")) return value;
    for (const key of ["response", "result", "obj", "data", "payload"]) {
      const found = visit(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const row = visit(raw);
  if (!row) throw new Error("sandbox export returned no file bytes");
  const bytes = row.encoding === "base64" ? Buffer.from(row.content, "base64") : Buffer.from(row.content, "utf-8");
  return { bytes, mimeType: normalizeMime(row.mimeType || row.mime_type) };
}

async function fetchPublicMedia(rawUrl, maxBytes) {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicHttpUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`media redirect ${response.status} had no location`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`media download failed with HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared > maxBytes) throw new Error(`media exceeds ${maxBytes} bytes`);
      const bytes = await readResponseBounded(response, maxBytes);
      return { bytes, mimeType: normalizeMime(response.headers.get("content-type")), url: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("media URL redirected too many times");
}

async function readResponseBounded(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`media exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`media exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function assertPublicHttpUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error("media URL must use http or https");
  if (url.username || url.password) throw new Error("media URL must not include credentials");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("media URL must resolve to a public internet host");
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("media URL must resolve only to public internet addresses");
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
  }
  return true;
}

