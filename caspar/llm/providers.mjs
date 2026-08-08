/**
 * Per-agent LLM providers, served by Grok Build natively.
 *
 * Decillion stores an optional `{provider, model, apiKey}` per agent and sends it
 * as `config.llm` with every prompt. Grok Build speaks three wire protocols
 * out of the box — OpenAI Chat Completions, OpenAI Responses and the Anthropic
 * Messages API — and picks one per model through a `[model.<id>]` entry in its
 * config (see `crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md`).
 * So a provider override needs no translation proxy at all: it is a generated
 * config entry plus `--model`.
 *
 * Each entry here is exactly what that config entry needs:
 *
 *   baseUrl     the provider's OpenAI-/Anthropic-compatible endpoint root;
 *   apiBackend  `chat_completions` | `responses` | `messages`;
 *   authScheme  `bearer` (default) or `x_api_key` (Anthropic);
 *   headers     extra headers the provider requires (Anthropic's version pin).
 *
 * An operator can repoint any provider with `GROK_CREATURE_LLM_BASE_<PROVIDER>`
 * (e.g. an Azure/OpenAI gateway), and an agent may set `llm.base_url` itself.
 */

import { creatureEnv } from "../env.mjs";

/** The provider table. `native` is the creature's own backbone (xAI). */
const PROVIDERS = [
  {
    id: "xai",
    aliases: ["grok", "x.ai", "x-ai", "spacexai", "grok-build"],
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiBackend: "chat_completions",
    native: true,
  },
  {
    id: "openai",
    aliases: ["open-ai", "chatgpt"],
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    // OpenAI's newer reasoning models (gpt-5.x, o1-*, o3-*, luna, sol) reject
    // `/v1/chat/completions` when function tools are attached together with a
    // non-none `reasoning_effort`:
    //     "Function tools with reasoning_effort are not supported for
    //      gpt-5.6-sol in /v1/chat/completions. To use function tools, use
    //      /v1/responses or set reasoning_effort to 'none'."
    // The Responses API is a superset that works for both reasoning and
    // non-reasoning models, so defaulting the provider to it fixes the
    // reasoning-model case without breaking older gpt-4o / gpt-4-turbo runs.
    // An operator (or an agent's `llm.api_backend`) can still override.
    apiBackend: "responses",
  },
  {
    id: "anthropic",
    aliases: ["claude", "claude-code", "claude_code"],
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiBackend: "messages",
    // Anthropic authenticates with `x-api-key`, not a bearer token, and refuses a
    // request that does not pin the API version.
    authScheme: "x_api_key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  {
    id: "gemini",
    aliases: ["google", "google-ai", "googleai"],
    label: "Google Gemini",
    // Gemini's OpenAI-compatible surface.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiBackend: "chat_completions",
  },
  {
    id: "openrouter",
    aliases: ["open-router"],
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiBackend: "chat_completions",
  },
  {
    id: "groq",
    aliases: [],
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiBackend: "chat_completions",
  },
  {
    id: "deepseek",
    aliases: ["deep-seek"],
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiBackend: "chat_completions",
  },
  {
    id: "mistral",
    aliases: ["mistralai"],
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiBackend: "chat_completions",
  },
  {
    id: "together",
    aliases: ["togetherai", "together-ai"],
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    apiBackend: "chat_completions",
  },
];

const BY_KEY = new Map();
for (const provider of PROVIDERS) {
  BY_KEY.set(provider.id, provider);
  for (const alias of provider.aliases) BY_KEY.set(alias, provider);
}

/** Every provider id an agent can name (for messages the operator reads). */
export function providerIds() {
  return PROVIDERS.map((p) => p.id);
}

/** The creature's own default provider — what an un-overridden run uses. */
export function nativeProvider() {
  return PROVIDERS.find((p) => p.native);
}

/** `openrouter` → `GROK_CREATURE_LLM_BASE_OPENROUTER`. */
export function baseUrlEnvName(providerId) {
  return `LLM_BASE_${String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Resolve a provider id to its endpoint descriptor.
 *
 * Precedence for the endpoint: the agent's own `llm.base_url`, then an
 * operator's `GROK_CREATURE_LLM_BASE_<PROVIDER>`, then the table's default.
 *
 * An unknown provider still resolves **when a base URL is available**, so a
 * self-hosted or brand-new OpenAI-compatible endpoint works without a code
 * change; with no endpoint to call, it resolves to `null` and the caller falls
 * back to the creature's default backbone (and says so in the reply's warnings).
 */
export function resolveProvider(id, { env = process.env, baseUrlOverride = "", apiBackend = "" } = {}) {
  const key = String(id || "").trim().toLowerCase();
  const known = BY_KEY.get(key);
  const configured = String(creatureEnv(baseUrlEnvName(key || "default"), env) || "").trim();
  const baseUrl = String(baseUrlOverride || "").trim() || configured || known?.baseUrl || "";
  if (!known && !baseUrl) return null;
  const backend = String(apiBackend || "").trim() || known?.apiBackend || "chat_completions";
  return {
    id: known?.id || key || "custom",
    label: known?.label || key || "custom endpoint",
    baseUrl,
    apiBackend: backend,
    authScheme: known?.authScheme || "bearer",
    headers: { ...(known?.headers || {}) },
    native: Boolean(known?.native),
  };
}
