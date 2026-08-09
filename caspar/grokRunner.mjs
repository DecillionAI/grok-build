/**
 * Running Grok Build headless, once per prompt.
 *
 * The agent loop itself is Grok's: we drive it in headless mode with
 * `--output-format streaming-messages-json`, which emits one JSON message per
 * line for every step it takes (thinking, tool calls, tool results, the final
 * result) in the Messages `stream-json` wire shape. Those lines are what this
 * creature restreams to the Decillion client, so the product shows a live
 * trajectory instead of a spinner.
 *
 * Everything the platform sends per prompt is applied here:
 *   • the agent's skill → `--rules` (appended to Grok's own system prompt)
 *   • the space's creatures → an MCP server in the run's `$GROK_HOME/config.toml`
 *   • the agent's LLM override (`config.llm`) → a `[model.<id>]` endpoint entry
 *   • the run's wall-clock budget → a hard kill, so a stuck run still answers
 *
 * Grok takes no prompt on stdin in headless mode, so the (unbounded) user turn is
 * written to a file and passed with `--prompt-file`.
 *
 * Privileges: an autonomous creature has no human to approve tool calls, so it
 * runs with `--permission-mode bypassPermissions`. When the container starts as
 * root we still drop to an unprivileged user for the child — an agent that can
 * rewrite its own container is a much larger blast radius than the run needs.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { creatureEnv, creatureFlag, creatureList, creatureNumber } from "./env.mjs";
import { writeGrokHome } from "./grokConfig.mjs";
import { nativeProvider, providerIds, resolveProvider } from "./llm/providers.mjs";

/** Env vars that would leak *this* process's session identity into the child. */
const STRIPPED_ENV = ["GROK_SESSION_ID", "GROK_CODE_SESSION_ID", "GROK_ENTRYPOINT", "GROK_LOG_SAMPLING"];

/**
 * Locate the Grok Build CLI. The binary built from this repository wins (that is
 * the code the operator deployed); otherwise `grok` on PATH is used.
 */
export function resolveCli(env = process.env) {
  const explicit = (env.GROK_BIN || env.GROK_CODE_BIN || "").trim();
  const candidates = [explicit, "/app/bin/grok", "/app/bin/xai-grok-pager", "/usr/local/bin/grok"].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return { command: candidate, prefixArgs: [] };
  }
  if (explicit && !explicit.includes("/")) return { command: explicit, prefixArgs: [] };
  return { command: "grok", prefixArgs: [] };
}

/**
 * The unprivileged identity the CLI runs under when this process is root.
 * Returns `null` when we are already unprivileged or no such user exists.
 */
export function dropTarget({ env = process.env, uid = typeof process.getuid === "function" ? process.getuid() : 1 } = {}) {
  if (uid !== 0) return null;
  // An explicitly empty `GROK_CREATURE_USER` means "do not drop privileges";
  // only an *unset* variable falls back to the image's `grok` user.
  const configured = creatureEnv("USER", env);
  const name = (configured === undefined ? "grok" : configured).trim();
  if (!name || name === "root") return null;
  let entry;
  try {
    entry = fs
      .readFileSync("/etc/passwd", "utf-8")
      .split("\n")
      .map((line) => line.split(":"))
      .find((cols) => cols[0] === name);
  } catch {
    return null;
  }
  if (!entry) return null;
  const targetUid = Number(entry[2]);
  const targetGid = Number(entry[3]);
  if (!Number.isFinite(targetUid) || targetUid === 0) return null;
  return { name, uid: targetUid, gid: targetGid, home: entry[5] || `/home/${name}` };
}

/**
 * Every credential the CLI can authenticate with. When an agent brings its own,
 * the others must go: the platform's key must never pay for a run the agent's own
 * provider was supposed to pay for.
 */
const CREDENTIAL_ENV = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_API_KEY", "XAI_AUTH_TOKEN"];

/**
 * Translate a per-agent LLM override into child env + model selection.
 *
 * Decillion stores an optional `{provider, model, apiKey}` per agent and sends it
 * as `config.llm` = `{provider, models:[model], api_key}` with every prompt — the
 * same block davinci read. All three parts are honoured here:
 *
 *   • `api_key`  → the run authenticates as that key, and every other credential
 *                  the image carries is removed for this run;
 *   • `models[0]`→ `--model` for the run;
 *   • `provider` → routed to the right endpoint. Grok speaks OpenAI Chat
 *                  Completions, OpenAI Responses and the Anthropic Messages API
 *                  natively, so every provider is a generated `[model.<id>]`
 *                  config entry — no translation proxy anywhere.
 *
 * A provider with no `api_key` (nothing to authenticate with), or one with no
 * endpoint at all, falls back to the image's default backbone and says so in the
 * VM log and the reply's `warnings` — never failing silently.
 *
 * Returns `{ model, modelConfig, warning, provider, credential }`; `modelConfig`
 * is what `grokConfig.mjs` writes into the run's `config.toml`.
 */
export function applyLlmOverride(env, llm) {
  const none = { model: undefined, modelConfig: undefined, warning: undefined, provider: undefined, credential: undefined };
  if (!llm || typeof llm !== "object") return none;
  const provider = String(llm.provider || "").trim().toLowerCase();
  const model =
    (Array.isArray(llm.models) && llm.models.find((m) => typeof m === "string" && m.trim())) ||
    (typeof llm.model === "string" ? llm.model : undefined);
  const apiKey = (typeof llm.api_key === "string" && llm.api_key.trim()) || (typeof llm.apiKey === "string" && llm.apiKey.trim()) || "";
  const baseUrl = (typeof llm.base_url === "string" && llm.base_url.trim()) || (typeof llm.baseUrl === "string" && llm.baseUrl.trim()) || "";
  const apiBackend = (typeof llm.api_backend === "string" && llm.api_backend.trim()) || (typeof llm.apiBackend === "string" && llm.apiBackend.trim()) || "";
  const modelId = model && model.trim() ? model.trim() : undefined;

  /** Drop every credential the image baked in, so only the agent's own is used. */
  const takeOver = () => {
    for (const key of CREDENTIAL_ENV) delete env[key];
  };

  const resolved = resolveProvider(provider, { env, baseUrlOverride: baseUrl, apiBackend });

  // No provider named at all: an explicit model (and key) on the creature's own
  // backbone.
  if (!provider && !baseUrl) {
    if (apiKey) {
      takeOver();
      env.XAI_API_KEY = apiKey;
      return { ...none, model: modelId, provider: nativeProvider().id, credential: "agent:XAI_API_KEY" };
    }
    return { ...none, model: modelId, provider: nativeProvider().id };
  }

  if (!resolved) {
    return {
      ...none,
      model: modelId,
      provider: provider || "unknown",
      warning:
        `LLM provider "${provider}" is not a known backbone (${providerIds().join(", ")}) and carries no base_url — ` +
        "this run used the creature's default backbone.",
    };
  }

  if (!modelId) {
    return {
      ...none,
      provider: resolved.id,
      warning: `LLM provider "${resolved.id}" was selected but the agent names no model — this run used the creature's default backbone.`,
    };
  }

  // The native provider with no key of its own: the image's credential serves it,
  // and the model id is passed straight through to the built-in catalog.
  if (resolved.native && !apiKey) return { ...none, model: modelId, provider: resolved.id };

  if (!apiKey) {
    return {
      ...none,
      provider: resolved.id,
      warning:
        `LLM provider "${resolved.id}" was selected but the agent carries no api_key — ` +
        "this run used the creature's default backbone instead.",
    };
  }

  takeOver();
  // The endpoint entry the CLI will use for this run. The key lives only in the
  // run's own config file (0600, in the thread's config dir), never in the child's
  // environment where a subprocess or a crash dump could carry it further.
  const modelConfig = {
    name: modelId,
    model: modelId,
    baseUrl: resolved.baseUrl,
    apiKey,
    apiBackend: resolved.apiBackend,
    authScheme: resolved.authScheme,
    headers: resolved.headers,
    contextWindow: Number(llm.context_window || llm.contextWindow || 0) || undefined,
    // Request-shape + resilience knobs. The agent may override
    // `stream_tool_calls` explicitly; otherwise the provider default applies
    // (openai → false, to avoid the Responses tool-call-streaming stall). The
    // idle timeout + retries bound a wedged inference so one stalled request
    // aborts and retries instead of hanging the whole run on a step.
    streamToolCalls:
      typeof llm.stream_tool_calls === "boolean"
        ? llm.stream_tool_calls
        : typeof llm.streamToolCalls === "boolean"
          ? llm.streamToolCalls
          : resolved.streamToolCalls,
    inferenceIdleTimeoutSec:
      Number(llm.inference_idle_timeout_secs || llm.inferenceIdleTimeoutSec || 0) ||
      creatureNumber("INFERENCE_IDLE_TIMEOUT", 180, env),
    maxRetries: Number.isFinite(Number(llm.max_retries)) ? Number(llm.max_retries) : creatureNumber("LLM_MAX_RETRIES", 4, env),
  };
  return { model: modelId, modelConfig, warning: undefined, provider: resolved.id, credential: `agent:${resolved.id}` };
}

/**
 * The creature's own default backbone, as an `llm` block.
 *
 * A deploy can bake `GROK_CREATURE_LLM_PROVIDER` + `_API_KEY` (+ `_MODEL`,
 * `_BASE_URL`) so that agents which bring **no** provider of their own still run
 * on something other than xAI — an operator whose platform key is an OpenAI or
 * OpenRouter key, say. It is applied through exactly the same path as a per-agent
 * override, so there is one code path for "which endpoint serves this run"; a
 * per-agent `config.llm` always wins, because it is only consulted when there is
 * none. With nothing baked, this returns `null` and the image's `XAI_API_KEY`
 * serves the run.
 */
export function defaultLlm(env = process.env) {
  const provider = String(creatureEnv("LLM_PROVIDER", env) || "").trim();
  const apiKey = String(creatureEnv("LLM_API_KEY", env) || "").trim();
  if (!provider || !apiKey) return null;
  const model = String(creatureEnv("LLM_MODEL", env) || creatureEnv("MODEL", env) || "").trim();
  const baseUrl = String(creatureEnv("LLM_BASE_URL", env) || "").trim();
  return { provider, api_key: apiKey, ...(model ? { models: [model] } : {}), ...(baseUrl ? { base_url: baseUrl } : {}) };
}

/** True when the task carried no usable per-agent LLM override. */
function hasAgentLlm(llm) {
  if (!llm || typeof llm !== "object") return false;
  const provider = String(llm.provider || "").trim();
  const model = (Array.isArray(llm.models) && llm.models.find((m) => typeof m === "string" && m.trim())) || (typeof llm.model === "string" ? llm.model.trim() : "");
  const apiKey = String(llm.api_key || llm.apiKey || "").trim();
  return Boolean(provider || model || apiKey);
}

/** Build the child environment: inherited, scrubbed, then per-run overrides. */
export function buildChildEnv({ env = process.env, llm, grokHome, home, extra = {} } = {}) {
  const childEnv = { ...env };
  for (const key of STRIPPED_ENV) delete childEnv[key];
  // No per-agent provider: fall back to the operator's baked default backbone,
  // when there is one.
  if (!hasAgentLlm(llm)) llm = defaultLlm(env) || llm;
  // Never let the CLI try to draw a TUI or auto-update inside a creature.
  childEnv.CI = childEnv.CI || "1";
  childEnv.TERM = childEnv.TERM || "dumb";
  childEnv.NO_COLOR = childEnv.NO_COLOR || "1";
  if (home) childEnv.HOME = home;
  const { model, modelConfig, warning, provider, credential } = applyLlmOverride(childEnv, llm);
  if (grokHome) childEnv.GROK_HOME = grokHome;
  Object.assign(childEnv, extra);
  return { env: childEnv, model, modelConfig, warning, provider, credential };
}

/** How this run will authenticate, for the boot log. Never the credential itself. */
export function credentialSource(env) {
  if (env.XAI_API_KEY) return "XAI_API_KEY";
  if (env.GROK_CODE_XAI_API_KEY) return "GROK_CODE_XAI_API_KEY";
  if (env.GROK_API_KEY) return "GROK_API_KEY";
  return "session"; // a persisted `grok login` in the thread's GROK_HOME, or none
}

/**
 * Grok's built-in shell + filesystem tools, across every agent profile it ships
 * (the stock `run_terminal_cmd`/`read_file`/… set plus the ported codex/opencode
 * and hashline names). A Decillion agent must NOT run commands or touch files on
 * its own private, ephemeral container — that work is invisible to the rest of the
 * team and thrown away when the container recycles. All shell/filesystem work goes
 * through the space's shared cloud sandbox instead, where teammates see the same
 * files and output. So these built-ins are turned OFF (`--disallowed-tools`)
 * unconditionally — they must not even be a silent fallback.
 *
 * Planning and web tools (`todo_write`, plan mode, `web_search`, `web_fetch`)
 * are deliberately NOT here — only shell + files, plus the background-task family.
 *
 * The background-task family — `task` (spawn a subagent) and its monitors
 * `get_task_output` / `kill_task` / `wait_tasks` / `monitor` — IS denied here as a
 * unit. The grok binary couples them: `task` is rejected at session init unless
 * `get_task_output` AND `kill_task` are also in the toolset ("task requires … so
 * spawned background subagents can be monitored and cancelled"), and those
 * monitors are not present in the base toolset for us to keep — so the only
 * self-consistent no-sandbox state is *all of them off*. Denying just the
 * monitors (leaving `task` on) — or just `task` (leaving a dangling monitor on) —
 * makes init fail with `RequirementError { tool: GrokBuild:task }`. A subagent
 * without a sandbox would have no shell/filesystem anyway, so losing delegation
 * in the no-sandbox path costs nothing. With a sandbox the whole deny list is
 * skipped (`disallowedBuiltinTools` returns []), so `task` stays on where it works.
 */
export const DEFAULT_BUILTIN_FS_TOOLS = [
  "run_terminal_cmd",
  "run_terminal_command",
  "bash",
  "get_terminal_command_output",
  "kill_terminal_command",
  "task",
  "get_task_output",
  "kill_task",
  "wait_tasks",
  "monitor",
  "read_file",
  "read",
  "hashline_read",
  "write",
  "edit",
  "search_replace",
  "hashline_edit",
  "apply_patch",
  "list_dir",
  "glob",
  "grep",
  "grep_files",
  "hashline_grep",
];
// NB: `search_tool` / `use_tool` are the MCP meta-tools — how the agent reaches the
// space's creatures at all — and must never appear in a deny list. Grok keeps them
// on regardless of an allowlist, but a deny list would still strip them.

/**
 * Which built-in tools to deny for this run.
 *
 * Two modes:
 *
 *   1. **Sandbox backend active** (`opts.sandboxActive === true`): grok's
 *      built-in `bash` / `read_file` / `edit` / `list_dir` / `glob` / `grep` /
 *      `task` / `get_task_output` / `kill_task` / … route to the space's
 *      shared sandbox through the Rust `SandboxTerminalBackend` +
 *      `SandboxFileSystem`. Nothing needs disabling — they are literally the
 *      way the agent reaches the sandbox now. Returning `[]` also unblocks
 *      the `task` tool's requirement on `get_task_output` + `kill_task`,
 *      which the old deny list stripped and which caused
 *      "Requirements unsatisfied: [RequirementError { tool: GrokBuild:task }]"
 *      at session init.
 *
 *   2. **No sandbox** (self-tests, local dev): keep the legacy behaviour —
 *      deny the whole shell + filesystem set so an agent never does throwaway
 *      work inside its private container that its teammates never see. This
 *      is the pre-sandbox-backend behaviour.
 *
 * `GROK_CREATURE_FORCE_SANDBOX_FS=0` turns the enforcement off entirely;
 * `GROK_CREATURE_DISALLOWED_TOOLS` overrides the exact list.
 */
export function disallowedBuiltinTools({ env = process.env, sandboxActive = false } = {}) {
  if (sandboxActive) return [];
  if (!creatureFlag("FORCE_SANDBOX_FS", true, env)) return [];
  const override = creatureList("DISALLOWED_TOOLS", env);
  if (override.length) return override;
  return [...DEFAULT_BUILTIN_FS_TOOLS];
}

/** A per-run temporary directory (sockets, the prompt file). */
export function runTempDir(prefix = "caspar-run-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * The CLI's config/state directory (`GROK_HOME`) for one conversation thread.
 *
 * It is **per thread, not per run**: Grok stores a session's transcript under
 * `$GROK_HOME/sessions`, and `--resume` can only find a session in the home that
 * created it — a fresh directory per prompt would start every turn from nothing.
 *
 * It must also be writable by the user the CLI runs as. The creature's default is
 * `/data/grok-config`, under the VM's persistent mount — which the node commonly
 * mounts **root-owned**, so the unprivileged child could not write it. So the
 * configured root is used only when it can actually be created and written;
 * otherwise we fall back to the run's HOME, then a temp dir. Returns `undefined`
 * only if nothing is writable, letting the CLI use its own default.
 */
export function resolveGrokHome({ configured, slug = "default", home, uid, gid } = {}) {
  const base = home || os.homedir() || os.tmpdir();
  const roots = [configured, path.join(base, ".grok-config"), path.join(os.tmpdir(), "caspar-grok-config")].filter(Boolean);
  for (const root of roots) {
    const dir = path.join(root, slug);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (Number.isFinite(uid) && Number.isFinite(gid)) {
        try {
          fs.chownSync(root, uid, gid);
          fs.chownSync(dir, uid, gid);
        } catch {
          /* best effort: a pre-owned dir is fine */
        }
      }
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/**
 * Copy a persisted `grok login` into the thread's config dir.
 *
 * The image normally authenticates with a baked `XAI_API_KEY`, but an operator can
 * instead log the host in once (`grok login --device-auth`) and point
 * `GROK_CREATURE_AUTH_FILE` at the resulting `auth.json`. Each thread's home then
 * gets a copy, so every run authenticates without a key in the environment.
 */
export function seedAuth(grokHome, { env = process.env, uid, gid } = {}) {
  const source = String(creatureEnv("AUTH_FILE", env) || "").trim();
  if (!source || !grokHome) return false;
  const target = path.join(grokHome, "auth.json");
  try {
    if (!fs.existsSync(source)) return false;
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) return true;
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    if (Number.isFinite(uid) && Number.isFinite(gid)) fs.chownSync(target, uid, gid);
    return true;
  } catch {
    return false;
  }
}

/** A session id Grok accepts for a NEW session: a lowercase UUID v4. */
export function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Run one prompt to completion.
 *
 * @param opts.prompt         the user turn (written to a file: `--prompt-file`)
 * @param opts.systemPrompt   appended to Grok's own system prompt (`--rules`)
 * @param opts.cwd            the session workspace
 * @param opts.mcpServers     `{ [name]: {command,args,env} }` for the run's config.toml
 * @param opts.llm            the agent's LLM override from `config.llm`
 * @param opts.model          explicit model (overridden by `llm.models[0]`)
 * @param opts.threadSlug     conversation key — picks the thread's GROK_HOME
 * @param opts.maxWallSeconds hard wall-clock ceiling for the run
 * @param opts.onMessage      called with every parsed stream-json message
 * @param opts.onStderr       called with the child's stderr chunks (diagnostics)
 * @param opts.extraEnv       extra env vars merged into the child (used e.g.
 *                            to point the child at the sandbox bridge socket
 *                            via `GROK_SANDBOX_SOCKET`).
 * @returns `{ result, messages, exitCode, timedOut, stderr, argv, warnings, backbone, sessionId }`
 */
export async function runGrok(opts) {
  const {
    prompt,
    systemPrompt,
    cwd,
    mcpServers,
    llm,
    model,
    threadSlug = "default",
    maxWallSeconds = creatureNumber("MAX_WALL_SECONDS", 900),
    permissionMode = String(creatureEnv("PERMISSION_MODE") || "bypassPermissions").trim(),
    allowedTools,
    disallowedTools,
    extraArgs = [],
    onMessage,
    onStderr,
    env = process.env,
    tempDir,
    extraEnv,
  } = opts;

  const warnings = [];
  const drop = dropTarget({ env });
  const runDir = tempDir || runTempDir();

  const requestedRoot = String(creatureEnv("CONFIG_DIR", env) || "").trim() || undefined;
  const grokHome = resolveGrokHome({
    configured: requestedRoot,
    slug: threadSlug,
    home: drop ? drop.home : undefined,
    uid: drop ? drop.uid : undefined,
    gid: drop ? drop.gid : undefined,
  });
  if (requestedRoot && grokHome && !grokHome.startsWith(requestedRoot)) {
    // The CLI aborts before emitting any output when it cannot write its home, so
    // a fallback here is the difference between a real answer and a silent failure.
    warnings.push(`GROK_HOME root ${requestedRoot} is not writable by the agent user; using ${grokHome} instead`);
  }

  const {
    env: childEnv,
    model: llmModel,
    modelConfig,
    warning,
    provider,
    credential,
  } = buildChildEnv({
    env,
    llm,
    grokHome,
    home: drop ? drop.home : undefined,
    extra: extraEnv && typeof extraEnv === "object" ? extraEnv : undefined,
  });
  if (warning) warnings.push(warning);

  const chosenModel = llmModel || model;
  // The run's config: the space's creatures as an MCP server, plus the agent's own
  // provider endpoint when it brought one.
  if (grokHome) {
    try {
      writeGrokHome(
        grokHome,
        { mcpServers: mcpServers || {}, model: modelConfig, defaultModel: modelConfig ? modelConfig.name : undefined },
        drop ? { uid: drop.uid, gid: drop.gid } : {},
      );
      seedAuth(grokHome, { env, uid: drop?.uid, gid: drop?.gid });
    } catch (err) {
      warnings.push(`could not write the run config (${err?.message || err}); the space's tools may be unavailable to the agent`);
    }
  } else if (mcpServers && Object.keys(mcpServers).length) {
    warnings.push("no writable GROK_HOME: the space's tools could not be wired for this run");
  }

  // What this run will authenticate as — reported so an operator can tell an
  // agent's own key from the image's, without either ever being logged.
  const backbone = {
    provider: provider || nativeProvider().id,
    credential: credential || credentialSource(childEnv),
    auth: modelConfig ? "run-config" : credentialSource(childEnv),
    ...(modelConfig ? { endpoint: modelConfig.baseUrl, api: modelConfig.apiBackend } : {}),
  };

  fs.mkdirSync(cwd, { recursive: true });
  // Grok reads no prompt from stdin in headless mode, so the turn goes to a file.
  const promptFile = path.join(runDir, "prompt.txt");
  fs.writeFileSync(promptFile, String(prompt ?? ""), { mode: 0o600 });

  const { command, prefixArgs } = resolveCli(env);
  const args = [
    ...prefixArgs,
    "--prompt-file",
    promptFile,
    "--output-format",
    "streaming-messages-json",
    "--cwd",
    cwd,
    "--permission-mode",
    permissionMode,
    // A creature's workspace is created by this process, so there is no human to
    // answer a folder-trust prompt for it.
    "--trust",
    "--no-auto-update",
    // The persona and the whole conversation are composed by the platform; the
    // prompt is already final.
    "--verbatim",
  ];
  if (chosenModel) args.push("--model", chosenModel);
  const sessionId = newSessionId();
  args.push("--session-id", sessionId);
  if (allowedTools?.length) args.push("--tools", allowedTools.join(","));
  if (disallowedTools?.length) args.push("--disallowed-tools", disallowedTools.join(","));
  if (systemPrompt) args.push("--rules", systemPrompt);
  const maxTurns = creatureNumber("MAX_TURNS", 0, env);
  if (maxTurns > 0) args.push("--max-turns", String(Math.floor(maxTurns)));
  if (creatureFlag("DISABLE_WEB_SEARCH", false, env)) args.push("--disable-web-search");
  args.push(...extraArgs);

  if (drop) {
    // Everything the child touches — its workspace (including files this process
    // wrote into it, e.g. attachments), the run dir and its config home — must
    // belong to the user it runs as.
    for (const dir of [drop.home, runDir].filter(Boolean)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.chownSync(dir, drop.uid, drop.gid);
      } catch {
        /* best effort: a pre-owned dir is fine */
      }
    }
    try {
      fs.chownSync(promptFile, drop.uid, drop.gid);
    } catch {
      /* best effort */
    }
    chownTree(cwd, drop.uid, drop.gid);
  }

  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(drop ? { uid: drop.uid, gid: drop.gid } : {}),
  });

  const messages = [];
  let result = null;
  let stderr = "";
  let stdoutTail = "";
  let timedOut = false;

  const killTimer = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
    },
    Math.max(1, maxWallSeconds) * 1000,
  );

  let buffer = "";
  const processLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON noise on stdout (a warning from a wrapper, say) — keep a tail
      // for diagnostics, never fail the run over it.
      stdoutTail = `${stdoutTail}${line}\n`.slice(-2000);
      return;
    }
    messages.push(message);
    if (message?.type === "result") result = message;
    if (onMessage) {
      try {
        onMessage(message);
      } catch {
        /* a listener must not break the run */
      }
    }
  };
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      processLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
    if (onStderr) {
      try {
        onStderr(chunk);
      } catch {
        /* ignore */
      }
    }
  });

  const spawnFailure = new Promise((resolve) => child.once("error", (err) => resolve(err)));
  const exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));

  // Nothing is sent on stdin (the prompt is a file), but the CLI must still see
  // its input close or it can wait on a terminal that will never speak.
  try {
    child.stdin.end();
  } catch {
    /* the child may already be gone; `close` reports it */
  }

  const outcome = await Promise.race([exited, spawnFailure]);
  clearTimeout(killTimer);
  // The child has closed and every stdout chunk has been delivered: flush any
  // final line the CLI emitted WITHOUT a trailing newline. A `type:"result"` that
  // arrives unterminated — a run SIGTERM'd mid-line, or stdout truncated as the
  // process exits — would otherwise sit unparsed in `buffer` and be dropped,
  // turning a run that actually answered into a "produced no result" failure.
  if (buffer.trim()) processLine(buffer);
  buffer = "";
  try {
    fs.rmSync(promptFile, { force: true });
  } catch {
    /* best effort */
  }

  const argv = [command, ...args];
  if (outcome instanceof Error) {
    return { result: null, messages, exitCode: null, timedOut, stderr: `${outcome.message}\n${stderr}`, argv, warnings, stdoutTail, backbone, sessionId };
  }
  return { result, messages, exitCode: outcome, timedOut, stderr, argv, warnings, stdoutTail, backbone, sessionId };
}

/**
 * Hand a directory tree to the unprivileged user the CLI runs as. Bounded and
 * best-effort: a workspace we cannot fully chown is still usable, and a session
 * with thousands of files must not stall the run.
 */
function chownTree(root, uid, gid, budget = 5000) {
  const stack = [root];
  let remaining = budget;
  while (stack.length && remaining-- > 0) {
    const current = stack.pop();
    try {
      fs.chownSync(current, uid, gid);
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      }
    } catch {
      /* best effort */
    }
  }
}
