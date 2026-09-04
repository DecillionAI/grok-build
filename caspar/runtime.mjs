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
import { disallowedBuiltinTools, hydratePlatformKeys, PLATFORM_KEY_PROVIDERS, persistedConversationSession, resolveGrokHome, runGrok, runTempDir } from "./grokRunner.mjs";
import { discoverSpaceCatalog } from "./discovery.mjs";
import { httpMcpServersFromCatalog, mcpServerSummaries } from "./mcpAttach.mjs";
import { TrajectoryMapper } from "./events.mjs";
import { ProviderMediaGenerator, GENERATE_MEDIA_TOOL } from "./mediaGeneration.mjs";
import { OutboundMediaCollector, SHARE_MEDIA_TOOL } from "./outboundMedia.mjs";
import { uploadOutboundMedia } from "./mediaUpload.mjs";
import { SCHEDULE_ROUTINE_TOOL, scheduleRoutine } from "./scheduleRoutine.mjs";
import { readUniversalInstruction } from "./platformInstruction.mjs";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.mjs";
import { buildResult } from "./result.mjs";
import { SandboxBridgeServer, detectSandboxTool } from "./sandboxBridge.mjs";
import { prewarmToolContainers } from "./prewarm.mjs";
import {
  buildHistoryTurns,
  fetchSpaceConversation,
  fetchTeamActivitySince,
  postSpaceSignal,
  KIND,
} from "./spaceHistory.mjs";
import {
  authorizeBillingRun,
  authorizeDirectToolRun,
  chargeAgentCheckpoint,
  releaseBillingRun,
  settleBillingRun,
  settleDirectToolRun,
  splitSettledCharge,
} from "./finance.mjs";
import { runDirectTool } from "./directTool.mjs";
import { takeMachineMs } from "./machineSession.mjs";
import {
  ensureDelegatedAuthorization,
  isServerOrchestrated,
  planAndLaunchFollowups,
  recordServerRun,
  settleProjectSpend,
} from "./orchestrate.mjs";
import { AgentTaskBoard } from "./agentQueue.mjs";
import { SEND_MESSAGE_TOOL, sendAgentMessage } from "./sendMessage.mjs";
import { PLAN_TOOLS, PLAN_TOOL_NAMES, runPlanTool } from "./planTools.mjs";
import { readProjectPlan, renderPlanForPrompt } from "./projectPlan.mjs";
import { decodeTaskSignal, sessionSlug, taskObjective, threadSessionId } from "./taskSignal.mjs";
import { ToolInvoker } from "./toolInvoker.mjs";
import { ToolSocketServer } from "./toolSocket.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const VERSION = "1.0.0";
/** The MCP server name the space's creatures are exposed under. */
const MCP_SERVER_NAME = "caspar";
const BILLING_OBSERVED = Symbol("billingObserved");

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
async function handleTask(bridge, { task, replyTo, correlationId, streamTo }, billingSession = null) {
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
  // Where a step goes depends on whether the run has a space.
  //
  //   • In a space, a step IS a signal on that space: posted to the store, so
  //     the node records it in the signal log (that is the agent's work history,
  //     replayable after a reload) and fans it out live to every participant in
  //     the same delivery. One path, one record.
  //   • With no space (a spaceless prompt, e.g. the market advisor), there is no
  //     store to post to, so the step is pushed straight to the requester.
  //
  // The terminal result always goes back through `replyTo` (the proxy), which is
  // what closes the correlation the caller is waiting on.
  const stepTarget = streamTo || replyTo;
  const stepSpaceId = task.spaceId || task.storeId || task.space_id || "";
  // The thread this run belongs to. Every turn it produces — steps, tool calls,
  // the final answer — is tagged with it, so switching tabs mid-run can never
  // leak a turn into another thread.
  const runThreadId =
    (typeof task.threadId === "string" && task.threadId.trim()) ||
    (typeof task.thread_id === "string" && task.thread_id.trim()) ||
    "main";
  const streamSteps = Boolean(bridge && (stepSpaceId || stepTarget) && creatureFlag("STREAM_STEPS", true));

  // When the stream last carried anything to the client. A real step resets it;
  // the heartbeat below uses it to tell "actively working but quiet" (a long tool
  // call or model turn) from "the run went away", so the client's own idle
  // watchdog never kills a healthy-but-silent run.
  let lastStreamAt = Date.now();
  let stepPostFailed = false;
  const stepAgentProgramId = task.proxyProgramId || task.agentProgramId || task.self?.programId || "";
  const stepAgentName = task.self?.name || task.agentName || "";
  /**
   * Deliver one trajectory event. A tool call is labelled `kind=toolcall` and
   * everything else `kind=step`, so a reader can pull an agent's tool trail out
   * of the log without re-parsing channels.
   */
  const emit = (event) => {
    process.stdout.write(`DAVINCI_TRACE ${JSON.stringify(event)}\n`);
    if (!streamSteps) return;
    lastStreamAt = Date.now();
    // Best-effort: a step that cannot be delivered must never break the run —
    // the authoritative result is still signalled at the end.
    if (stepSpaceId) {
      postSpaceSignal(bridge, {
        spaceId: stepSpaceId,
        kind: event.channel === "action" ? KIND.TOOLCALL : KIND.STEP,
        threadId: runThreadId,
        agentProgramId: stepAgentProgramId,
        correlationId,
        data: {
          role: "agent",
          from: "agent",
          runId: correlationId,
          seq: event.seq,
          channel: event.channel,
          text: event.message || "",
          event,
          ...(stepAgentName ? { agentName: stepAgentName } : {}),
          ...(stepAgentProgramId ? { agentProgramId: stepAgentProgramId } : {}),
        },
      }).catch((err) => {
        // Reported ONCE per run: if the store is refusing this creature's
        // signals, every step of every run fails the same way, and a line per
        // step would bury the reason it is happening.
        if (!stepPostFailed) {
          stepPostFailed = true;
          log("GROK_STEP_LOST", {
            spaceId: stepSpaceId,
            correlationId,
            error: String(err?.message || err).slice(0, 300),
            note: "this run's work trail is not being recorded",
          });
        }
      });
      return;
    }
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

  // A lightweight keep-alive pushed on the same stream while a run is in flight.
  // Grok goes silent for the whole duration of a long tool call (a sandbox
  // `exec`/build can run minutes) or a long model turn, and a client that only
  // watched wall-clock time would give up mid-progress. The heartbeat carries no
  // trajectory content (empty `heartbeat` channel — the app renders nothing new
  // for it) but proves the run is alive, so the client resets its inactivity
  // timer instead of timing the run out. It never writes a DAVINCI_TRACE line, so
  // it does not spam the VM logs.
  const heartbeatMs = Math.max(0, creatureNumber("STREAM_HEARTBEAT_MS", 25000));
  const sendHeartbeat = () => {
    if (!streamSteps || Date.now() - lastStreamAt < heartbeatMs) return;
    lastStreamAt = Date.now();
    if (stepSpaceId) {
      // `temp`: delivered live so the client's idle watchdog sees the run is
      // alive, never recorded — a heartbeat is not work.
      postSpaceSignal(bridge, {
        spaceId: stepSpaceId,
        kind: KIND.STEP,
        threadId: runThreadId,
        agentProgramId: stepAgentProgramId,
        correlationId,
        temp: true,
        data: { channel: "heartbeat", runId: correlationId, ts: lastStreamAt },
      }).catch(() => {});
      return;
    }
    bridge
      .signalUser("creatures/signal", String(stepTarget), {
        kind: "davinci/step",
        stream: true,
        final: false,
        correlationId,
        channel: "heartbeat",
        event: { kind: "heartbeat", ts: lastStreamAt },
      })
      .catch(() => {});
  };

  // The space's creatures plus two platform-owned media tools, exposed through
  // one MCP server. `generate_media` is provider-neutral (OpenAI, Gemini,
  // OpenRouter, xAI/custom-compatible routes); `share_media` attaches an
  // existing internet URL or a file from the shared sandbox.
  const initialCatalog = buildToolDefinitions(catalog);
  const byName = initialCatalog.byName;
  const platformToolDefs = [
    GENERATE_MEDIA_TOOL,
    SHARE_MEDIA_TOOL,
    SCHEDULE_ROUTINE_TOOL,
    // Speaking mid-run needs a chat to speak into. A spaceless run (the market
    // advisor) has none, so the tool is not offered there rather than offered
    // and then refused.
    ...(task.spaceId || task.storeId || task.space_id ? [SEND_MESSAGE_TOOL] : []),
    // The shared plan. Like `send_message` these need a project to act on, so a
    // spaceless run (the market advisor) is not offered them.
    ...(task.spaceId || task.storeId || task.space_id ? PLAN_TOOLS : []),
  ];
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
      const category =
        tool.name === SCHEDULE_ROUTINE_TOOL.name
          ? "scheduler"
          : tool.name === SEND_MESSAGE_TOOL.name
            ? "chat"
            : PLAN_TOOL_NAMES.has(tool.name)
              ? "plan"
              : "media";
      byName.set(tool.name, { name: tool.name, kind: "tool", category });
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

  const authorizedToolIds = billingSession
    ? (Array.isArray(billingSession.quote?.priceSnapshot?.tools)
        ? billingSession.quote.priceSnapshot.tools.map((row) => String(row?.resourceId || "")).filter(Boolean)
        : [])
    : undefined;
  let invoker = bridge
    ? new ToolInvoker(bridge, byName, bridge.machineId || bridge.programId || "", { authorizedToolIds })
    : null;
  let toolUsage = [];
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
      if (name === SCHEDULE_ROUTINE_TOOL.name)
        return scheduleRoutine(bridge, task, streamTo, args, { log });
      if (name === SEND_MESSAGE_TOOL.name)
        return sendAgentMessage(bridge, { ...task, correlationId: correlationId || task.correlationId }, args, {
          log: (info) => log("GROK_SEND_MESSAGE", info),
        });
      if (PLAN_TOOL_NAMES.has(name))
        return runPlanTool(bridge, { ...task, correlationId: correlationId || task.correlationId }, name, args);
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
        // grok's per-call MCP ceiling MUST exceed the invoker's own waiter
        // (`toolInvoker.mjs` DEFAULT_TIMEOUT_SECONDS, same `TOOL_TIMEOUT` var,
        // default 420) plus margin — otherwise a slow cold spawn (routinely
        // >1 min, up to the invoker's budget) trips this outer timeout first and
        // the model is told the tool failed while it is still coming up. Keep the
        // default aligned at 420 so outer (>=480) always wins over inner (420).
        toolTimeoutSec: Math.max(
          creatureNumber("TOOL_TIMEOUT", 420) + 60,
          creatureNumber("MEDIA_VIDEO_WAIT_SECONDS", 240) + 60,
        ),
      },
    };
  } catch (err) {
    log("GROK_BOOT", { tool_bridge_error: String(err?.message || err) });
    socketServer = null;
  }
  // MCP servers the project attached (catalog entries of kind `mcp`). The CLI
  // speaks Streamable HTTP to them itself, so they are config entries, not
  // creatures to signal — and the prompt names them so the agent knows they are
  // part of what it can do here.
  mcpServers = { ...(mcpServers || {}), ...httpMcpServersFromCatalog(catalog) };
  const attachedMcpServers = mcpServerSummaries(catalog);
  if (attachedMcpServers.length) log("GROK_BOOT", { mcp_servers: attachedMcpServers.map((m) => m.name) });

  // If the space has a sandbox creature attached, also swap Grok's built-in
  // filesystem and shell over to that shared machine.
  if (invoker && sandboxToolName) {
    const sandboxSocketPath = path.join(tempDir, "sandbox.sock");
    sandboxBridge = new SandboxBridgeServer(sandboxSocketPath, invoker, sandboxToolName);
    try {
      await sandboxBridge.start();
      extraEnv.GROK_SANDBOX_SOCKET = sandboxSocketPath;
      // Grok joins model file paths and the default shell cwd onto its LOCAL
      // session workspace; those paths don't exist in the sandbox VM. Hand the
      // backends that local root so they rewrite paths under it to
      // sandbox-relative (served from the sandbox home). Canonicalize to match
      // the cwd grok itself resolves `--cwd` to.
      try {
        extraEnv.GROK_SANDBOX_LOCAL_ROOT = fs.realpathSync(workspace);
      } catch {
        extraEnv.GROK_SANDBOX_LOCAL_ROOT = workspace;
      }
    } catch (err) {
      log("GROK_BOOT", { sandbox_bridge_error: String(err?.message || err) });
      sandboxBridge = null;
    }
  }

  // Cold-spawn latency hiding: every tool/agent runs in its own container the
  // node spawns on first use (>1 min under gVisor; the sandbox also creates its
  // VM lazily), which is why a run visibly stalls the first time it reaches for
  // a tool. Kick those spawns off now, in the background, so they warm while the
  // model reads history and plans. Best-effort and non-blocking — never awaited,
  // never fatal. See prewarm.mjs.
  prewarmToolContainers(invoker, lastToolDefs, byName, {
    sandboxToolName,
    log: (info) => log("GROK_PREWARM", info),
  });

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
  // `caspar__sandbox_exec` and then telling the user it "doesn't have
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
  //  • Sandbox backend active (`sandboxBridge` up): `bash`, `read_file`,
  //    `write`, `edit`, `apply_patch` and the task family route through
  //    `SandboxTerminalBackend` + `SandboxFileSystem` to the space's shared VM
  //    — the built-ins ARE the sandbox now. The exception is `list_dir` /
  //    `glob` / `grep`: those read the CLI's own local container (WalkBuilder /
  //    a locally-spawned rg), never the backends, so they stay denied and the
  //    agent lists/searches via `bash` (which does route to the VM).
  //  • No sandbox: keep the legacy deny list so the agent can't do throwaway
  //    work inside its private container.
  const sandboxActive = Boolean(sandboxBridge);
  const disallowedTools = disallowedBuiltinTools({ sandboxActive });

  // Read the space's group-chat transcript ourselves, straight from the node's
  // signal log. A space chat is split into threads (tabs), each its own
  // conversation, so the read is scoped by the run's `thread=` tag and to the
  // conversational kinds — every human message and every agent's final answer,
  // not just what was aimed at this agent. The agent's own work steps and tool
  // calls are in the same log under other tags; they are not conversation and
  // never enter a prompt.
  if (bridge && !Array.isArray(task.history)) {
    const spaceId = task.spaceId || task.storeId || task.space_id;
    const threadId =
      (typeof task.threadId === "string" && task.threadId.trim()) ||
      (typeof task.thread_id === "string" && task.thread_id.trim()) ||
      "main";
    if (spaceId) {
      try {
        const packets = await fetchSpaceConversation(bridge, { spaceId, threadId });
        task.history = buildHistoryTurns(packets, task.self, { excludeText: objective });
        log("GROK_HISTORY", { spaceId, threadId, fetched: packets.length, turns: task.history.length });
      } catch (err) {
        log("GROK_HISTORY", { error: String(err?.message || err) });
      }
    }
  }

  // The platform-wide instruction an admin set for every agent on this platform,
  // read from the settings creature's on-chain document at execution time so an
  // edit in the admin panel reaches every agent's next turn without a redeploy.
  const universalInstruction = await readUniversalInstruction(bridge);

  // The project's shared plan: the outcome, what makes it done, what the team has
  // already produced, and what is still open. Read per run so an agent starting
  // now sees what an agent that finished a second ago registered.
  const spaceForPlan = task.spaceId || task.storeId || task.space_id || "";
  const plan = spaceForPlan ? await readProjectPlan(bridge, { spaceId: spaceForPlan, threadId: runThreadId }) : null;
  const planBlock = plan ? renderPlanForPrompt(plan, { self: task.self }) : "";
  if (plan) {
    log("GROK_PLAN", {
      goal: Boolean(plan.goal),
      acceptance: plan.acceptance.length,
      tasks: plan.tasks.size,
      artifacts: plan.artifacts.size,
    });
  }

  const systemPrompt = buildSystemPrompt(task, {
    capabilities,
    sharedEnv,
    disabledBuiltins: disallowedTools,
    mcpServers: attachedMcpServers,
    workspace,
    universalInstruction,
    planBlock,
    planTools: Boolean(spaceForPlan),
  });
  const grokHomeGuess = resolveGrokHome({ slug: sessionSlug(sessionId) });
  const resuming = Boolean(persistedConversationSession(grokHomeGuess) || task.resumeSessionId);

  // What the team did while this agent was not looking.
  //
  // A resumed engine session carries this agent's OWN past turns and nothing
  // about anyone else's, and the compact room transcript was skipped exactly
  // when a session was resumed — so from its second turn onward an agent planned
  // as if the project were where it left it, and rebuilt what a teammate had
  // already built. The delta is always fetched, resumed or not: on a fresh
  // session it complements the transcript, and on a resumed one it is the only
  // thing standing between this agent and duplicating a colleague's work.
  let teamDelta = null;
  if (bridge && spaceForPlan) {
    try {
      teamDelta = await fetchTeamActivitySince(bridge, {
        spaceId: spaceForPlan,
        threadId: runThreadId,
        self: task.self,
      });
      if (teamDelta.lines.length) log("GROK_DELTA", { since: teamDelta.cutoff, lines: teamDelta.lines.length });
    } catch (err) {
      log("GROK_DELTA", { error: String(err?.message || err).slice(0, 160) });
    }
  }

  const prompt = buildUserPrompt(task, {
    objective,
    attachments,
    extractedTexts,
    workspace,
    includeHistory: !resuming,
    teamDelta,
  });
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
    delta_lines: teamDelta && teamDelta.lines.length ? teamDelta.lines.length : undefined,
    plan_artifacts: plan && plan.artifacts.size ? plan.artifacts.size : undefined,
    tools: lastToolDefs.map((t) => t.name),
    shared_env: sharedEnv?.name,
    sandbox_backend: sandboxActive || undefined,
    disallowed_builtins: disallowedTools.length ? disallowedTools : undefined,
    skill: Boolean(task.skill),
    universal_instruction_chars: universalInstruction.length || undefined,
    group_chat: Boolean(task.groupChat || task.group_chat),
    roster: Array.isArray(task.roster) ? task.roster.length : 0,
    llm: config.llm ? { provider: config.llm.provider, models: config.llm.models } : undefined,
    stream_to: stepTarget || undefined,
    correlationId: correlationId || undefined,
    max_wall_seconds: maxWallSeconds,
  });

  // Keep the stream alive for the duration of the run so a long, quiet stretch
  // (a minutes-long tool call, a long model turn) does not look like a stall to
  // the client. Only meaningful when we are actually streaming to someone.
  const heartbeatTimer = streamSteps && heartbeatMs > 0 ? setInterval(sendHeartbeat, heartbeatMs) : null;
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

  // Live billing checkpoints. While the run works, charge the tool + sandbox cost
  // it has accrued so far against the shared pool. Model tokens are only known at
  // the end, so they settle once on completion; tools (the runaway cost) are
  // metered live here. If a debit reports the pool exhausted, abort the Grok child
  // — its session is persisted, so the run pauses instead of running up unpayable
  // cost, and the app can resume it after a top-up. Only live pool sessions charge.
  const liveBilling = Boolean(billingSession && billingSession.mode === "live");
  const abortController = liveBilling && typeof AbortController === "function" ? new AbortController() : null;
  let pausedForFunds = false;
  let checkpointBusy = false;
  const checkpointMs = Math.max(0, creatureNumber("BILLING_CHECKPOINT_MS", 10000));
  const runCheckpoint = async () => {
    if (!liveBilling || checkpointBusy || pausedForFunds) return;
    checkpointBusy = true;
    try {
      const res = await chargeAgentCheckpoint(bridge, billingSession, {
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Date.now() - started,
        sandboxActive,
        tools: invoker ? invoker.usageSnapshot() : [],
      });
      if (res && res.exhausted) {
        pausedForFunds = true;
        log("GROK_BILLING", { paused: "pool_exhausted", remaining: res.remaining });
        abortController?.abort();
      }
    } catch (err) {
      log("GROK_BILLING", { checkpoint_error: String(err?.message || err) });
    } finally {
      checkpointBusy = false;
    }
  };
  const checkpointTimer =
    liveBilling && checkpointMs > 0 ? setInterval(runCheckpoint, checkpointMs) : null;
  if (checkpointTimer && typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  let run;
  try {
    run = await runGrok({
      abortSignal: abortController?.signal,
      resumeSessionId: typeof task.resumeSessionId === "string" ? task.resumeSessionId : undefined,
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (sandboxBridge) await sandboxBridge.stop();
    if (socketServer) await socketServer.stop();
    if (invoker) toolUsage = invoker.usageSnapshot();
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
  // Media the agent shared: upload the bytes to blob storage HERE, as this
  // creature, and carry only references from this point on. Bytes never enter
  // the terminal result (which crosses the node's signal frame) nor the space's
  // log — a reference is what a chat turn holds, and every client builds the
  // file's address from the id against its own storage base.
  const collectedMedia = mediaCollector.attachments();
  if (collectedMedia.length) {
    log("GROK_MEDIA", {
      outbound: collectedMedia.map(({ name, mimeType, kind, size, source }) => ({ name, mimeType, kind, size, source })),
    });
  }
  const { refs: outboundAttachments, failed: attachmentErrors } = await uploadOutboundMedia(
    bridge,
    collectedMedia,
  );
  if (attachmentErrors.length) log("GROK_MEDIA", { upload_failed: attachmentErrors });
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
    attachmentErrors,
  });
  // Keep charge-driving observations private. In particular, result.durationMs
  // may reflect a child-runner field; billing uses only this host-measured wall
  // time and the platform meter's own sandbox-active decision.
  Object.defineProperty(result, BILLING_OBSERVED, {
    value: {
      promptTokens: result.usage?.promptTokens || 0,
      completionTokens: result.usage?.completionTokens || 0,
      durationMs: Date.now() - started,
      sandboxActive,
      tools: toolUsage,
    },
    enumerable: false,
  });
  if (run.stderr?.trim()) log("GROK_STDERR", { tail: run.stderr.trim().split("\n").slice(-6) });

  // The run was paused because the payer's pool emptied mid-flight. Mark the
  // result (so serveAgent surfaces "paused", not "failed") and persist a
  // non-rendering `run-paused` checkpoint on the space carrying the Grok session
  // to resume — the app shows a Continue affordance and, after a top-up, re-signals
  // the run with `resumeSessionId` so the backbone continues this exact session.
  if (pausedForFunds) {
    result.pausedForFunds = true;
    result.resumeSessionId = run.sessionId || "";
    try {
      const spaceId = task.spaceId || task.storeId || task.space_id;
      if (spaceId) {
        await postSpaceSignal(bridge, {
          spaceId,
          // A pause is addressed to the person, not part of the work trail: it
          // rides the conversation so the app reads it in the same fetch as the
          // chat and can offer the Continue affordance after a top-up.
          kind: KIND.MESSAGE,
          threadId: runThreadId,
          agentProgramId: task.proxyProgramId || task.self?.programId || "",
          correlationId,
          data: {
            role: "system",
            kind: "run-paused",
            text: "",
            threadId: runThreadId,
            runPaused: {
              runId: correlationId,
              resumeSessionId: run.sessionId || "",
              reason: "out-of-funds",
              agentProgramId: task.proxyProgramId || task.self?.programId || "",
              agentName: task.self?.name || task.agentName || "",
            },
          },
        });
      }
    } catch (err) {
      log("GROK_BILLING", { paused_marker_error: String(err?.message || err) });
    }
  }

  process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

/** The teammates this answer @mentions, resolved against the space roster. */
function scanMentions(answer, roster) {
  const out = [];
  if (!answer || !Array.isArray(roster)) return out;
  for (const r of roster) {
    const handle = r && typeof r.handle === "string" ? r.handle.trim() : "";
    if (!handle) continue;
    const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9-])@${esc}(?![a-z0-9-])`, "i").test(answer)) {
      out.push({
        ...(typeof r.id === "string" ? { id: r.id } : {}),
        ...(typeof r.name === "string" ? { name: r.name } : {}),
        handle: r.handle,
        ...(r.kind ? { kind: r.kind } : {}),
      });
    }
  }
  return out;
}

/**
 * Store the agent's final answer as one persistent chat signal on the space.
 *
 * This backbone is the ONLY writer of an agent's answer: it runs the turn, so it
 * is the one party that always knows the answer happened, whether or not a
 * client was still connected. The app never writes it, which is why there is no
 * longer any two-writer convergence to reconcile.
 */
async function persistAnswer(bridge, task, result) {
  try {
    if (!bridge || !task || !result || result.success === false) return;
    const answer = typeof result.answer === "string" ? result.answer.trim() : "";
    if (!answer) return;
    const spaceId = task.spaceId || task.storeId || task.space_id;
    const correlationId = task.correlationId || task.correlation_id;
    if (!spaceId || !correlationId) return;
    const self = task.self && typeof task.self === "object" ? task.self : {};
    const agentName = typeof self.name === "string" && self.name.trim() ? self.name.trim() : undefined;
    const threadId = typeof task.threadId === "string" && task.threadId.trim() ? task.threadId.trim() : undefined;
    const agentProgramId = typeof task.agentProgramId === "string" && task.agentProgramId.trim() ? task.agentProgramId.trim() : undefined;
    const mentions = scanMentions(answer, task.roster);
    // References, already uploaded by the run itself — recorded on the same turn
    // as the answer they came with, so the media and the words are ONE record
    // with one writer.
    const attachments = Array.isArray(result.attachments) ? result.attachments : [];
    const failed = Array.isArray(result.attachmentErrors) ? result.attachmentErrors : [];
    const data = {
      text: answer,
      from: "agent",
      role: "agent",
      runId: String(correlationId),
      at: new Date().toISOString(),
      ...(agentName ? { agentName } : {}),
      ...(agentProgramId ? { agentProgramId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      ...(Number.isFinite(result.chargedMinor) ? { chargedMinor: result.chargedMinor } : {}),
      ...(Number.isFinite(result.sandboxMinor) ? { sandboxMinor: result.sandboxMinor } : {}),
      ...(Number.isFinite(result.llmMinor) ? { llmMinor: result.llmMinor } : {}),
      ...(Number.isFinite(result.durationMs) ? { durationMs: result.durationMs } : {}),
      ...(attachments.length ? { attachments } : {}),
      // Media that could not be stored is named in the turn rather than dropped:
      // a missing image with no explanation is worse than a note saying why.
      ...(failed.length ? { attachmentErrors: failed } : {}),
    };
    await postSpaceSignal(bridge, {
      spaceId,
      kind: KIND.ANSWER,
      threadId: threadId || "main",
      agentProgramId,
      correlationId,
      mentions,
      data,
    });
    log("GROK_PERSIST", {
      spaceId,
      threadId: threadId || "main",
      chars: answer.length,
      mentions: mentions.length,
      attachments: attachments.length,
    });
  } catch (err) {
    // The answer is the turn the user is waiting for and was billed for. If it
    // could not be recorded, say so at full volume and mark the result, so the
    // failure is visible in the run's own reply rather than only as a chat that
    // never shows an answer.
    const message = String(err?.message || err).slice(0, 300);
    log("GROK_PERSIST", { error: message, note: "the answer was NOT recorded in the space" });
    if (result && typeof result === "object") result.persistError = message;
  }
}

/**
 * Answer one delivery and signal the terminal result back through `replyTo` (the
 * proxy entity), which is what closes the correlation the requester is waiting
 * on. A run that throws still produces a reply — silence would leave the user's
 * client spinning until the backend's timeout.
 */
async function retrySettlement(settle) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await settle();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("billing settlement failed");
}

async function serveDirectTool(bridge, delivery) {
  let session;
  try {
    session = await authorizeDirectToolRun(bridge, delivery);
  } catch (err) {
    return {
      result: { ok: false, error: String(err?.message || err).slice(0, 400) },
      billing: { status: "rejected" },
    };
  }

  let execution;
  try {
    execution = await runDirectTool(bridge, delivery, session);
  } catch (err) {
    try {
      await releaseBillingRun(bridge, session, "direct tool execution failed before a completion receipt");
      return {
        result: { ok: false, error: String(err?.message || err).slice(0, 400) },
        billing: { status: "released", chargedMinor: 0 },
      };
    } catch (releaseError) {
      return {
        result: {
          ok: false,
          error: `billing release pending reconciliation: ${String(releaseError?.message || releaseError)}`.slice(0, 400),
        },
        billing: { status: "pending_reconciliation" },
      };
    }
  }

  if (!execution.settled) {
    return {
      result: execution.result,
      billing: { status: "released", chargedMinor: 0 },
    };
  }

  try {
    const settlement = await retrySettlement(
      () => settleDirectToolRun(bridge, session, execution.observed),
    );
    return {
      result: execution.result,
      billing: {
        status: "settled",
        chargedMinor: settlement.chargedMinor,
        usageHash: settlement.usageHash,
      },
    };
  } catch (err) {
    return {
      result: {
        ok: false,
        error: `billing settlement pending reconciliation: ${String(err?.message || err)}`.slice(0, 400),
      },
      billing: { status: "pending_reconciliation" },
    };
  }
}

function errText(err) {
  return String(err?.message || err || "");
}

/**
 * Release a running/open hold, swallowing and logging any release failure. A
 * failed release (Caspar unreachable, or the hold already closed elsewhere) must
 * never mask the original run error — reconciliation's stale-hold check is the
 * backstop. Idempotent server-side: Caspar's releaseHold rejects an
 * already-settled hold, so a release that races a settlement cannot double-refund.
 */
async function releaseBillingSafely(bridge, session, reason) {
  if (!bridge || !session) return;
  try {
    await releaseBillingRun(bridge, session, reason);
  } catch (releaseError) {
    log("GROK_BOOT", { billing_release_error: errText(releaseError).slice(0, 200) });
  }
}

/**
 * Serve one agent prompt end to end, owning its billing lifecycle. The hold is
 * moved open→running by `authorizeBillingRun`; from that point the payer's funds
 * are "held for active runs" and ONLY this meter (the hold's settlement
 * authority) can free them before the hold's TTL expires — the app, as payer,
 * cannot release a *running* hold. So every exit path must reach the hold:
 * settle it on a completed run, or release it when the run fails before a valid
 * settlement. Leaving it dangling strands the authorization — up to the
 * safety-factored ceiling (as much as 10× the estimate) — in the wallet for the
 * full hold TTL, which is exactly the "money held for active runs that never
 * comes back" wallet drain. Mirrors serveDirectTool's failure handling.
 *
 * `runTask` is injectable so the billing lifecycle can be exercised in tests
 * without spawning a grok child; production always uses handleTask.
 */
export async function serveAgent(bridge, delivery, runTask = handleTask) {
  // Every production platform run is billable and fails closed. The only bypass
  // is an explicit test flag while NODE_ENV is exactly "test".
  const unbilledTest = process.env.NODE_ENV === "test"
    && creatureFlag("TEST_UNBILLED", false);
  const billingSession = bridge && !unbilledTest
    ? await authorizeBillingRun(bridge, delivery)
    : null;

  let result;
  try {
    result = await runTask(bridge, delivery, billingSession);
  } catch (err) {
    // The run authorized (and started) a hold but never produced a settlement.
    // Release it with zero charge so the payer's funds return immediately
    // instead of staying held until the hold's TTL expires.
    await releaseBillingSafely(bridge, billingSession, `agent run failed before settlement: ${errText(err)}`);
    throw err;
  }

  if (!billingSession) return result;

  const observed = result[BILLING_OBSERVED] || {
    promptTokens: 0,
    completionTokens: 0,
    durationMs: 0,
    sandboxActive: false,
  };
  const spaceId = String(delivery?.task?.spaceId || delivery?.task?.space_id || "");
  if (spaceId) {
    try {
      const cap = Number(billingSession.quote?.priceSnapshot?.authorizedRuntimeMs);
      const machineMs = await takeMachineMs(bridge, spaceId, null, {
        capMs: Number.isSafeInteger(cap) && cap > 0 ? cap : 600_000,
        commit: true,
      });
      if (machineMs > 0) observed.machineMs = machineMs;
    } catch {
      /* wall-clock computer time is best-effort on top of token/tool receipts */
    }
  }
  let settlement;
  try {
    settlement = await retrySettlement(
      () => settleBillingRun(bridge, billingSession, observed),
    );
  } catch (err) {
    // Settlement could not be applied — observed usage outran the authorized
    // ceiling, a beneficiary cap was exceeded, or Caspar rejected the atomic
    // write. The hold is still running; release it so the authorization is
    // refunded rather than stranded, then surface the failure for reconciliation.
    await releaseBillingSafely(bridge, billingSession, `agent settlement failed: ${errText(err)}`);
    throw new Error(
      `billing settlement pending reconciliation: ${errText(err) || "unknown error"}`,
    );
  }
  result.chargedMinor = settlement.chargedMinor;
  result.billingUsageHash = settlement.usageHash;
  const split = splitSettledCharge(settlement);
  result.sandboxMinor = split.sandboxMinor;
  result.llmMinor = split.llmMinor;
  return result;
}

export async function serveOnce(bridge, delivery) {
  const directTool = delivery?.task?.kind === "direct_tool";
  let result;
  let directBilling = null;
  try {
    if (directTool) {
      if (!bridge) throw new Error("direct tool execution requires a connected meter");
      const completed = await serveDirectTool(bridge, delivery);
      result = completed.result;
      directBilling = completed.billing;
    } else {
      result = await serveAgent(bridge, delivery);
    }
  } catch (err) {
    log("GROK_BOOT", { run_error: String(err?.stack || err).slice(0, 400) });
    result = directTool
      ? { ok: false, error: String(err?.message || err).slice(0, 400) }
      : {
          objective: taskObjective(delivery.task || {}),
          engine: "grok-build",
          success: false,
          answer: "I could not complete this request.",
          error: String(err?.message || err).slice(0, 400),
        };
    if (directTool && !directBilling) directBilling = { status: "rejected" };
    process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  }
  if (bridge && delivery.replyTo) {
    try {
      await bridge.signalUser("creatures/signal", String(delivery.replyTo), {
        kind: directTool ? "tools/direct_result" : "davinci/result",
        correlationId: delivery.correlationId,
        // Terminal message: closes the proxy correlation the streamed steps
        // (when routed through the proxy) kept open.
        final: true,
        stream: false,
        result,
        ...(directTool ? { billing: directBilling } : {}),
      });
    } catch (err) {
      log("GROK_BOOT", { reply_error: String(err?.message || err).slice(0, 200) });
    }
  }
  // Direct tool executions have no chat answer to persist. Agent answers remain
  // durable and merge with the app's own write by correlation id.
  if (!directTool) await persistAnswer(bridge, delivery.task || {}, result);
  return result;
}

/**
 * Tell the requester their prompt is on the agent's board rather than running.
 *
 * This is a TERMINAL reply on the original correlation, deliberately: the agent
 * is busy, and how long it stays busy is not something a waiting client can be
 * asked to sit through (its own idle watchdog would give up first, and holding a
 * billing authorization open for an unknown wait is worse still). So the client
 * releases its hold and shows the turn as queued; when the agent gets to the
 * task, the backbone runs it unattended on a delegated quote and the answer
 * lands in the chat like any other — no client needed, and none kept waiting.
 */
async function replyQueued(bridge, delivery, record) {
  const result = {
    objective: taskObjective(delivery.task || {}),
    engine: "grok-build",
    success: true,
    queued: true,
    answer: "",
    task: {
      taskId: record.taskId,
      title: record.title,
      spaceId: record.spaceId,
      threadId: record.threadId,
      agentProgramId: record.agentProgramId,
      agentName: record.agentName,
    },
  };
  process.stdout.write(`DAVINCI_RESULT ${JSON.stringify(result)}\n`);
  if (!bridge || !delivery.replyTo) return;
  try {
    await bridge.signalUser("creatures/signal", String(delivery.replyTo), {
      kind: "davinci/result",
      correlationId: delivery.correlationId,
      final: true,
      stream: false,
      result,
    });
  } catch (err) {
    log("GROK_TASKBOARD", { queued_reply_error: String(err?.message || err).slice(0, 200) });
  }
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
    if (!delivery) {
      // A push this creature cannot read as a task is dropped — but never in
      // silence. "The prompt never arrived" and "the prompt arrived in a shape
      // I discarded" look identical from the outside, and the difference is the
      // whole diagnosis when agents stop answering. Bounded so an unrelated
      // fan-out cannot flood the log.
      log("GROK_DROPPED", {
        key,
        correlationId: String(data?.correlationId || ""),
        from: String(data?.user?.id || ""),
        store: String(data?.store?.id || data?.storeId || ""),
        shape: Object.keys(data && typeof data === "object" ? data : {}).slice(0, 12),
      });
      return;
    }
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
  // One worker per agent per project, and the backlog behind it. Every prompt
  // addressed to an agent becomes a task on its board; the board runs it now if
  // the agent is free, and otherwise keeps it until the agent finishes what it is
  // on. See agentQueue.mjs — this is why two instances of one agent never work at
  // the same time, while different agents still run fully in parallel.
  const board = new AgentTaskBoard();
  const startDelivery = (activeBridge, delivery) => {
    const task = (async () => {
      try {
        // Does this agent take the work now, or does it go on its board? A
        // delivery the board does not own (a direct tool call, a spaceless run)
        // is admitted straight through, exactly as before.
        const admission = await board.admit(activeBridge, delivery);
        if (admission !== "run") {
          if (admission && admission.queued) await replyQueued(activeBridge, delivery, admission.queued);
          return;
        }
        // A server-orchestrated delivery that arrived without a billing
        // authorization (a routine firing with no client to mint one) needs a
        // delegated quote built before it can run. No-op when the client already
        // supplied one.
        if (activeBridge && isServerOrchestrated(delivery.task)) {
          const ready = await ensureDelegatedAuthorization(activeBridge, delivery);
          if (!ready) {
            log("GROK_ORCH", { skipped: "no-delegated-authorization", correlationId: delivery.correlationId });
            // The task was claimed off the board for a run that cannot be paid
            // for. Close it out (and free the agent) rather than leaving the
            // board holding a task nobody will ever run.
            await board.finish(activeBridge, delivery, {
              success: false,
              error: "no delegated billing authorization for this run",
            });
            return;
          }
        }
        // Show a backbone-launched (teammate/routine) run in the app's Status
        // while it works — a no-op for the client's own seed run.
        await recordServerRun(activeBridge, delivery, { status: "started", startedAt: Date.now() });
        const result = await serveOnce(activeBridge, delivery);
        await recordServerRun(activeBridge, delivery, {
          status: result && result.success === false ? "error" : "ok",
          endedAt: Date.now(),
          ...(result && result.success === false && result.error ? { error: String(result.error).slice(0, 300) } : {}),
          ...(result && result.answer ? { lastStep: String(result.answer).replace(/\s+/g, " ").trim().slice(0, 280) } : {}),
        });
        // Record what this run cost against its project's budget, then drive the
        // hand-off chain forward — the backbone launches whichever teammates this
        // answer named, so the chain completes with no client present. Settling
        // runs for EVERY billable run in a project, not just backbone-launched
        // ones: a cap that only counted unattended work would let a person's own
        // prompts spend past their own project budget.
        await settleProjectSpend(activeBridge, delivery, result);
        await planAndLaunchFollowups(activeBridge, delivery, result);
        // Archive this task off the agent's board and let it choose what to do
        // next — the cycle that keeps the queue draining with no client present.
        await board.finish(activeBridge, delivery, result);
      } catch (err) {
        log("GROK_BOOT", { serve_error: String(err?.message || err).slice(0, 200) });
        // A run that threw still ends its task: leaving it "started" would hold
        // the agent's only slot forever and stall everything behind it.
        try {
          await board.finish(activeBridge, delivery, { success: false, error: String(err?.message || err).slice(0, 300) });
        } catch {
          /* the board reports its own failures */
        }
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

      log("GROK_READY", { machine_id: bridge.machineId, program_id: bridge.programId, served, queued: deliveries.depth, inflight: inFlight.size, agents_busy: board.activeCount, ts: Date.now() / 1000 });
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
