#!/usr/bin/env node
/**
 * A stand-in for the Grok Build CLI, for the checks.
 *
 * It behaves like `grok --prompt-file … --output-format streaming-messages-json`:
 * it reads the prompt from the file the bridge wrote, then writes a scripted
 * sequence of Messages `stream-json` lines. The scenario file
 * (`GROK_FAKE_SCENARIO`) decides what it emits, so a check can drive a normal run,
 * an error result, a hang (to exercise the wall-clock kill) or a run that actually
 * calls the `caspar` MCP server.
 *
 * The invocation itself is recorded to `GROK_FAKE_RECORD` (argv, cwd, prompt, the
 * run's config.toml, selected env), which is how the checks assert that the
 * platform's per-prompt inputs — the skill, the model override, the MCP server —
 * reach the CLI.
 */

import fs from "node:fs";
import path from "node:path";

const scenarioPath = process.env.GROK_FAKE_SCENARIO || "";
const recordPath = process.env.GROK_FAKE_RECORD || "";
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, "utf-8")) : { messages: [] };

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const promptFile = arg("--prompt-file");
const prompt = promptFile && fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf-8") : "";
const grokHome = process.env.GROK_HOME || "";
const configPath = grokHome ? path.join(grokHome, "config.toml") : "";
const config = configPath && fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";

if (recordPath) {
  fs.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        prompt,
        rules: arg("--rules"),
        outputFormat: arg("--output-format"),
        model: arg("--model"),
        permissionMode: arg("--permission-mode"),
        disallowedTools: arg("--disallowed-tools"),
        tools: arg("--tools"),
        sessionId: arg("--session-id"),
        grokHome,
        config,
        uid: typeof process.getuid === "function" ? process.getuid() : null,
        env: {
          XAI_API_KEY: process.env.XAI_API_KEY,
          GROK_HOME: process.env.GROK_HOME,
          GROK_SESSION_ID: process.env.GROK_SESSION_ID,
        },
      },
      null,
      2,
    ),
  );
}

// A run that never finishes: the runtime's wall-clock ceiling must end it.
if (scenario.hang) {
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake-model", tools: [], mcp_servers: [] });
  // A timer (not a never-settling promise) keeps the event loop alive, so this
  // process really does hang until the runtime kills it.
  setInterval(() => {}, 1000);
  await new Promise((resolve) => setTimeout(resolve, 3_600_000));
}

// A CLI that prints a non-JSON line to stdout (a banner, a version/update notice,
// an early error) before/without any stream-json — the runner keeps it as
// `stdoutTail`, and a "no result" reply must surface it.
if (typeof scenario.stdoutNoise === "string" && scenario.stdoutNoise) {
  process.stdout.write(`${scenario.stdoutNoise}\n`);
}

const messages = scenario.messages || [];
for (let i = 0; i < messages.length; i++) {
  const message = messages[i];
  if (message.__sleepMs) {
    await new Promise((resolve) => setTimeout(resolve, message.__sleepMs));
    continue;
  }
  // `noFinalNewline` drops the trailing newline on the LAST message, mimicking a
  // CLI whose terminal `result` line is truncated at exit — the bridge must still
  // parse it (flush-on-close) instead of losing the run's answer.
  if (scenario.noFinalNewline && i === messages.length - 1) {
    process.stdout.write(JSON.stringify(message));
  } else {
    emit(message);
  }
}

process.exit(scenario.exitCode ?? 0);
