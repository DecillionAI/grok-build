/**
 * The per-run Grok config directory.
 *
 * Grok Build reads its MCP servers and its custom model endpoints from
 * `$GROK_HOME/config.toml` — there is no `--mcp-config` flag and no per-provider
 * CLI switch. So everything the platform sends per prompt that the CLI has to
 * learn from configuration is written here, into a **fresh directory per run**:
 *
 *   • the space's creatures → `[mcp_servers.caspar]`, a stdio server this
 *     process serves over a unix socket (see `mcpStdioServer.mjs`);
 *   • the agent's LLM override (`config.llm`) → `[model.<id>]` with the
 *     provider's endpoint, protocol and the agent's own key.
 *
 * A fresh directory per run matters for both: one prompt's tool socket must never
 * leak into the next prompt's session, and an agent's API key must not sit in a
 * shared config file where the next agent's run would pick it up.
 */

import fs from "node:fs";
import path from "node:path";

/** Quote a TOML string value (basic strings: escape `\` and `"`). */
function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A bare key when it is bare-safe, else a quoted key. */
function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(String(key)) ? String(key) : tomlString(key);
}

/** `{a: "1"}` → `{ a = "1" }` (an inline table; empty → omitted by callers). */
function tomlInlineTable(record) {
  const entries = Object.entries(record || {}).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  if (!entries.length) return "";
  return `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ")} }`;
}

/**
 * Render `config.toml`.
 *
 * @param opts.mcpServers `{ [name]: { command, args, env, startupTimeoutSec, toolTimeoutSec } }`
 * @param opts.model      `{ name, model, baseUrl, apiKey, apiBackend, authScheme, headers, contextWindow }`
 * @param opts.defaultModel model name for `[models].default`
 */
export function renderConfigToml({ mcpServers = {}, model, defaultModel } = {}) {
  const lines = [
    "# Generated per prompt by the Caspar creature bridge — do not edit.",
    "# It carries this run's MCP tool server and, when the agent brought its own",
    "# LLM provider, that provider's endpoint. A fresh copy is written per run.",
    "",
  ];

  if (defaultModel) {
    lines.push("[models]", `default = ${tomlString(defaultModel)}`, "");
  }

  if (model && model.name) {
    lines.push(`[model.${tomlKey(model.name)}]`);
    if (model.model) lines.push(`model = ${tomlString(model.model)}`);
    if (model.baseUrl) lines.push(`base_url = ${tomlString(model.baseUrl)}`);
    if (model.apiKey) lines.push(`api_key = ${tomlString(model.apiKey)}`);
    if (model.apiBackend) lines.push(`api_backend = ${tomlString(model.apiBackend)}`);
    if (model.authScheme && model.authScheme !== "bearer") lines.push(`auth_scheme = ${tomlString(model.authScheme)}`);
    if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) lines.push(`context_window = ${Math.floor(model.contextWindow)}`);
    // `stream_tool_calls` affects request *shape*, not just sampling. The OpenAI
    // Responses API frames tool-call streaming differently from Chat
    // Completions; leaving grok's tool-call streaming on against Responses makes
    // the stream wait for deltas that never arrive in the expected shape, so a
    // step hangs until the idle timeout — the "randomly stuck on diverse steps"
    // symptom. When a provider opts out (openai → false), we emit it explicitly.
    if (model.streamToolCalls === false) lines.push("stream_tool_calls = false");
    else if (model.streamToolCalls === true) lines.push("stream_tool_calls = true");
    // Bound a stalled inference so it aborts + retries instead of hanging the
    // whole run on one wedged request.
    if (Number.isFinite(model.inferenceIdleTimeoutSec) && model.inferenceIdleTimeoutSec > 0) {
      lines.push(`inference_idle_timeout_secs = ${Math.floor(model.inferenceIdleTimeoutSec)}`);
    }
    if (Number.isFinite(model.maxRetries) && model.maxRetries >= 0) {
      lines.push(`max_retries = ${Math.floor(model.maxRetries)}`);
    }
    const headers = tomlInlineTable(model.headers);
    if (headers) lines.push(`extra_headers = ${headers}`);
    lines.push("");
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server || !server.command) continue;
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    const args = Array.isArray(server.args) ? server.args : [];
    lines.push(`args = [${args.map(tomlString).join(", ")}]`);
    const env = tomlInlineTable(server.env);
    if (env) lines.push(`env = ${env}`);
    if (Number.isFinite(server.startupTimeoutSec)) lines.push(`startup_timeout_sec = ${Math.floor(server.startupTimeoutSec)}`);
    if (Number.isFinite(server.toolTimeoutSec)) lines.push(`tool_timeout_sec = ${Math.floor(server.toolTimeoutSec)}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Materialise a run's `GROK_HOME`: the directory plus its `config.toml`.
 *
 * Returns the directory to export as `GROK_HOME` for the child. When the run
 * drops privileges, the directory is chowned to that user — the CLI writes its
 * session state here, and a config dir it cannot write aborts the run before any
 * output is produced.
 */
export function writeGrokHome(dir, config, { uid, gid } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), renderConfigToml(config), { mode: 0o600 });
  // Sessions/history/logs the CLI writes go here too.
  for (const sub of ["sessions", "logs"]) {
    try {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    } catch {
      /* best effort — the CLI creates what it needs */
    }
  }
  if (Number.isFinite(uid) && Number.isFinite(gid)) {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      try {
        fs.chownSync(current, uid, gid);
        if (fs.lstatSync(current).isDirectory()) {
          for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
        }
      } catch {
        /* best effort */
      }
    }
  }
  return dir;
}
