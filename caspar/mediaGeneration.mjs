/**
 * Provider-neutral output generation for Decillion agents.
 *
 * This is an MCP tool instead of a Grok/xAI built-in so the provider selected
 * for an agent can generate chat attachments too. Adapters deliberately return
 * bytes to OutboundMediaCollector; provider URLs and credentials never enter
 * the durable space history.
 */
import { createHash } from "node:crypto";

import { creatureEnv, creatureList, creatureNumber } from "./env.mjs";
import { defaultLlm, platformKeyFor } from "./grokRunner.mjs";
import { providerIds, resolveProvider } from "./llm/providers.mjs";

const MODALITIES = new Set(["image", "audio", "video"]);
const KNOWN_OUTPUT_PROVIDERS = ["openai", "gemini", "openrouter", "xai"];
const DEFAULT_MODELS = {
  openai: { image: "gpt-image-2", audio: "gpt-4o-mini-tts" },
  gemini: {
    image: "gemini-3.1-flash-image-preview",
    audio: "gemini-3.1-flash-tts-preview",
    video: "gemini-omni-flash-preview",
  },
  openrouter: {
    image: "openai/gpt-5-image",
    audio: "openai/gpt-4o-mini-tts-2025-12-15",
    video: "google/veo-3.1-lite",
  },
  xai: { image: "grok-imagine-image" },
};
const STANDARD_KEYS = {
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  xai: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_API_KEY"],
};

export const GENERATE_MEDIA_TOOL = {
  name: "generate_media",
  description:
    "Generate an image, spoken-audio clip, or video and attach it to your Decillion chat reply. This routes through the agent's selected LLM provider when that provider supports the modality, with configured provider fallbacks. Use share_media instead for an existing URL or sandbox file.",
  inputSchema: {
    type: "object",
    required: ["modality", "prompt"],
    properties: {
      modality: { type: "string", enum: ["image", "audio", "video"], description: "The artifact to create." },
      prompt: { type: "string", description: "A complete generation prompt or the text to speak." },
      provider: { type: "string", description: "Optional provider id. Omit or use auto to prefer this agent's selected provider." },
      model: { type: "string", description: "Optional generation-capable model override for this call." },
      name: { type: "string", description: "Filename shown in the space." },
      description: { type: "string", description: "Short accessible description shown with the attachment." },
      aspect_ratio: { type: "string", description: "Requested visual aspect ratio, for example 16:9 or 1:1." },
      size: { type: "string", description: "Provider-supported image size, for example 1024x1024." },
      quality: { type: "string", description: "Provider-supported quality such as low, medium, or high." },
      format: { type: "string", enum: ["png", "jpeg", "webp", "mp3", "wav", "opus", "aac", "flac", "pcm"], description: "Preferred output format." },
      voice: { type: "string", description: "Provider-supported voice name for spoken audio." },
      duration: { type: "number", description: "Requested video duration in seconds." },
    },
  },
};

export class ProviderMediaGenerator {
  constructor({ llm, env = process.env, collector, fetchImpl = globalThis.fetch, sleep = delay, maxBytes } = {}) {
    this.llm = llm;
    this.env = env;
    this.collector = collector;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.maxBytes = positive(maxBytes, creatureNumber("MEDIA_MAX_FILE_BYTES", 10 * 1024 * 1024, env));
    this.requestTimeoutMs = positive(creatureNumber("MEDIA_REQUEST_TIMEOUT_MS", 120_000, env), 120_000);
    this.videoWaitMs = positive(creatureNumber("MEDIA_VIDEO_WAIT_SECONDS", 240, env), 240) * 1000;
  }

  /** MCP handler. A provider failure is returned to the model without a second billed attempt. */
  async generate(args = {}) {
    const modality = clean(args.modality).toLowerCase();
    const prompt = clean(args.prompt);
    if (!MODALITIES.has(modality)) return { ok: false, error: "modality must be image, audio, or video" };
    if (!prompt) return { ok: false, error: "prompt is required" };
    if (!this.collector || typeof this.collector.addGenerated !== "function") {
      return { ok: false, error: "the Decillion media attachment collector is unavailable" };
    }

    const requested = clean(args.provider).toLowerCase();
    const candidates = this._candidates(requested);
    const skipped = [];
    let route = null;
    for (const candidate of candidates) {
      if (!candidate.key) {
        skipped.push(`${candidate.id}: no configured credential`);
        continue;
      }
      if (!this._supports(candidate, modality, args)) {
        skipped.push(`${candidate.id}: ${modality} generation is not configured`);
        continue;
      }
      route = candidate;
      break;
    }
    if (!route) {
      return {
        ok: false,
        error: requested && requested !== "auto"
          ? `${requested} has no configured ${modality} generation route`
          : `no configured provider can generate ${modality}`,
        availableProviders: this._availableProviders(modality, args),
        details: skipped,
      };
    }

    try {
      const generated = await this._dispatch(route, modality, { ...args, prompt });
      const digest = createHash("sha256").update(generated.bytes).digest("hex").slice(0, 24);
      const attachment = this.collector.addGenerated({
        ...generated,
        name: clean(args.name) || generated.name,
        description: clean(args.description),
        provider: route.id,
        model: generated.model,
        key: `provider:${route.id}:${digest}`,
      });
      return {
        ok: true,
        provider: route.id,
        model: generated.model,
        attachment,
        message: `${attachment?.name || "The generated media"} will be attached to your final chat reply.`,
      };
    } catch (err) {
      return {
        ok: false,
        provider: route.id,
        error: String(err?.message || err).slice(0, 800),
        hint: "The request was not retried against another provider because it may already have been billed.",
      };
    }
  }

  _selected() {
    let llm = this.llm;
    if (!usableLlm(llm)) llm = defaultLlm(this.env) || null;
    const rawProvider = clean(llm?.provider) || "xai";
    const resolved = resolveProvider(rawProvider, {
      env: this.env,
      baseUrlOverride: clean(llm?.base_url || llm?.baseUrl),
      apiBackend: clean(llm?.api_backend || llm?.apiBackend),
    });
    const id = resolved?.id || rawProvider.toLowerCase();
    return {
      id,
      descriptor: resolved,
      key: clean(llm?.api_key || llm?.apiKey) || this._platformKey(id),
      model: firstModel(llm),
      selected: true,
    };
  }

  _candidate(id, selected) {
    const resolved = resolveProvider(id, {
      env: this.env,
      baseUrlOverride: selected?.id === id ? clean(selected.descriptor?.baseUrl) : "",
    });
    return {
      id: resolved?.id || id,
      descriptor: resolved,
      key: selected?.id === id ? selected.key : this._platformKey(resolved?.id || id),
      model: selected?.id === id ? selected.model : "",
      selected: selected?.id === id,
    };
  }

  _candidates(requested) {
    const selected = this._selected();
    if (requested && requested !== "auto") {
      const resolved = resolveProvider(requested, { env: this.env });
      const id = resolved?.id || requested;
      return [this._candidate(id, selected)];
    }
    const preferred = clean(creatureEnv("MEDIA_PROVIDER", this.env)).toLowerCase();
    const configured = creatureList("MEDIA_PROVIDERS", this.env).map((v) => v.toLowerCase());
    const ids = [selected.id, preferred, ...configured, ...KNOWN_OUTPUT_PROVIDERS].filter(Boolean);
    return [...new Set(ids)].map((id) => this._candidate(id, selected));
  }

  _platformKey(id) {
    const platform = platformKeyFor(id, this.env);
    if (platform) return platform;
    for (const name of STANDARD_KEYS[id] || []) {
      const value = clean(this.env[name]);
      if (value) return value;
    }
    return "";
  }

  _model(route, modality, args) {
    const envName = `MEDIA_MODEL_${route.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${modality.toUpperCase()}`;
    const configured = clean(creatureEnv(envName, this.env));
    const requested = clean(args.model);
    if (requested) return requested;
    if (configured) return configured;
    // A selected OpenAI GPT-5 family model can call the Responses image tool
    // itself. Other selected chat models must not be sent to a media endpoint.
    if (route.id === "openai" && modality === "image" && /^gpt-5(?:[.-]|$)/i.test(route.model)) return route.model;
    return DEFAULT_MODELS[route.id]?.[modality] || "";
  }

  _supports(route, modality, args) {
    if (!route.descriptor?.baseUrl) return false;
    const model = this._model(route, modality, args);
    if (!model) return false;
    if (route.id === "openai") return modality === "image" || modality === "audio";
    if (route.id === "gemini" || route.id === "openrouter") return true;
    if (route.id === "xai") return modality === "image";
    // Unknown OpenAI-compatible providers are opt-in per modality via a model.
    // A Messages-only provider such as Anthropic must never be sent OpenAI media
    // endpoint shapes merely because a caller supplied a model name.
    if (!["chat_completions", "responses"].includes(route.descriptor.apiBackend)) return false;
    const envName = `MEDIA_MODEL_${route.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${modality.toUpperCase()}`;
    return (modality === "image" || modality === "audio") && Boolean(clean(args.model) || clean(creatureEnv(envName, this.env)));
  }

  _availableProviders(modality, args) {
    const selected = this._selected();
    const ids = [...new Set([selected.id, ...providerIds(), ...KNOWN_OUTPUT_PROVIDERS])];
    return ids.map((id) => this._candidate(id, selected)).filter((r) => r.key && this._supports(r, modality, args)).map((r) => r.id);
  }

  async _dispatch(route, modality, args) {
    const model = this._model(route, modality, args);
    if (route.id === "gemini") return this._gemini(route, modality, model, args);
    if (route.id === "openrouter") return this._openRouter(route, modality, model, args);
    if (route.id === "openai") return this._openAi(route, modality, model, args);
    return this._openAiCompatible(route, modality, model, args);
  }

  async _openAi(route, modality, model, args) {
    if (modality === "audio") return this._speech(route, model, args, endpoint(route.descriptor.baseUrl, "audio/speech"));
    if (/^gpt-5(?:[.-]|$)/i.test(model)) {
      const tool = { type: "image_generation" };
      copyIf(tool, "size", clean(args.size));
      copyIf(tool, "quality", clean(args.quality));
      copyIf(tool, "output_format", visualFormat(args.format));
      const json = await this._json(endpoint(route.descriptor.baseUrl, "responses"), route, {
        model,
        input: args.prompt,
        tools: [tool],
        tool_choice: { type: "image_generation" },
      });
      const call = walkFind(json?.output, (v) => v?.type === "image_generation_call" && clean(v.result));
      if (!call) throw new Error("OpenAI Responses returned no image_generation_call result");
      const format = visualFormat(args.format) || "png";
      return decoded(call.result, `generated-image.${format === "jpeg" ? "jpg" : format}`, mimeForFormat(format), model);
    }
    const body = { model, prompt: args.prompt, output_format: visualFormat(args.format) || "png" };
    copyIf(body, "size", clean(args.size));
    copyIf(body, "quality", clean(args.quality));
    const json = await this._json(endpoint(route.descriptor.baseUrl, "images/generations"), route, body);
    return imageFromData(json, model, visualFormat(args.format) || "png");
  }

  async _openAiCompatible(route, modality, model, args) {
    if (modality === "audio") return this._speech(route, model, args, endpoint(route.descriptor.baseUrl, "audio/speech"));
    const body = { model, prompt: args.prompt, response_format: "b64_json" };
    copyIf(body, "size", clean(args.size));
    copyIf(body, "quality", clean(args.quality));
    const json = await this._json(endpoint(route.descriptor.baseUrl, "images/generations"), route, body);
    return imageFromData(json, model, visualFormat(args.format) || "png");
  }

  async _openRouter(route, modality, model, args) {
    const base = route.descriptor.baseUrl;
    if (modality === "audio") return this._speech(route, model, args, endpoint(base, "audio/speech"));
    if (modality === "image") {
      const body = { model, prompt: args.prompt };
      copyIf(body, "size", clean(args.size));
      copyIf(body, "quality", clean(args.quality));
      copyIf(body, "aspect_ratio", clean(args.aspect_ratio || args.aspectRatio));
      const json = await this._json(endpoint(base, "images"), route, body);
      return imageFromData(json, model, visualFormat(args.format) || "png");
    }
    return this._asyncVideo(route, model, args);
  }

  async _gemini(route, modality, model, args) {
    const root = geminiRoot(route.descriptor.baseUrl);
    if (modality === "video") {
      const responseFormat = { type: "video" };
      copyIf(responseFormat, "aspect_ratio", clean(args.aspect_ratio || args.aspectRatio));
      const json = await this._json(`${root}/interactions`, route, {
        model,
        input: args.prompt,
        response_format: responseFormat,
      }, { gemini: true, timeoutMs: this.videoWaitMs });
      const part = inlineMedia(json, "video/");
      if (!part) throw new Error("Gemini returned no inline video output");
      return decoded(part.data, "generated-video.mp4", part.mimeType || "video/mp4", model);
    }

    const generationConfig = { responseModalities: [modality === "image" ? "IMAGE" : "AUDIO"] };
    if (modality === "image") {
      const aspectRatio = clean(args.aspect_ratio || args.aspectRatio);
      if (aspectRatio) generationConfig.imageConfig = { aspectRatio };
    } else {
      const voiceName = clean(args.voice) || "Kore";
      generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName } } };
    }
    const json = await this._json(`${root}/models/${encodeURIComponent(model)}:generateContent`, route, {
      contents: [{ parts: [{ text: args.prompt }] }],
      generationConfig,
    }, { gemini: true });
    const part = inlineMedia(json, modality === "image" ? "image/" : "audio/");
    if (!part) throw new Error(`Gemini returned no inline ${modality} output`);
    if (modality === "audio" && /(?:pcm|l16)/i.test(part.mimeType)) {
      const pcm = Buffer.from(part.data, "base64");
      return { bytes: wavFromPcm16(pcm, sampleRate(part.mimeType)), mimeType: "audio/wav", name: "generated-audio.wav", model };
    }
    const format = formatForMime(part.mimeType, modality === "image" ? "png" : "wav");
    return decoded(part.data, `generated-${modality}.${format}`, part.mimeType, model);
  }

  async _speech(route, model, args, url) {
    const format = audioFormat(args.format) || "mp3";
    const response = await this._binary(url, route, {
      model,
      input: args.prompt,
      voice: clean(args.voice) || "alloy",
      response_format: format,
    });
    return { bytes: response.bytes, mimeType: response.mimeType || mimeForFormat(format), name: `generated-audio.${format}`, model };
  }

  async _asyncVideo(route, model, args) {
    const submitUrl = endpoint(route.descriptor.baseUrl, "videos");
    const body = { model, prompt: args.prompt };
    const duration = Number(args.duration);
    if (Number.isFinite(duration) && duration > 0) body.duration = duration;
    copyIf(body, "aspect_ratio", clean(args.aspect_ratio || args.aspectRatio));
    copyIf(body, "resolution", clean(args.size));
    let job = await this._json(submitUrl, route, body, { timeoutMs: this.requestTimeoutMs });
    const id = clean(job?.id);
    if (!id) throw new Error(`${route.id} returned no video job id`);
    const deadline = Date.now() + this.videoWaitMs;
    while (!completed(job)) {
      if (failed(job)) throw new Error(videoError(job));
      if (Date.now() >= deadline) throw new Error(`video generation did not finish within ${Math.round(this.videoWaitMs / 1000)} seconds`);
      await this.sleep(Math.min(3000, Math.max(10, deadline - Date.now())));
      const poll = sameOriginUrl(clean(job.polling_url || job.pollingUrl) || endpoint(route.descriptor.baseUrl, `videos/${encodeURIComponent(id)}`), submitUrl);
      job = await this._json(poll, route, undefined, { method: "GET", timeoutMs: this.requestTimeoutMs });
    }
    const download = sameOriginUrl(endpoint(route.descriptor.baseUrl, `videos/${encodeURIComponent(id)}/content?index=0`), submitUrl);
    const response = await this._binary(download, route, undefined, { method: "GET", timeoutMs: this.requestTimeoutMs });
    return { bytes: response.bytes, mimeType: response.mimeType || "video/mp4", name: "generated-video.mp4", model };
  }

  async _json(url, route, body, options = {}) {
    const method = options.method || "POST";
    const headers = authHeaders(route, options.gemini);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this._request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, options.timeoutMs);
    const bytes = await readBounded(response, Math.ceil(this.maxBytes * 1.5) + 1024 * 1024);
    const text = bytes.toString("utf-8");
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${route.id} returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(providerError(route.id, response.status, json));
    return json;
  }

  async _binary(url, route, body, options = {}) {
    const method = options.method || "POST";
    const headers = authHeaders(route, false);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this._request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, options.timeoutMs);
    if (!response.ok) {
      const bytes = await readBounded(response, 256 * 1024);
      let detail = bytes.toString("utf-8");
      try { detail = JSON.parse(detail); } catch { /* text error */ }
      throw new Error(providerError(route.id, response.status, detail));
    }
    const bytes = await readBounded(response, this.maxBytes);
    return { bytes, mimeType: clean(response.headers?.get?.("content-type")).split(";")[0] };
  }

  async _request(url, init, timeoutMs = this.requestTimeoutMs) {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable in this runtime");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), positive(timeoutMs, this.requestTimeoutMs));
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`media provider request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function usableLlm(llm) {
  if (!llm || typeof llm !== "object") return false;
  return Boolean(clean(llm.provider) || clean(llm.api_key || llm.apiKey) || firstModel(llm));
}

function firstModel(llm) {
  if (Array.isArray(llm?.models)) return clean(llm.models.find((v) => clean(v)));
  return clean(llm?.model);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function endpoint(base, suffix) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function geminiRoot(base) {
  const value = String(base || "").replace(/\/+$/, "").replace(/\/openai$/i, "");
  return /\/v1beta$/i.test(value) ? value : `${value}/v1beta`;
}

function authHeaders(route, gemini) {
  if (gemini || route.id === "gemini") return { "x-goog-api-key": route.key };
  return { authorization: `Bearer ${route.key}`, ...(route.descriptor?.headers || {}) };
}

function copyIf(target, key, value) {
  if (value !== undefined && value !== null && value !== "") target[key] = value;
}

function visualFormat(value) {
  const format = clean(value).toLowerCase();
  return ["png", "jpeg", "webp"].includes(format) ? format : "";
}

function audioFormat(value) {
  const format = clean(value).toLowerCase();
  return ["mp3", "wav", "opus", "aac", "flac", "pcm"].includes(format) ? format : "";
}

function mimeForFormat(format) {
  return ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/opus", aac: "audio/aac", flac: "audio/flac", pcm: "audio/pcm" })[format] || "application/octet-stream";
}

function formatForMime(mime, fallback) {
  const value = clean(mime).toLowerCase();
  if (value.includes("jpeg")) return "jpg";
  if (value.includes("webp")) return "webp";
  if (value.includes("png")) return "png";
  if (value.includes("mpeg")) return "mp3";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("wav")) return "wav";
  if (value.includes("mp4")) return "mp4";
  return fallback;
}

function decoded(base64, name, mimeType, model) {
  const bytes = Buffer.from(clean(base64), "base64");
  if (!bytes.length) throw new Error("provider returned empty media bytes");
  return { bytes, name, mimeType: clean(mimeType).split(";")[0] || "application/octet-stream", model };
}

function imageFromData(json, model, fallbackFormat) {
  const row = Array.isArray(json?.data) ? json.data[0] : null;
  const base64 = clean(row?.b64_json || row?.b64Json || row?.data);
  if (!base64) throw new Error("image provider returned no base64 image data");
  const mimeType = clean(row?.media_type || row?.mime_type || row?.mimeType) || mimeForFormat(fallbackFormat);
  const format = formatForMime(mimeType, fallbackFormat);
  return decoded(base64, `generated-image.${format === "jpeg" ? "jpg" : format}`, mimeType, model);
}

function walkFind(value, predicate, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = walkFind(child, predicate, depth + 1);
      if (found) return found;
    }
  } else if (typeof value === "object") {
    for (const child of Object.values(value)) {
      const found = walkFind(child, predicate, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function inlineMedia(json, mimePrefix) {
  const found = walkFind(json, (value) => {
    if (!value || typeof value !== "object") return false;
    const data = clean(value.data);
    const mimeType = clean(value.mimeType || value.mime_type);
    return Boolean(data && mimeType.toLowerCase().startsWith(mimePrefix));
  });
  return found ? { data: found.data, mimeType: clean(found.mimeType || found.mime_type) } : null;
}

function sampleRate(mime) {
  const match = clean(mime).match(/rate=(\d+)/i);
  return match ? positive(match[1], 24000) : 24000;
}

export function wavFromPcm16(pcmLike, rate = 24000, channels = 1) {
  const pcm = Buffer.isBuffer(pcmLike) ? pcmLike : Buffer.from(pcmLike || []);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error(`provider response exceeds ${maxBytes} bytes`);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`provider response exceeds ${maxBytes} bytes`);
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
        throw new Error(`provider response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function providerError(provider, status, payload) {
  const message = clean(payload?.error?.message || payload?.message || (typeof payload === "string" ? payload : ""));
  return `${provider} generation failed with HTTP ${status}${message ? `: ${message.slice(0, 500)}` : ""}`;
}

function completed(job) {
  return ["completed", "succeeded", "success", "done"].includes(clean(job?.status).toLowerCase());
}

function failed(job) {
  return ["failed", "cancelled", "canceled", "error"].includes(clean(job?.status).toLowerCase());
}

function videoError(job) {
  return clean(job?.error?.message || job?.error || job?.message) || `video generation ${clean(job?.status) || "failed"}`;
}

function sameOriginUrl(candidate, base) {
  const url = new URL(candidate, base);
  if (url.origin !== new URL(base).origin) throw new Error("provider polling URL changed origin");
  return url.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
