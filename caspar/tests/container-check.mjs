#!/usr/bin/env node
/**
 * Container check: run the built creature image the way a Caspar node runs it.
 *
 * `checks.mjs` exercises the bridge in-process. This one exercises the *image*:
 * it starts a fake gateway on the docker bridge address, runs the creature
 * container with only `CASPAR_GATEWAY_*` (exactly what the node injects), pushes a
 * proxy-relayed prompt at it, and asserts the trajectory and the terminal result
 * come back over the socket. That covers everything an in-process check cannot —
 * the entrypoint, the unprivileged user, the workspace under /data, and the
 * container reaching the gateway at all.
 *
 * The agent inside the container is replaced with the fake CLI (mounted in), so the
 * check needs no API credentials and is deterministic. The real CLI is covered by
 * `live-cli.mjs`.
 *
 * Requires docker and a built image:
 *   docker build -t grok-caspar-creature:test -f caspar/Dockerfile.prebuilt <context>
 *   node caspar/tests/container-check.mjs [--image <tag>]
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeGateway } from "./fakeGateway.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const imageArg = process.argv.indexOf("--image");
const IMAGE = imageArg >= 0 ? process.argv[imageArg + 1] : process.env.GROK_CREATURE_IMAGE || "grok-caspar-creature:test";

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf-8", ...opts });
}

// The address the container reaches the host on (the node uses the `kasper`
// bridge gateway the same way).
function bridgeGateway() {
  try {
    const out = docker(["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}"]).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  return "172.17.0.1";
}

const scenario = {
  messages: [
    { type: "system", subtype: "init", session_id: "sess-c", model: "fake-model", cwd: "/data", tools: ["run_terminal_cmd"], mcp_servers: [] },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "container check thinking" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "run_terminal_cmd", input: { command: "echo in-container" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "in-container" }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "the creature answered from inside the container",
      duration_ms: 42,
      duration_api_ms: 40,
      num_turns: 2,
      total_cost_usd: 0,
      usage: { input_tokens: 11, output_tokens: 7 },
      modelUsage: { "fake-model": {} },
      permission_denials: [],
      session_id: "sess-c",
    },
  ],
};

const mount = fs.mkdtempSync(path.join(os.tmpdir(), "caspar-container-"));
fs.copyFileSync(path.join(HERE, "fakeGrok.mjs"), path.join(mount, "fakeGrok.mjs"));
fs.writeFileSync(path.join(mount, "scenario.json"), JSON.stringify(scenario));
// The container runs as an unprivileged user; the mount has to be readable by it.
fs.chmodSync(mount, 0o755);
for (const f of ["fakeGrok.mjs", "scenario.json"]) fs.chmodSync(path.join(mount, f), 0o755);

const gateway = await new FakeGateway({ identity: { machineId: "77@global", programId: "77@global", vmId: "vm-container" } }).listen({ host: "0.0.0.0" });
const host = bridgeGateway();
let container = "";
let failed = false;

try {
  container = docker([
    "run", "-d", "--rm",
    "-e", `CASPAR_GATEWAY_HOST=${host}`,
    "-e", `CASPAR_GATEWAY_PORT=${gateway.port}`,
    "-e", "GROK_BIN=/fake/fakeGrok.mjs",
    "-e", "GROK_FAKE_SCENARIO=/fake/scenario.json",
    "-e", "GROK_CREATURE_TASK_WAIT=60",
    "-v", `${mount}:/fake:ro`,
    IMAGE,
  ]).trim();
  console.log(`container ${container.slice(0, 12)} started; gateway on ${host}:${gateway.port}`);

  // Wait for the creature to connect and announce itself (the node reads the same
  // line out of the VM logs).
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await new Promise((r) => setTimeout(r, 1000));
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf-8" });
    if ((logs.stdout || "").includes("GROK_READY")) ready = true;
    else if (spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf-8" }).stdout?.trim() === "false") break;
  }
  const bootLogs = spawnSync("docker", ["logs", container], { encoding: "utf-8" }).stdout || "";
  assert.ok(ready, `the creature never reported GROK_READY:\n${bootLogs.slice(-1500)}`);
  console.log("✓ the container connected to the gateway and is serving prompts");

  // A prompt, exactly as the backend + proxy entity deliver one.
  const correlationId = "container-corr-1";
  gateway.pushSignal("creatures/signal", {
    user: { id: "8@global" },
    action: "single",
    entityId: "davinci",
    correlationId,
    data: JSON.stringify({
      prompt: "are you alive in there?",
      objective: "are you alive in there?",
      streamTo: "9@global",
      groupChat: true,
      self: { id: "res-a", name: "Aria", handle: "aria" },
      roster: [{ id: "u-1", name: "Shayan", handle: "shayan", kind: "user" }],
      sessionId: "space:space-c:res-a",
      spaceId: "space-c",
      config: { tools: [] },
      skill: "You are Aria, a container-check agent.",
      correlationId,
      replyTo: "8@global",
      proxyProgramId: "8@global",
      proxyEntityId: "agent",
    }),
  });

  const answered = Date.now() + 90_000;
  let final;
  while (Date.now() < answered && !final) {
    await new Promise((r) => setTimeout(r, 500));
    final = gateway.signals().find((s) => s.packet.kind === "davinci/result");
  }
  const logs = spawnSync("docker", ["logs", container], { encoding: "utf-8" }).stdout || "";
  assert.ok(final, `no davinci/result came back:\n${logs.slice(-2000)}`);

  const steps = gateway.signals().filter((s) => s.packet.kind === "davinci/step");
  assert.ok(steps.length >= 4, `expected a streamed trajectory, saw ${steps.length}`);
  assert.ok(steps.every((s) => s.userId === "9@global"), "steps go to the prompting user");
  assert.equal(final.userId, "8@global", "the result goes back through the proxy");
  assert.equal(final.packet.correlationId, correlationId);
  assert.equal(final.packet.result.success, true);
  assert.equal(final.packet.result.answer, "the creature answered from inside the container");
  assert.equal(final.packet.result.usage.promptTokens, 11);
  assert.match(logs, /GROK_BOOT .*"workspace":"\/data\/workspaces\/space-space-c-res-a"/);
  console.log("✓ the container served the prompt: streamed the trajectory and replied through the proxy");
  console.log(`  channels: ${steps.map((s) => s.packet.channel).join(" → ")}`);
  console.log(`  answer:   ${final.packet.result.answer}`);
} catch (err) {
  failed = true;
  console.error(`\nFAIL: ${err?.message || err}`);
} finally {
  if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  await gateway.close();
  fs.rmSync(mount, { recursive: true, force: true });
}

console.log(failed ? "\ncontainer check FAILED" : "\ncontainer check PASSED");
process.exit(failed ? 1 : 0);
