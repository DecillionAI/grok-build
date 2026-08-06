/**
 * Trajectory mapping: Grok's `streaming-messages-json` lines → Decillion steps.
 *
 * A run is a multi-step loop, and the product streams it live: every thought,
 * every tool call, every observation and the final answer are pushed to the
 * prompting user as they happen (see `runtime.mjs`). The client renders each step
 * from two fields only — a coarse `channel` and a one-line `message` — so this
 * module's job is to turn each SDK message into that shape:
 *
 *   channel ∈ { status, plan, thought, action, observation, final, trace }
 *
 * The event shape (`seq`, `event_id`, `ts_utc`, `kind`, `message`, `data`) is the
 * one the Decillion backend already buffers and the Expo client already renders,
 * so nothing downstream changes when this creature replaces the davinci agent.
 */

import crypto from "node:crypto";

import { creatureNumber } from "./env.mjs";

/** One-line summaries are for humans; keep signal payloads small. */
const MAX_MESSAGE_CHARS = creatureNumber("STEP_MESSAGE_CHARS", 600);
const MAX_DATA_CHARS = creatureNumber("STEP_DATA_CHARS", 2000);

/**
 * Tools whose use is really the agent planning, not acting. Grok's own ids first,
 * then the Claude-compatible spellings its tool-name compat layer also accepts —
 * the channel a step lands on must not depend on which profile served the run.
 */
const PLAN_TOOLS = new Set(["todo_write", "todowrite", "enter_plan_mode", "exit_plan_mode", "update_goal", "TodoWrite", "ExitPlanMode"]);

/** The tool a plan/todo list is written with, in either spelling. */
function isPlanWrite(name) {
  return name === "todo_write" || name === "todowrite" || name === "TodoWrite";
}

/**
 * The creature a tool call really targets. Space creatures are dispatched through
 * `use_tool`, whose `tool_name` names them; everything else is itself.
 */
function effectiveToolName(name, input) {
  if (name === "use_tool" && input && typeof input === "object" && typeof input.tool_name === "string" && input.tool_name.trim()) {
    return input.tool_name.trim();
  }
  return name;
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?<=(?:api[_-]?key|token|secret|password|authorization)["'\s:=]{1,6})[A-Za-z0-9_\-.]{16,}/gi,
];

/** Redact anything that looks like a credential before it leaves the container. */
export function maskSecrets(value) {
  if (typeof value === "string") {
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***");
    return out;
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v);
    return out;
  }
  return value;
}

function clip(text, limit = MAX_MESSAGE_CHARS) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function clipJson(value, limit = MAX_DATA_CHARS) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * A short, human-readable description of a tool call.
 *
 * `use_tool` is Grok's MCP dispatch meta-tool — every space creature is called
 * through it — so a step that says "use_tool(tool_name, tool_input)" would hide
 * which creature the agent actually employed. It is unwrapped to read as a call to
 * that creature, which is what the client renders in the trajectory.
 */
function describeToolUse(name, input) {
  const args = input && typeof input === "object" ? input : {};
  if (name === "use_tool" && typeof args.tool_name === "string") {
    return describeToolUse(args.tool_name, args.tool_input);
  }
  if (name === "search_tool") return `Looking up the space's tools${args.query ? `: ${clip(args.query, 120)}` : ""}`;
  if ((name === "run_terminal_cmd" || name === "run_terminal_command" || name === "bash" || name === "Bash") && args.command) {
    return `Shell: ${clip(args.command, 200)}`;
  }
  if (Array.isArray(args.todos) && (name === "todo_write" || name === "todowrite" || name === "TodoWrite")) {
    const active = args.todos.find((t) => t && t.status === "in_progress");
    return `Plan (${args.todos.length} steps)${active ? ` — now: ${clip(active.content || active.activeForm, 120)}` : ""}`;
  }
  for (const key of ["file_path", "path", "pattern", "query", "url", "prompt", "description", "command", "code"]) {
    if (typeof args[key] === "string" && args[key].trim()) return `${name}: ${clip(args[key], 200)}`;
  }
  const keys = Object.keys(args);
  return keys.length ? `${name}(${keys.slice(0, 4).join(", ")})` : name;
}

/** Flatten a tool result's content blocks into text. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          if (typeof block.text === "string") return block.text;
          if (block.type === "image") return "[image]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return clipJson(content) ?? "";
  return "";
}

export class TrajectoryMapper {
  constructor({ traceAll = false } = {}) {
    this.seq = 0;
    this.traceAll = traceAll;
    /** The plan the agent last wrote with TodoWrite, surfaced in the result. */
    this.todos = [];
    this.toolNamesById = new Map();
    this.toolCallCount = 0;
    /**
     * The agent's most recent assistant text. It is the fallback answer when the
     * terminal `result` line never reaches the bridge (e.g. an unterminated final
     * line, or stdout truncated at exit): the run still spoke, so `buildResult`
     * can recover its answer instead of reporting "produced no result".
     */
    this.lastAssistantText = "";
  }

  _event(kind, message, data, channel) {
    this.seq += 1;
    return {
      seq: this.seq,
      event_id: crypto.randomBytes(6).toString("hex"),
      ts_utc: new Date().toISOString(),
      kind,
      message: maskSecrets(clip(message)),
      data: data === undefined ? {} : maskSecrets(data),
      channel,
    };
  }

  /** Map one SDK message onto zero or more trajectory events. */
  map(message) {
    if (!message || typeof message !== "object") return [];
    switch (message.type) {
      case "system":
        return this._system(message);
      case "assistant":
        return this._assistant(message);
      case "user":
        return this._user(message);
      case "result":
        return this._result(message);
      case "rate_limit_event":
        return [this._event("status", "Rate limit status changed", { rate_limit_info: message.rate_limit_info }, "status")];
      // The raw Messages event framing (`--include-partial-messages`) and Grok's
      // own auxiliary lines: already covered by the assistant/user/result lines
      // above, so they are trace-only noise.
      case "stream_event":
      case "message_start":
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop":
      case "message_delta":
      case "message_stop":
        return this.traceAll ? [this._event(`grok/${message.type}`, message.type, {}, "trace")] : [];
      default:
        return this.traceAll ? [this._event(`grok/${message.type}`, String(message.type), clipJson(message), "trace")] : [];
    }
  }

  _system(message) {
    if (message.subtype !== "init") {
      return this.traceAll ? [this._event(`grok/system.${message.subtype}`, String(message.subtype), {}, "trace")] : [];
    }
    const mcp = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
    const summary =
      `Session started (model ${message.model || "default"}, ${Array.isArray(message.tools) ? message.tools.length : 0} built-in tools` +
      (mcp.length ? `, creatures: ${mcp.map((s) => `${s.name}:${s.status}`).join(", ")}` : "") +
      ")";
    return [
      this._event(
        "run_start",
        summary,
        {
          model: message.model,
          permissionMode: message.permissionMode,
          apiKeySource: message.apiKeySource,
          version: message.version || message.claude_code_version,
          cwd: message.cwd,
          mcp_servers: mcp,
          session_id: message.session_id,
        },
        "status",
      ),
    ];
  }

  _assistant(message) {
    const events = [];
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    if (message.is_api_error_message || message.error) {
      const text = blocks.find((b) => b?.type === "text")?.text || String(message.error || "api error");
      return [this._event("error", text, { error: message.error }, "observation")];
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && block.thinking) {
        events.push(this._event("reason", block.thinking, {}, "thought"));
      } else if (block.type === "text" && block.text?.trim()) {
        this.lastAssistantText = block.text.trim();
        events.push(this._event("reason", block.text, {}, "thought"));
      } else if (block.type === "tool_use") {
        this.toolCallCount += 1;
        const rawName = String(block.name || "tool");
        // What the step reports is the creature actually employed, not the MCP
        // meta-tool it was dispatched through.
        const name = effectiveToolName(rawName, block.input);
        if (block.id) this.toolNamesById.set(block.id, name);
        const args = rawName === "use_tool" ? block.input?.tool_input : block.input;
        if (isPlanWrite(name) && Array.isArray(args?.todos)) this.todos = args.todos;
        events.push(
          this._event(
            "decision",
            describeToolUse(rawName, block.input),
            { tool: name, input: clipJson(args) },
            PLAN_TOOLS.has(name) ? "plan" : "action",
          ),
        );
      } else if (block.type === "server_tool_use") {
        // Grok's backend web search rides inline in the assistant frame.
        this.toolCallCount += 1;
        const name = String(block.name || "server tool");
        if (block.id) this.toolNamesById.set(block.id, name);
        events.push(this._event("decision", describeToolUse(name, block.input), { tool: name, input: clipJson(block.input) }, "action"));
      } else if (block.type === "web_search_tool_result") {
        const hits = Array.isArray(block.content) ? block.content.filter((c) => c && c.type === "web_search_result") : [];
        events.push(
          this._event(
            "tool_result",
            `web_search → ${hits.length} result${hits.length === 1 ? "" : "s"}`,
            { tool: "web_search", results: hits.slice(0, 5).map((h) => ({ title: h.title, url: h.url })) },
            "observation",
          ),
        );
      }
    }
    return events;
  }

  _user(message) {
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    const events = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
      const tool = this.toolNamesById.get(block.tool_use_id) || "tool";
      const text = toolResultText(block.content);
      events.push(
        this._event(
          block.is_error ? "guardrail_block" : "tool_result",
          `${tool} → ${text ? clip(text, 300) : block.is_error ? "failed" : "ok"}`,
          { tool, is_error: Boolean(block.is_error), output: clipJson(text) },
          "observation",
        ),
      );
    }
    return events;
  }

  _result(message) {
    const ok = message.subtype === "success" && !message.is_error;
    return [
      this._event(
        ok ? "final_answer" : "error",
        ok ? clip(message.result || "") || "done" : `run failed: ${message.subtype}${message.errors?.length ? ` — ${clip(message.errors.join("; "), 200)}` : ""}`,
        {
          subtype: message.subtype,
          num_turns: message.num_turns,
          duration_ms: message.duration_ms,
          total_cost_usd: message.total_cost_usd,
        },
        "final",
      ),
    ];
  }
}
