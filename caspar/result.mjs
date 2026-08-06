/**
 * The run result, in the shape the Decillion backend already understands.
 *
 * Nest reads three things off a creature's terminal reply and nothing else:
 *
 *   • `answer`   — the message the user sees (`obj.result ?? obj.answer ?? …`,
 *                  hence: never put a `result` key on this object);
 *   • `usage`    — `promptTokens` / `completionTokens`, which is what the prompt
 *                  is billed on (`billPrompt` → the `promptAgent` cost creature);
 *   • `durationMs` — the measured run time, also billed.
 *
 * `plan` is deliberately an **object**, not an array: an array is Nest's signal
 * that the agent produced an employment plan for the team broker to execute, and
 * a Grok todo list is not that. The remaining fields (`trace`, `budget`,
 * `engine`, …) are diagnostics that travel with the reply and show up in the VM
 * logs and the client's usage label.
 */

/** Total tokens the platform bills for: everything the model read, and wrote. */
export function normalizeUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const input = Number(u.input_tokens || 0);
  const cacheRead = Number(u.cache_read_input_tokens || 0);
  const cacheCreation = Number(u.cache_creation_input_tokens || 0);
  const output = Number(u.output_tokens || 0);
  const promptTokens = input + cacheRead + cacheCreation;
  return {
    promptTokens,
    completionTokens: output,
    totalTokens: promptTokens + output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    // snake_case aliases, for any consumer reading davinci's spelling
    prompt_tokens: promptTokens,
    completion_tokens: output,
  };
}

/** The model that actually served the run (from `modelUsage`, else the init message). */
export function resolveModel(grokResult, initMessage) {
  const usage = grokResult?.modelUsage;
  if (usage && typeof usage === "object") {
    const names = Object.keys(usage);
    if (names.length) return names[names.length - 1];
  }
  return initMessage?.model || undefined;
}

/**
 * Explain a "no result" run from whatever the CLI *did* leave behind.
 *
 * A clean exit with an empty stderr and no `type:"result"` line is otherwise a
 * dead end for the user: the answer to "why" is usually sitting in the CLI's
 * non-JSON stdout (a banner, an update/version notice, an early error printed
 * before the stream started) — which the runner keeps as `stdoutTail` — or, when
 * even that is empty, in *which* stream-json messages did arrive (init only? an
 * assistant turn with no terminal result?). Surfacing it turns an opaque failure
 * into one the operator can act on from the reply alone.
 */
export function noResultDiagnostic({ stderr = "", stdoutTail = "", messageTypes = [] } = {}) {
  const tail = (text) => String(text).trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ").slice(0, 400);
  if (stderr && stderr.trim()) return `: ${tail(stderr)}`;
  if (stdoutTail && stdoutTail.trim()) return `: the CLI wrote non-JSON to stdout: ${tail(stdoutTail)}`;
  if (messageTypes.length) return ` — the CLI emitted no final result; messages seen: ${messageTypes.slice(0, 12).join(", ")}`;
  return " — the CLI produced no output at all (it exited before running the turn; check the backbone credential/model and GROK_BOOT logs)";
}

/**
 * Build the terminal reply.
 *
 * @param objective     the prompt that was answered
 * @param grokResult  the CLI's `type: "result"` message (may be null)
 * @param mapper        the trajectory mapper (step count + the agent's todo plan)
 * @param extra         `{ durationMs, timedOut, exitCode, stderr, sessionId, initMessage, error, warnings }`
 */
export function buildResult(objective, grokResult, mapper, extra = {}) {
  const { durationMs = 0, timedOut = false, exitCode = null, stderr = "", stdoutTail = "", sessionId, initMessage, error } = extra;
  const messageTypes = Array.isArray(extra.messageTypes) ? extra.messageTypes : [];
  let warnings = Array.isArray(extra.warnings) ? extra.warnings : [];

  const usage = normalizeUsage(grokResult?.usage);

  // Recovery for a run that ended cleanly (exit 0, no timeout, no thrown error)
  // but whose terminal `result` line never reached us — an unterminated final
  // line, or stdout truncated as the CLI exited. If the agent had already
  // produced assistant text, that IS the answer; reporting "produced no result"
  // would throw away a real reply. Only a clean exit qualifies: a non-zero exit
  // or a timeout is a genuine failure and keeps its own diagnostic message.
  const recoveredAnswer = typeof mapper?.lastAssistantText === "string" ? mapper.lastAssistantText.trim() : "";
  const recovered = !grokResult && !timedOut && !error && exitCode === 0 && Boolean(recoveredAnswer);
  if (recovered) warnings = [...warnings, "the CLI exited without a terminal result line; recovered the answer from the last assistant message"];

  const succeeded = recovered || Boolean(grokResult && grokResult.subtype === "success" && !grokResult.is_error && !timedOut);
  const answer = !succeeded ? "" : grokResult ? String(grokResult.result ?? "") : recoveredAnswer;

  const failure =
    error ||
    (timedOut
      ? `the run exceeded its wall-clock budget after ${Math.round(durationMs / 1000)}s`
      : grokResult
        ? grokResult.subtype === "success"
          ? String(grokResult.result || "the agent reported an error")
          : `${grokResult.subtype}${Array.isArray(grokResult.errors) && grokResult.errors.length ? `: ${grokResult.errors.join("; ")}` : ""}`
        : `the agent produced no result (exit code ${exitCode})${noResultDiagnostic({ stderr, stdoutTail, messageTypes })}`);

  const todos = Array.isArray(mapper?.todos) ? mapper.todos : [];
  const plan = {
    steps: todos.map((t) => ({
      description: String(t?.content || t?.activeForm || ""),
      status: String(t?.status || "pending"),
    })),
    progress: {
      done: todos.filter((t) => t?.status === "completed").length,
      total: todos.length,
    },
  };

  const result = {
    objective,
    engine: "grok-build",
    success: succeeded,
    // The user-facing message. On failure it carries the reason, so a client that
    // only renders `answer` still tells the user what happened.
    answer: succeeded ? answer : `I could not complete this request: ${failure}`,
    plan,
    trace: {
      events: mapper?.seq ?? 0,
      tool_calls: mapper?.toolCallCount ?? 0,
      num_turns: Number(grokResult?.num_turns || 0),
    },
    budget: {
      steps_used: Number(grokResult?.num_turns || 0),
      tool_calls_used: mapper?.toolCallCount ?? 0,
      elapsed_seconds: Math.round(durationMs) / 1000,
      estimated_usd: Number(grokResult?.total_cost_usd || 0),
      timed_out: timedOut,
    },
    usage,
    durationMs: Number(grokResult?.duration_ms || durationMs) || durationMs,
    model: resolveModel(grokResult, initMessage),
    sessionId: sessionId || grokResult?.session_id || undefined,
  };
  if (!succeeded) result.error = failure;
  if (warnings.length) result.warnings = warnings;
  if (Array.isArray(grokResult?.permission_denials) && grokResult.permission_denials.length) {
    result.permission_denials = grokResult.permission_denials.map((d) => d?.tool_name).filter(Boolean);
  }
  return result;
}
