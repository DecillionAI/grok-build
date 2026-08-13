/**
 * Turning non-image attachments into text the model can actually read.
 *
 * The model's message content is **text or image only** (see the sampling
 * types' `ContentPart`), and the ACP prompt path forwards only image blocks — an
 * audio block is dropped, and a PDF/document is neither an image nor readable by
 * the agent's own file tools (those are disabled inside a space, and a PDF is
 * binary anyway). So an attachment that is not an image never reaches the model
 * in a usable form. This module bridges that gap: it extracts a **text**
 * representation of each such attachment so it can be inlined into the prompt.
 *
 *   • text-like files (text/*, json, xml, csv, code, …) → their UTF-8 content
 *   • PDF documents → extracted text (pure-Node, no dependency)
 *   • audio → a transcript, when a Whisper-compatible STT endpoint is available
 *
 * Everything here is best-effort and never throws: an attachment that cannot be
 * turned into text is simply left out (the file is still materialised for the
 * agent to open if it can), so extraction never fails a prompt.
 */

import fs from "node:fs";
import zlib from "node:zlib";

import { creatureEnv, creatureNumber } from "./env.mjs";

/** Cap on the characters of extracted text inlined per attachment. */
const MAX_EXTRACTED_CHARS = creatureNumber("MAX_EXTRACTED_CHARS", 200_000);
/** Cap on the bytes we read/transcode for one attachment. */
const MAX_EXTRACT_BYTES = creatureNumber("MAX_EXTRACT_BYTES", 32 * 1024 * 1024);

const TEXT_EXTS = new Set([
  "txt", "text", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonl",
  "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "html", "htm",
  "svg", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py",
  "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "cs", "php",
  "swift", "sh", "bash", "zsh", "sql", "graphql", "proto", "env", "gitignore",
  "dockerfile", "makefile", "diff", "patch",
]);

function extOf(name) {
  const n = String(name || "").toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot >= 0 ? n.slice(dot + 1) : n; // handles extensionless "Dockerfile"/"Makefile"
}

/** True for a file whose bytes are its own readable text. */
export function isTextLike(mime, name) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("text/")) return true;
  if (
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/xhtml+xml" ||
    m === "application/javascript" ||
    m === "application/x-yaml" ||
    m === "application/yaml" ||
    m === "application/toml" ||
    m === "application/x-sh" ||
    m.endsWith("+json") ||
    m.endsWith("+xml")
  ) {
    return true;
  }
  return TEXT_EXTS.has(extOf(name));
}

export function isPdf(mime, name) {
  return String(mime || "").toLowerCase() === "application/pdf" || extOf(name) === "pdf";
}

function clip(text) {
  const s = String(text || "");
  if (s.length <= MAX_EXTRACTED_CHARS) return s;
  return `${s.slice(0, MAX_EXTRACTED_CHARS)}\n…[truncated ${s.length - MAX_EXTRACTED_CHARS} chars]`;
}

// ── PDF text extraction (pure Node) ──────────────────────────────────────────
// A digital PDF's text lives inside content streams, usually Flate-compressed.
// We inflate every stream and pull the text-showing operators' strings out of
// the `BT … ET` text objects. This is not a full PDF parser — it will not
// recover text from scanned/image-only PDFs or exotic font encodings — but it
// reliably yields the readable text of ordinary documents with zero deps.

/** Decode a PDF literal string body (the bytes between `(` and `)`). */
function decodePdfLiteral(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      // Up to 3 octal digits.
      let oct = next;
      let j = i + 2;
      while (j < body.length && oct.length < 3 && body[j] >= "0" && body[j] <= "7") {
        oct += body[j];
        j++;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (next === "\n") {
      i += 1; // line continuation
    } else if (next in map) {
      out += map[next];
      i += 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

/** Pull readable text out of one decoded content stream. */
function textFromContentStream(content) {
  let out = "";
  let i = 0;
  const n = content.length;
  let inText = false;
  while (i < n) {
    const ch = content[i];
    if (ch === "(") {
      // Read a balanced literal string, honouring escaped/nested parens.
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < n && depth > 0) {
        const c = content[j];
        if (c === "\\") {
          body += c + (content[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
        body += c;
        j++;
      }
      if (inText) out += decodePdfLiteral(body);
      i = j + 1;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      // Hex string <...>: pairs of hex → bytes. Rare for text; best-effort.
      let j = i + 1;
      let hex = "";
      while (j < n && content[j] !== ">") {
        hex += content[j];
        j++;
      }
      if (inText) {
        const clean = hex.replace(/[^0-9a-fA-F]/g, "");
        for (let k = 0; k + 1 < clean.length; k += 2) {
          out += String.fromCharCode(parseInt(clean.slice(k, k + 2), 16) & 0xff);
        }
      }
      i = j + 1;
      continue;
    }
    // Operators: track BT/ET and add whitespace for line-breaking ops.
    if (ch === "B" && content.slice(i, i + 2) === "BT") {
      inText = true;
      i += 2;
      continue;
    }
    if (ch === "E" && content.slice(i, i + 2) === "ET") {
      inText = false;
      out += "\n";
      i += 2;
      continue;
    }
    if (inText && (content.slice(i, i + 2) === "Td" || content.slice(i, i + 2) === "TD" || content.slice(i, i + 2) === "T*")) {
      out += "\n";
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

/** Extract text from a whole PDF buffer. */
export function extractPdfText(buffer) {
  const latin1 = buffer.toString("latin1");
  let text = "";
  let idx = 0;
  const streamTag = "stream";
  while (true) {
    const s = latin1.indexOf(streamTag, idx);
    if (s < 0) break;
    const e = latin1.indexOf("endstream", s);
    if (e < 0) break;
    // Body starts after `stream` + its EOL (CRLF or LF).
    let bodyStart = s + streamTag.length;
    if (latin1[bodyStart] === "\r") bodyStart++;
    if (latin1[bodyStart] === "\n") bodyStart++;
    const dict = latin1.slice(Math.max(0, s - 300), s);
    const raw = Buffer.from(latin1.slice(bodyStart, e), "latin1");
    let content = null;
    if (/\/FlateDecode/.test(dict)) {
      try {
        content = zlib.inflateSync(raw).toString("latin1");
      } catch {
        try {
          content = zlib.inflateRawSync(raw).toString("latin1");
        } catch {
          content = null;
        }
      }
    } else if (!/\/(DCTDecode|CCITTFax|JBIG2|JPXDecode|Image)/.test(dict)) {
      content = raw.toString("latin1");
    }
    if (content) text += textFromContentStream(content) + "\n";
    idx = e + "endstream".length;
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── audio transcription (Whisper-compatible, best-effort) ────────────────────

/** Resolve an OpenAI-compatible transcription endpoint from the agent's LLM
 * override or operator env. Returns `null` when none is configured. */
function resolveStt(llm, env) {
  const sttKey = (creatureEnv("STT_API_KEY", env) || "").trim();
  const sttBase = (creatureEnv("STT_BASE_URL", env) || "").trim();
  const sttModel = (creatureEnv("STT_MODEL", env) || "").trim() || "whisper-1";
  if (sttKey) {
    return { apiKey: sttKey, baseUrl: sttBase || "https://api.openai.com/v1", model: sttModel };
  }
  // Fall back to the agent's own provider when it is OpenAI-compatible.
  if (llm && typeof llm === "object") {
    const provider = String(llm.provider || "").trim().toLowerCase();
    const apiKey = (llm.api_key || llm.apiKey || "").toString().trim();
    const baseUrl = (llm.base_url || llm.baseUrl || "").toString().trim();
    if (apiKey && (provider === "openai" || baseUrl)) {
      return { apiKey, baseUrl: baseUrl || "https://api.openai.com/v1", model: sttModel };
    }
  }
  return null;
}

/** Transcribe an audio buffer via a Whisper-compatible endpoint, or `null`. */
async function transcribeAudio(buffer, mime, name, { llm, env, timeoutMs = 60_000, log }) {
  const stt = resolveStt(llm, env);
  if (!stt) return null;
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append("model", stt.model);
    form.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), name || "audio");
    const res = await fetch(`${stt.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stt.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      log?.({ transcribe: name, status: res.status });
      return null;
    }
    const data = await res.json().catch(() => null);
    const text = data && typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch (err) {
    log?.({ transcribe: name, error: String(err?.message || err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Produce a text representation of one materialised, non-image attachment, or
 * `null` when it cannot be turned into text. `descriptor` is what
 * `materializeAttachments` returns ({ name, path, mimeType }).
 */
export async function extractAttachmentText(descriptor, { llm, env = process.env, log } = {}) {
  if (!descriptor || descriptor.error || !descriptor.path) return null;
  const { name, path: filePath, mimeType } = descriptor;
  let buffer;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_EXTRACT_BYTES) {
      log?.({ skipped: name, reason: "over extract size cap", bytes: stat.size });
      return null;
    }
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  const mime = String(mimeType || "").toLowerCase();
  try {
    if (isPdf(mime, name)) {
      const text = extractPdfText(buffer);
      return text ? { name, kind: "document", text: clip(text) } : null;
    }
    if (isTextLike(mime, name)) {
      const text = buffer.toString("utf-8");
      return text.trim() ? { name, kind: "document", text: clip(text) } : null;
    }
    if (mime.startsWith("audio/")) {
      const text = await transcribeAudio(buffer, mimeType, name, { llm, env, log });
      return text ? { name, kind: "transcript", text: clip(text) } : null;
    }
  } catch (err) {
    log?.({ extract: name, error: String(err?.message || err) });
  }
  return null;
}

/** Extract text for every non-image attachment; preserves order, drops nulls. */
export async function extractAttachmentTexts(descriptors, opts = {}) {
  const list = Array.isArray(descriptors) ? descriptors : [];
  const out = await Promise.all(
    list
      .filter((d) => d && !String(d.mimeType || "").toLowerCase().startsWith("image/"))
      .map((d) => extractAttachmentText(d, opts)),
  );
  return out.filter(Boolean);
}
