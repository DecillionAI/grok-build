#!/usr/bin/env node
/**
 * Caspar docker-creature entrypoint for Grok Build.
 *
 * Deployed as a Caspar `docker` creature and started with `/programs/runEntity`,
 * this process is a **persistent agent server**: it connects to the node's
 * docker-host bridge gateway, announces itself, and then answers every prompt
 * signal that arrives for as long as the VM lives. One program backs every agent
 * in the platform, so prompts are served **concurrently** (up to
 * `MAX_CONCURRENT_PROMPTS`) — each on its own grok child and its own streaming
 * correlation — so a long-running prompt never blocks the others behind it.
 *
 *   Decillion (Nest)  ──signal──▶  agent proxy entity  ──relay──▶  THIS creature
 *          ▲                                                          │
 *          └────── davinci/step … davinci/result ─────────────────────┘
 *
 * The wire contract is exactly the one the davinci agent creature speaks, so this
 * is a drop-in backbone for Decillion agents — no change to Caspar, none to the
 * backend, none to the app:
 *
 *   in   `creatures/signal` → `{prompt|objective, skill, history, self, roster,
 *        groupChat, sessionId, streamTo, correlationId, replyTo,
 *        config:{tools, llm, max_wall_seconds}}`
 *   out  `{kind:"davinci/step",   correlationId, seq, channel, event, stream:true,  final:false}` (per step)
 *   out  `{kind:"davinci/result", correlationId, result, stream:false, final:true}`  (terminal)
 *
 * Steps go to the prompting user's own creature (`streamTo`) when the backend
 * names one — the node fans that push out to all of the user's live sockets, so
 * the client receives the trajectory directly, and the proxy correlation carries
 * exactly one message (the terminal result). With no `streamTo`, steps ride the
 * proxy as non-terminal chunks (`stream: true`), which the node relays and whose
 * correlation it keeps open.
 *
 * Greppable stdout sentinels (captured as VM logs, `/machines/readVmLogs`):
 *   GROK_BOOT / GROK_BRIDGE / GROK_READY / GROK_IDLE
 *   DAVINCI_TRACE  {...}   one per trajectory event  (name kept: the deploy harness greps it)
 *   DAVINCI_RESULT {...}   the final run result      (name kept: same reason)
 */

import fs from "node:fs";
import path from "node:path";

import { bridgeFromEnv } from "./bridge.mjs";
import { materializeAttachments, mediaContentBlocks } from "./attachments.mjs";
import { extractAttachmentTexts } from "./extract.mjs";
import { buildToolDefinitions, mergeCatalogs } from "./catalog.mjs";
import { creatureEnv, creatureFlag, creatureNumber } from "./env.mjs";
import { disallowedBuiltinTools, hydratePlatformKeys, PLATFORM_KEY_PROVIDERS, runGrok, runTempDir } from "./grokRunner.mjs";
import { discoverSpaceCatalog } from "./discovery.mjs";
import { TrajectoryMapper } from "./events.mjs";
import { ProviderMediaGenerator, GENERATE_MEDIA_TOOL } from "./mediaGeneration.mjs";
import { OutboundMediaCollector, SHARE_MEDIA_TOOL } from "./outboundMedia.mjs";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.mjs";
import { buildResult } from "./result.mjs";
import { SandboxBridgeServer, detectSandboxTool } from "./sandboxBridge.mjs";
import { buildHistoryTurns, fetchSpaceHistoryRecords, historyEndpointFromTask } from "./spaceHistory.mjs";
import { decodeTaskSignal, sessionSlug, taskObjective, threadSessionId } from "./taskSignal.mjs";
import { ToolInvoker } from "./toolInvoker.mjs";
import { ToolSocketServer } from "./toolSocket.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VERSION = "1.0.0";
/** The MCP server name the space's creatures are exposed under. */
const MCP_SERVER_NAME = "caspar";

function log(sentinel, payload) {
  process.stdout.write(`${sentinel} ${JSON.stringify(payload)}\n`);
}

/**
 * Where a session's files live. Preferably under the VM's persistent `/data`
 * mount, so a thread's workspace survives a container restart the way a project
 * machine should.
 */
function workspaceRoot() {
  const configured = String(creatureEnv("WORKSPACE_ROOT") || "").trim();
  const candidates = [configured, "/data/workspaces", "/app/workspaces"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  const fallback = path.join(process.cwd(), "workspaces");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** The prompt's tool catalog, from `config.tools` (the space's creatures). */
function catalogFromTask(task) {
  const config = task?.config && typeof task.config === "object" ? task.config : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  return { config, tools };
}

/**
 * Answer one prompt.
 *
 * Returns the result object that is signalled back. Never throws: a failed run is
 * still a reply, and a creature that dies on a bad prompt stops serving the
 * space.
 */
async function handleTask(bridge, { task, replyTo, correlationId, streamTo }) {
  const started = Date.now();
  const objective = taskObjective(task);
  const sessionId = threadSessionId(task, bridge ? `grok-${bridge.sessionId ?? "vm"}` : "grok-offline");
  // Ensure the admin-configured platform LLM keys are loaded from the on-chain
  // secret store into env before we build the run's key config. Cheap after the
  // first success (providers already in env are skipped), and robust to deploy
  // ordering — a key stored/granted after this creature booted is picked up on the
  // first task that needs it, not only after a re-boot.
  if (bridge) {
    try {
      await hydratePlatformKeys(bridge);
    } catch (err) {
      log("GROK_BOOT", { hydrate_keys_error: String(err?.message || err) });
    }
  }
  const { config, tools } = catalogFromTask(task);

  // The space's employable creatures. The backend sends `config.tools`, and —
  // so the agent sees the space's live roster even when that catalog is thin —
  // we also fetch the space's members straight from the node and merge in any it
  // did not send (best-effort; `config.tools` stays authoritative, see
  // discovery.mjs / mergeCatalogs). Bounded so a slow node never stalls a prompt.
  let catalog = tools;
  if (bridge && creatureFlag("DISCOVER_TOOLS", true)) {
    try {
      const discovered = await discoverSpaceCatalog(bridge, task, { log: (info) => log("GROK_DISCOVERY", info) });
      if (discovered.length) catalog = mergeCatalogs(tools, discovered);
    } catch (err) {
      log("GROK_DISCOVERY", { error: String(err?.message || err) });
    }
  }

  const workspace = path.join(workspaceRoot(), sessionSlug(sessionId));
  fs.mkdirSync(workspace, { recursive: true });

  const attachments = await materializeAttachments(task, workspace);
  if (attachments.length) log("GROK_ATTACHMENTS", { count: attachments.length, items: attachments });
  // Image/audio attachments are additionally handed to the model inline as ACP
  // content blocks so it can actually see/hear them — not just read a path. The
  // bytes are the same ones just materialised above (the agent can still open the
  // file too). Non-media stays file-only.
  const mediaBlocks = mediaContentBlocks(attachments, { log: (info) => log("GROK_MEDIA", info) });
  if (mediaBlocks.length) log("GROK_MEDIA", { inlined: mediaBlocks.length });
  // Non-image attachments (PDFs, documents, audio) can't reach the model as
  // media, so extract/transcribe them to text and inline it.
  const extractedTexts = await extractAttachmentTexts(attachments, {
    llm: config.llm,
    log: (info) => log("GROK_EXTRACT", info),
  });
  if (extractedTexts.length) log("GROK_EXTRACT", { extracted: extractedTexts.map((d) => ({ name: d.name, kind: d.kind, chars: d.text.length })) });

  const mapper = new TrajectoryMapper({ traceAll: creatureFlag("TRACE_ALL", false) });
  // Steps ride the channel the backend named; the terminal result always goes
  // back through `replyTo` (the proxy), which is what closes the correlation.
  const stepTarget = streamTo || replyTo;
  const streamSteps = Boolean(bridge && stepTarget && creatureFlag("STREAM_STEPS", true));

  const emit = (event) => {
    process.stdout.write(`DAVINCI_TRACE ${JSON.stringify(event)}\n`);
    if (!streamSteps) return;
    // Best-effort: a step that cannot be delivered must never break the run —
    // the authoritative result is still signalled at the end.
    bridge
      .signalUser("creatures/signal", String(stepTarget), {
        kind: "davinci/step",
        stream: true,
        final: false,
        correlationId,
        seq: event.seq,
        channel: event.channel,
        event,
      })
      .catch(() => {});
  };

  // The space's creatures plus two platform-owned media tools, exposed through
  // one MCP server. `generate_media` is provider-neutral (OpenAI, Gemini,
  // OpenRouter, xAI/custom-compatible routes); `share_media` attaches an
  // existing internet URL or a file from the shared sandbox.
  const initialCatalog = buildToolDefinitions(catalog);
  const byName = initialCatalog.byName;
  const platformToolDefs = [GENERATE_MEDIA_TOOL, SHARE_MEDIA_TOOL];
  const reservedToolNames = new Set(platformToolDefs.map((tool) => tool.name));
  const installCatalog = (rebuilt) => {
    // `initialCatalog.byName` is the same Map object as `byName`; snapshot it
    // before clearing so the first install does not erase external creatures.
    const entries = [...rebuilt.byName];
    byName.clear();
    for (const [name, entry] of entries) {
      if (!reservedToolNames.has(name)) byName.set(name, entry);
    }
    for (const tool of platformToolDefs) {
      byName.set(tool.name, { name: tool.name, kind: "tool", category: "media" });
    }
    return [...rebuilt.tools.filter((tool) => !reservedToolNames.has(tool.name)), ...platformToolDefs];
  };

  // Live re-discovery is stale-while-revalidate: `tools/list` responds from the
  // last catalog immediately and refreshes the space's external creatures in
  // the background. Platform media tools are re-added after every refresh.
  const DISCOVERY_CACHE_MS = creatureNumber("DISCOVERY_CACHE_MS", 15000);
  const DISCOVERY_REFRESH_TIMEOUT_MS = creatureNumber("DISCOVERY_REFRESH_TIMEOUT_MS", 4000);
  let lastToolDefs = installCatalog(initialCatalog);
  let lastDiscoveryAt = Date.now();
  let refreshInFlight = null;
  const startBackgroundRefresh = () => {
    if (!bridge || refreshInFlight) return;
    if (Date.now() - lastDiscoveryAt < DISCOVERY_CACHE_MS) return;
    refreshInFlight = (async () => {
      try {
        const discovered = await discoverSpaceCatalog(bridge, task, {
          log: () => {},
          programIndexOnly: true,
          timeoutMs: DISCOVERY_REFRESH_TIMEOUT_MS,
        });
        const liveCatalog = discovered.length ? mergeCatalogs(tools, discovered) : tools;
        lastToolDefs = installCatalog(buildToolDefinitions(liveCatalog));
        lastDiscoveryAt = Date.now();
      } catch {
        lastDiscoveryAt = Date.now();
      } finally {
        refreshInFlight = null;
      }
    })();
  };
  const refreshCatalog = () => {
    startBackgroundRefresh();
    return lastToolDefs;
  };

  let invoker = bridge ? new ToolInvoker(bridge, byName, bridge.machineId || bridge.programId || "") : null;
  let socketServer = null;
  let sandboxBridge = null;
  let mcpServers;
  const tempDir = runTempDir();
  const extraEnv = {};
  const sandboxToolName = bridge && creatureFlag("USE_SANDBOX_BACKEND", true)
    ? detectSandboxTool(initialCatalog.tools, byName)
    : null;
  const mediaCollector = new OutboundMediaCollector({
    localRoots: [workspace],
    sandboxReader: async (sandboxPath) => {
      if (!invoker || !sandboxToolName) throw new Error("this space has no shared sandbox to export that path from");
      const reply = await invoker.invoke(sandboxToolName, { function: "read", path: sandboxPath });
      if (!reply || reply.ok === false) throw new Error(reply?.error || "sandbox file export failed");
      return reply.response;
    },
    log: (info) => log("GROK_MEDIA", info),
  });
  const mediaGenerator = new ProviderMediaGenerator({ llm: config.llm, collector: mediaCollector });

  // The platform media tools exist even in a space with no attached creature,
  // so the local MCP socket is always useful. External calls still require the
  // Caspar bridge and return a clear error when it is unavailable.
  const socketPath = path.join(tempDir, "tools.sock");
  socketServer = new ToolSocketServer(socketPath, {
    list: () => refreshCatalog(),
    call: (name, args) => {
      if (name === GENERATE_MEDIA_TOOL.name) return mediaGenerator.generate(args);
      if (name === SHARE_MEDIA_TOOL.name) return mediaCollector.share(args);
      if (!invoker) return { ok: false, error: `tool ${name} needs a live Caspar bridge` };
      return invoker.invoke(name, args);
    },
  });
  try {
    await socketServer.start();
    mcpServers = {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [path.join(HERE, "mcpStdioServer.mjs")],
        env: { CASPAR_TOOL_SOCKET: socketPath },
        startupTimeoutSec: creatureNumber("MCP_STARTUP_TIMEOUT", 60),
        toolTimeoutSec: Math.max(
          creatureNumber("TOOL_TIMEOUT", 240) + 60,
          creatureNumber("MEDIA_VIDEO_WAIT_SECONDS", 240) + 60,
        ),
      },
    };
  } catch (err) {
    log("GROK_BOOT", { tool_bridge_error: String(err?.message || err) });
    socketServer = null;
  }

  // If the space has a sandbox creature attached, also swap Grok's built-in
  // filesystem and shell over to that shared machine.
  if (invoker && sandboxToolName) {
    const sandboxSocketPath = path.join(tempDir, "sandbox.sock");
    sandboxBridge = new SandboxBridgeServer(sandboxSocketPath, invoker, sandboxToolName);
    try {
      await sandboxBridge.start();
      extraEnv.GROK_SANDBOX_SOCKET = sandboxSocketPath;
    } catch (err) {
      log("GROK_BOOT", { sandbox_bridge_error: String(err?.message || err) });
      sandboxBridge = null;
    }
  }

  // Tell the model, in its system prompt, about the space's callable tools and
  // sub-agents (by their exact MCP tool names) so it plans with them. Built from
  // the same defs it can actually invoke, so what it reads matches what it calls.
  // Grok reaches MCP tools through its `use_tool` meta-tool, addressing them as
  // `<server>__<tool>` — so that qualified name is what the prompt must name.
  const qualify = (name) => `${MCP_SERVER_NAME}__${name}`;
  // The catalog carries the arg schema, the enum of operations for
  // multi-function tools, and the platform-pinned defaults. Passing them
  // through to the prompt (instead of just name + description) lets the model
  // see how to *call* each tool — not merely that it exists — which is what
  // stops it from inventing compound tool names like
  // `caspar__vercel_sandbox_exec` and then telling the user it "doesn't have
  // access to that action". See prompt.capabilitiesPreamble.
  const capabilities = lastToolDefs.map((t) => {
    const entry = byName.get(t.name) || {};
    return {
      name: qualify(t.name),
      description: t.description,
      kind: entry.kind || "tool",
      inputSchema: t.inputSchema,
      defaults: entry.defaults && typeof entry.defaults === "object" ? Object.keys(entry.defaults) : [],
      defaultFunction: entry.function || undefined,
    };
  });
  // The space's shared machine (the cloud sandbox): the agent must treat its
  // filesystem/shell as the collaborative workspace, not its private local dir.
  // Recognised by the descriptor the platform publishes (category "execution")
  // or a sandbox-shaped name — no hardcoded program id.
  const sharedEnvDef = lastToolDefs.find((t) => {
    const entry = byName.get(t.name) || {};
    const category = String(entry.category || "").toLowerCase();
    const name = String(entry.name || t.name).toLowerCase();
    return category === "execution" || /sandbox/.test(name);
  });
  const sharedEnv = sharedEnvDef ? { name: qualify(sharedEnvDef.name), description: sharedEnvDef.description } : undefined;
  // Force shell + filesystem work onto the shared sandbox. Two paths:
  //  • Sandbox backend active (`sandboxBridge` up): the CLI's built-ins
  //    `bash`, `read_file`, `edit`, `list_dir`, `glob`, `grep`, `task`,
  //    `get_task_output`, `kill_task` all route through
  //    `SandboxTerminalBackend` + `SandboxFileSystem` to the space's shared
  //    VM. Nothing to disable — the built-ins ARE the sandbox now.
  //  • No sandbox: keep the legacy deny list so the agent can't do throwaway
  //    work inside its private container.
  const sandboxActive = Boolean(sandboxBridge);
  const disallowedTools = disallowedBuiltinTools({ sandboxActive });

  // Fetch the space's group-chat transcript ourselves, creature→creature, by
  // signalling the decillion `spaces/history` creature. The client sends only
  // that creature's address (`task.historyEndpoint`), never the transcript, so
  // the agent always reasons over the authoritative on-chain thread — and sees
  // the whole group chat (every human message + every agent's final answer), not
  // just what was aimed at it. Best-effort and bounded: a miss leaves the run
  // with whatever history the task already carried (usually none). Skipped when
  // the client already inlined `history` (back-compat) or there is no space.
  if (bridge && !Array.isArray(task.history)) {
    const endpoint = historyEndpointFromTask(task);
    const spaceId = task.spaceId || task.storeId || task.space_id;
    if (endpoint && spaceId) {
      try {
        const records = await fetchSpaceHistoryRecords(bridge, {
          endpoint,
          spaceId,
          selfId: bridge.machineId || bridge.programId || "",
        });
        task.history = buildHistoryTurns(records, task.self, { excludeText: objective });
        log("GROK_HISTORY", { spaceId, fetched: records.length, turns: task.history.length });
      } catch (err) {
        log("GROK_HISTORY", { error: String(err?.message || err) });
      }
    }
  }

  const systemPrompt = buildSystemPrompt(task, { capabilities, sharedEnv, disabledBuiltins: disallowedTools });
  const prompt = buildUserPrompt(task, { objective, attachments, extractedTexts, workspace });
  // With inline media, the turn becomes ACP content blocks: the composed text
  // first, then each image/audio block. Without any, `promptBlocks` stays null and
  // the run uses the plain-text prompt exactly as before.
  const promptBlocks = mediaBlocks.length ? [{ type: "text", text: prompt }, ...mediaBlocks] : null;
  const maxWallSeconds = Number(config.max_wall_seconds) || creatureNumber("MAX_WALL_SECONDS", 900);

  log("GROK_BOOT", {
    session: sessionId,
    workspace,
    objective_chars: objective.length,
    history_turns: Array.isArray(task.history) ? task.history.length : 0,
    tools: lastToolDefs.map((t) => t.name),
    shared_env: sharedEnv?.name,
    sandbox_backend: sandboxActive || undefined,
    disallowed_builtins: disallowedTools.length ? disallowedTools : undefined,
    skill: Boolean(task.skill),
    group_chat: Boolean(task.groupChat || task.group_chat),
    roster: Array.isArray(task.roster) ? task.roster.length : 0,
    llm: config.llm ? { provider: config.llm.provider, models: config.llm.models } : undefined,
    stream_to: stepTarget || undefined,
    correlationId: correlationId || undefined,
    max_wall_seconds: maxWallSeconds,
  });

  let run;
  try {
    run = await runGrok({
      prompt,
      promptBlocks,
      systemPrompt,
      cwd: workspace,
      // Written into the run's config.toml — Grok has no `--mcp-config` flag.
      mcpServers,
      llm: config.llm,
      model: config.model || creatureEnv("MODEL"),
      threadSlug: sessionSlug(sessionId),
      // The space's creatures are pre-approved: they were attached to this space by
      // the platform, and there is no human here to approve a prompt — that is what
      // `bypassPermissions` (the creature's permission mode) is for. No `--tools`
      // allowlist is passed: Grok keeps its MCP meta-tools (`search_tool` /
      // `use_tool`) on regardless, and an allowlist would strip the planning and web
      // built-ins the agent still needs.
      // With the sandbox backend up this is `[]`; the CLI's built-ins are the
      // sandbox now. Without it, the legacy deny list keeps shell/FS work off
      // the private container. Either way `runGrok` gets a definitive list.
      disallowedTools,
      // Point the grok child at the sandbox bridge socket (only present when
      // the space has a sandbox creature attached). `runGrok` merges this
      // into the child env; grok's `SandboxTerminalBackend::from_env` picks
      // it up on session spawn.
      extraEnv,
      maxWallSeconds,
      tempDir,
      onMessage: (message) => {
        for (const event of mapper.map(message)) emit(event);
      },
    });
  } catch (err) {
    run = { result: null, messages: [], exitCode: null, timedOut: false, stderr: String(err?.message || err), warnings: [] };
  } finally {
    if (sandboxBridge) await sandboxBridge.stop();
    if (socketServer) await socketServer.stop();
    if (invoker) invoker.dispose();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const initMessage = run.messages.find((m) => m?.type === "system" && m.subtype === "init");
  const messageTypes = run.messages.map((m) => (m?.subtype ? `${m.type}/${m.subtype}` : m?.type)).filter(Boolean);
  // Which backbone actually served this run, and whether it authenticated with the
  // agent's own key or the image's. Never the credential itself.
  if (run.backbone) log("GROK_BACKBONE", { ...run.backbone, model: initMessage?.model, apiKeySource: initMessage?.apiKeySource });
  // A clean exit that produced no terminal result is the hardest failure to see
  // from the reply alone — log everything the CLI left behind so the cause (a
  // credential/model reject that printed to stdout, an early exit before the
  // turn) is greppable in the VM logs, not just inferable.
  if (!run.result && !run.timedOut) {
    log("GROK_NORESULT", { exitCode: run.exitCode, messageTypes, stdoutTail: (run.stdoutTail || "").slice(-800), backbone: run.backbone });
  }
  mediaCollector.allowLocalRoot(run.grokHome);
  try {
    await mediaCollector.collectGenerated(run.messages);
  } catch (err) {
    log("GROK_MEDIA", { collect_error: String(err?.message || err) });
  }
  const outboundAttachments = mediaCollector.attachments();
  if (outboundAttachments.length) {
    log("GROK_MEDIA", {
      outbound: outboundAttachments.map(({ name, mimeType, kind, size, source }) => ({ name, mimeType, kind, size, source })),
    });
  }
  const result = buildResult(objective, run.result, mapper, {
    durationMs: Date.now() - started,
    timedOut: run.timedOut,
    exitCode: run.exitCode,
    stderr: run.stderr,
    stdoutTail: run.stdoutTail,
    messageTypes,
    sessionId: initMessage?.session_id,
    initMessage,
    warnings: run.warnings,
    attachments: outboundAttachments,
  });
  if (run.stderr?.trim()) log("GROK_STDERR", { tail: run.stderr.trim().split("\n").slice(-6) });
  process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

/**
 * Answer one delivery and signal the terminal result back through `replyTo` (the
 * proxy entity), which is what closes the correlation the requester is waiting
 * on. A run that throws still produces a reply — silence would leave the user's
 * client spinning until the backend's timeout.
 */
export async function serveOnce(bridge, delivery) {
  let result;
  try {
    result = await handleTask(bridge, delivery);
  } catch (err) {
    log("GROK_BOOT", { run_error: String(err?.stack || err).slice(0, 400) });
    result = {
      objective: taskObjective(delivery.task || {}),
      engine: "grok-build",
      success: false,
      answer: "I could not complete this request.",
      error: String(err?.message || err).slice(0, 400),
    };
    process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  }
  if (bridge && delivery.replyTo) {
    try {
      await bridge.signalUser("creatures/signal", String(delivery.replyTo), {
        kind: "davinci/result",
        correlationId: delivery.correlationId,
        // Terminal message: closes the proxy correlation the streamed steps
        // (when routed through the proxy) kept open.
        final: true,
        stream: false,
        result,
      });
    } catch (err) {
      log("GROK_BOOT", { reply_error: String(err?.message || err).slice(0, 200) });
    }
  }
  return result;
}

/**
 * The queue of prompts waiting to be served.
 *
 * One creature program serves EVERY agent in the platform, so two prompts can
 * arrive close together (two agents in one space, or two users). A listener that is
 * only registered while idle would drop the second one — and a dropped prompt is a
 * client that spins until the backend's timeout. So prompts are captured the moment
 * they arrive and buffered here; the serve loop then drains them concurrently (see
 * `MAX_CONCURRENT_PROMPTS` in `main`), so a slow prompt never holds up the queue.
 */
export function createDeliveryQueue(bridge, idleWaitMs, onQueued) {
  const queue = [];
  let notify = null;
  const unsubscribe = bridge.onSignal((key, data) => {
    const delivery = decodeTaskSignal(key, data);
    if (!delivery) return;
    queue.push(delivery);
    if (onQueued) onQueued(queue.length, delivery);
    if (notify) notify();
  });
  // Wake a pending `next()` the instant the gateway link drops, so the serve
  // loop reconnects promptly instead of blocking for the whole idle window.
  const unsubClose = bridge.onClose ? bridge.onClose(() => notify && notify()) : () => {};

  return {
    get depth() {
      return queue.length;
    },
    /**
     * The next prompt, or `null` when there is nothing to serve — either the
     * idle window elapsed or the gateway link dropped. The caller distinguishes
     * the two with `bridge.isConnected()`.
     */
    next() {
      return new Promise((resolve) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => {
          notify = null;
          resolve(queue.length ? queue.shift() : null);
        }, idleWaitMs);
        notify = () => {
          clearTimeout(timer);
          notify = null;
          resolve(queue.length ? queue.shift() : null);
        };
      });
    },
    dispose() {
      unsubscribe();
      unsubClose();
      queue.length = 0;
    },
  };
}

/**
 * Re-establish the gateway connection after it dropped, with capped exponential
 * backoff. Returns a fresh connected bridge, or `null` if the gateway stays
 * unreachable long enough that we should exit and let the node cold-spawn a
 * fresh container.
 */
async function reconnectBridge(timeoutMs) {
  const maxAttempts = creatureNumber("RECONNECT_ATTEMPTS", 10);
  let delayMs = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const bridge = await bridgeFromEnv({ timeoutMs });
      if (bridge) {
        log("GROK_RECONNECTED", { attempt });
        return bridge;
      }
    } catch (err) {
      log("GROK_RECONNECT", { attempt, of: maxAttempts, error: String(err?.message || err).slice(0, 160) });
    }
    delayMs = Math.min(delayMs * 2, 30000);
  }
  return null;
}

/** Offline self-test: read the task from the input dir instead of the gateway. */
function readOfflineTask() {
  const inputDir = creatureEnv("INPUT_DIR") || process.env.DAVINCI_INPUT_DIR || "/app/input";
  const envTask = String(creatureEnv("TASK") || process.env.DAVINCI_TASK || "").trim();
  if (envTask) return { objective: envTask, source: "env" };
  const taskFile = path.join(inputDir, "task.json");
  if (fs.existsSync(taskFile)) {
    try {
      const task = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      const configFile = path.join(inputDir, "config.json");
      if (!task.config && fs.existsSync(configFile)) task.config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      return task;
    } catch (err) {
      log("GROK_BOOT", { task_read_error: String(err?.message || err) });
    }
  }
  return { objective: "Introduce yourself and report what you can do.", source: "default" };
}

export async function main() {
  let bridge = null;
  try {
    bridge = await bridgeFromEnv({ timeoutMs: creatureNumber("CALL_TIMEOUT_MS", 60000) });
  } catch (err) {
    log("GROK_BOOT", { bridge_init_error: String(err?.message || err) });
  }

  if (!bridge) {
    // No gateway: this is a local run (self-test / development). Answer one task
    // from the input dir and exit with its status.
    log("GROK_BOOT", { version: VERSION, mode: "offline", node: process.version });
    const task = readOfflineTask();
    const result = await handleTask(null, { task, replyTo: "", correlationId: "", streamTo: "" });
    return result.success ? 0 : 2;
  }

  log("GROK_BRIDGE", {
    connected: true,
    version: VERSION,
    session: bridge.sessionId,
    vm_id: bridge.vmId || process.env.CASPAR_VM_ID || "",
    machine_id: bridge.machineId,
    program_id: bridge.programId,
    creature_id: bridge.creatureId,
  });

  // Warm the admin-configured platform LLM keys from the on-chain secret store
  // into env now (best-effort); each task also ensures this before building its
  // key config, so a key stored after boot is still picked up. See
  // hydratePlatformKeys / handleTask.
  try {
    await hydratePlatformKeys(bridge);
    const hydrated = PLATFORM_KEY_PROVIDERS.filter(
      (p) => String(process.env[`GROK_CREATURE_LLM_KEY_${p.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] || "").trim(),
    );
    log("GROK_SECRETS", { platform_keys: hydrated });
  } catch (err) {
    log("GROK_BOOT", { hydrate_keys_error: String(err?.message || err) });
  }

  const serveForever = creatureFlag("SERVE_FOREVER", true);
  const idleWaitMs = creatureNumber("TASK_WAIT", 600) * 1000;
  // How many prompts this one program serves at the same time. It backs EVERY
  // agent in the platform, so prompts from different users/threads must not queue
  // behind each other: each runs on its own grok child, streams on its own
  // `correlationId`/`streamTo`, and replies on its own `replyTo`, so a long run
  // never blocks the others. Capped so a burst cannot exhaust the VM (each run
  // spawns a grok CLI child + its tool sockets). Set `MAX_CONCURRENT_PROMPTS=1`
  // to restore the old strictly-serial behavior.
  const maxConcurrent = Math.max(1, creatureNumber("MAX_CONCURRENT_PROMPTS", 8));
  let served = 0;

  const onQueued = (depth, delivery) => {
    if (depth > 1) log("GROK_QUEUED", { depth, correlationId: delivery.correlationId });
  };
  const callTimeoutMs = creatureNumber("CALL_TIMEOUT_MS", 60000);
  let deliveries = createDeliveryQueue(bridge, idleWaitMs, onQueued);

  // Runs currently in flight. Each `serveOnce` removes its own promise when it
  // settles, so `inFlight.size` is the live concurrency and `Promise.race` frees
  // the loop the instant any slot opens. `serveOnce` never throws (it always
  // replies), but the guard keeps one broken run from taking down the server.
  const inFlight = new Set();
  const startDelivery = (activeBridge, delivery) => {
    const task = (async () => {
      try {
        await serveOnce(activeBridge, delivery);
      } catch (err) {
        log("GROK_BOOT", { serve_error: String(err?.message || err).slice(0, 200) });
      } finally {
        served += 1;
        inFlight.delete(task);
      }
    })();
    inFlight.add(task);
    return task;
  };

  // Single-shot mode (SERVE_FOREVER=false, e.g. a one-task self-test): serve
  // exactly one prompt and exit with its status. There is only ever one prompt,
  // so no concurrency is involved.
  if (!serveForever) {
    log("GROK_READY", { machine_id: bridge.machineId, program_id: bridge.programId, served, queued: deliveries.depth, ts: Date.now() / 1000 });
    const delivery = await deliveries.next();
    try {
      if (!delivery) {
        process.stdout.write(`DAVINCI_RESULT ${JSON.stringify({ success: false, error: "no task signal received within the wait window" })}\n`);
        return 2;
      }
      const result = await serveOnce(bridge, delivery);
      return result.success ? 0 : 2;
    } finally {
      deliveries.dispose();
      try {
        bridge.close();
      } catch {
        /* already closed */
      }
    }
  }

  try {
    for (;;) {
      // Backpressure: while every slot is busy, wait for one to free before
      // pulling the next prompt. In-flight runs keep progressing on the event
      // loop meanwhile — this only paces how fast new prompts are admitted.
      if (inFlight.size >= maxConcurrent) {
        await Promise.race(inFlight);
        continue;
      }

      log("GROK_READY", { machine_id: bridge.machineId, program_id: bridge.programId, served, queued: deliveries.depth, inflight: inFlight.size, ts: Date.now() / 1000 });
      const delivery = await deliveries.next();
      if (delivery) {
        // Start the run and immediately loop back for the next prompt instead of
        // awaiting it. The run streams and replies on its own correlation, so
        // parallel prompts each get their own stream and none blocks another.
        startDelivery(bridge, delivery);
        continue;
      }

      // No delivery within the idle window. A dropped gateway link looks like
      // idle here, but the creature would be alive-and-unreachable (the node
      // cannot fix a container it still sees as "running"), so reconnect instead
      // of waiting on forever. In-flight runs stay on the old bridge and drain
      // (their replies fail and are logged); fresh prompts serve on the new one.
      if (!bridge.isConnected()) {
        log("GROK_RECONNECT", { served, inflight: inFlight.size, reason: "gateway link lost" });
        deliveries.dispose();
        try {
          bridge.close();
        } catch {
          /* already gone */
        }
        const next = await reconnectBridge(callTimeoutMs);
        if (!next) {
          log("GROK_SERVE_UNAVAILABLE", { served, reason: "gateway link lost and could not be re-established — exiting so the node cold-spawns a fresh container" });
          return 2;
        }
        bridge = next;
        deliveries = createDeliveryQueue(bridge, idleWaitMs, onQueued);
        continue;
      }
      log("GROK_IDLE", { served, inflight: inFlight.size, waited_s: idleWaitMs / 1000 });
      // immortal: keep waiting for the next prompt
    }
  } finally {
    deliveries.dispose();
    try {
      bridge.close();
    } catch {
      /* already closed */
    }
  }
}

// `import.meta.main` is Bun/Node ≥20.11; the argv check keeps older runtimes working.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      log("GROK_BOOT", { fatal: String(err?.stack || err).slice(0, 600) });
      process.exit(1);
    });
}

export { handleTask };
