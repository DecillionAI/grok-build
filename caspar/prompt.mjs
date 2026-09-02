/**
 * Prompt composition: turning a Caspar task into what Grok Build is given.
 *
 * A task delivered by the Decillion backend carries far more than a question:
 *
 *   • `skill`      — the agent's deployed skill file (the proxy entity's
 *                    attachment). This IS the agent's identity and must override
 *                    any default persona, so it becomes an appended system
 *                    prompt, not part of the user turn.
 *   • `self` / `roster` / `groupChat` — a space is a shared group chat with
 *                    several agents and people; the agent has to know who it is,
 *                    who else is present, and the @mention protocol that decides
 *                    who gets triggered next.
 *   • `history`    — retained on the delivery envelope for compatibility, but
 *                    not flattened into the next user message. Grok's persisted
 *                    session owns conversation history and context compaction.
 *   • `attachments`— files materialised into the workspace.
 *
 * Stable identity/capability information belongs in Grok's system rules. The
 * user turn contains only the current message and its current attachments.
 */

/** The agent's own identity, as sent by the backend. */
function selfIdentity(task) {
  const self = task.self && typeof task.self === "object" ? task.self : {};
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { id: pick(self.id), name: pick(self.name), handle: pick(self.handle) };
}

/** The other participants in the space (this agent removed). */
function otherParticipants(task) {
  const me = selfIdentity(task);
  const mine = new Set([me.id, me.name, me.handle].filter(Boolean).map((v) => v.toLowerCase()));
  const roster = Array.isArray(task.roster) ? task.roster : [];
  const out = [];
  for (const entry of roster) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = (typeof entry.name === "string" && entry.name.trim()) || (typeof entry.label === "string" && entry.label.trim()) || "";
    const handle = typeof entry.handle === "string" ? entry.handle.trim() : "";
    const kind = entry.kind === "user" ? "user" : "agent";
    if (!name && !handle) continue;
    const keys = [id, name, handle].filter(Boolean).map((v) => v.toLowerCase());
    if (kind === "agent" && keys.some((k) => mine.has(k))) continue; // this is me
    out.push({ id, name: name || handle, handle, kind });
  }
  return out;
}

/** True when this run is part of a shared multi-party space conversation. */
export function isGroupChat(task) {
  const me = selfIdentity(task);
  return Boolean(task.groupChat || task.group_chat || otherParticipants(task).length || me.name || me.handle);
}

/**
 * The group-chat section of the system prompt: who this agent is, who else is
 * here, and how @mention triggering works. Empty outside a group chat, so a
 * one-shot prompt is unaffected.
 */
export function groupChatPreamble(task) {
  if (!isGroupChat(task)) return "";
  const me = selfIdentity(task);
  const myName = me.name || "this agent";
  let who = `You are "${myName}"`;
  if (me.handle) who += ` (your @handle is @${me.handle})`;
  who += ".";

  const others = otherParticipants(task);
  const rosterBlock = others.length
    ? `The other participants in this space are:\n${others
        .map((r) => `  • ${r.name}${r.handle ? ` — @${r.handle}` : ""} (${r.kind === "agent" ? "agent" : "person"})`)
        .join("\n")}\n`
    : "";

  return (
    "=== GROUP CHAT ===\n" +
    "You are one participant in a shared, multi-party group chat with several " +
    `agents and people. ${who}\n` +
    rosterBlock +
    "How this conversation works:\n" +
    "  • Every message is visible to everyone, but a message is only *directed* " +
    "at the participants it @mentions. Prior turns are annotated with who they " +
    'were From and who they were directed To; a turn marked "(directed at you)" ' +
    "is addressed to you, others you are only overhearing.\n" +
    "  • You were triggered because the latest turn is directed at you. Respond " +
    "to it in your own voice.\n" +
    "  • @mention is the ONLY way to reach another agent or person, and it is the " +
    "way you are expected to collaborate. To hand work to, ask something of, or " +
    "bring in a teammate, @mention their handle (e.g. @some-agent) in your reply " +
    "— that is what notifies and triggers them. There is no separate tool for " +
    "calling another agent; do NOT try to invoke a teammate as a tool or wait on " +
    "them inside this turn.\n" +
    "  • Talking to a teammate is ASYNCHRONOUS. When you @mention someone, they " +
    "reply LATER as their own new message in this chat — you will NOT receive " +
    "their answer inside your current turn, and you must not stall waiting for " +
    "it. So finish your turn by clearly stating what you need and @mentioning " +
    "whoever should act next, then stop; you (or they) can build on their reply " +
    "when it arrives as a following turn.\n" +
    "  • Only @mention someone when you actually need something from them. If " +
    "several teammates can start from the same artifact you just produced and none " +
    "is blocked on another, @mention all of them in this same final reply, each " +
    "with a specific ask, so they run in parallel. If B needs A's files, URL, or " +
    "findings, @mention A only; A @mentions B when that artifact is ready. Do not " +
    "mention a blocked teammate early. After you finish independent work, do not " +
    "courtesy-ping the whole roster — @mention only who must do the next blocked step.\n" +
    "  • Your tool calls are shown to everyone in this chat as they happen (a " +
    "structured entry per call), so the team can already see the work — do not " +
    "narrate every tool call in your prose.\n" +
    "  • If a message is merely acknowledging or thanking you and you have " +
    "nothing further to add, do NOT keep the loop going: reply briefly WITHOUT " +
    "@mentioning the sender (an @mention would re-trigger them and bounce the " +
    "conversation back and forth forever).\n" +
    "  • Do not @mention yourself, and do not repeat another participant's answer " +
    "as if it were your own.\n" +
    "=== END GROUP CHAT ===\n"
  );
}

/**
 * The "what you can do in this space" section: the tools, apps and creatures the
 * space contains, so the model plans WITH them instead of only answering from its
 * own knowledge or its harness's generic built-ins. Each is a real, callable tool
 * (surfaced under the `caspar` MCP server, invoked through Grok's `use_tool`
 * meta-tool). Other AGENTS are deliberately NOT listed here: a teammate is not a
 * tool you call, it is a participant you @mention (see the group-chat section) —
 * that hand-off is asynchronous, so it never belongs on this synchronous
 * tool-calling surface. Empty when the space has no employable creatures, so a
 * bare one-shot prompt is unaffected.
 *
 * `capabilities` is `[{ name, description, kind }]` — `name` is the exact
 * qualified MCP tool name (`caspar__<tool>`) the model passes to `use_tool`, so
 * what it reads here matches what it can invoke.
 * `opts.sharedEnv` (`{ name, description }`) is the space's shared machine (the
 * cloud sandbox), when the space has one: the team's real, shared filesystem and
 * shell, which the agent must use for collaborative work instead of its own
 * private local workspace.
 */
export function capabilitiesPreamble(capabilities, opts = {}) {
  const list = Array.isArray(capabilities) ? capabilities.filter((c) => c && typeof c === "object" && c.name) : [];
  // Agents are never a callable capability — they are @mention participants, not
  // tools (see the module comment and the group-chat preamble). Drop any that
  // leak in so this section only ever lists real, synchronously-callable tools.
  const tools = list.filter((c) => c.kind !== "agent");
  const attachedMcp = Array.isArray(opts.mcpServers) ? opts.mcpServers.filter((m) => m && m.name) : [];
  if (!tools.length && !attachedMcp.length) return "";

  /**
   * Render one capability with its inline schema so the model can call it
   * without a second search_tool round-trip. Historically the listing only
   * carried name + description; multi-function creatures (the sandbox, the
   * github tool) declare their operations in a `function` field of the
   * schema, and without seeing its enum the model routinely invented
   * compound tool names like `caspar__sandbox_exec` — which do not
   * exist — and then reported "I don't have access to that action" to the
   * user. Rendering the enum + the other args inline fixes that at source.
   */
  const renderTool = (c) => {
    const parts = [`  • ${c.name}`];
    if (c.description) parts.push(`— ${String(c.description).slice(0, 300)}`);
    const props = c.inputSchema && typeof c.inputSchema === "object" ? c.inputSchema.properties : null;
    const required = c.inputSchema && Array.isArray(c.inputSchema.required) ? c.inputSchema.required : [];
    const pinned = new Set(Array.isArray(c.defaults) ? c.defaults : []);
    let head = parts.join(" ");
    if (!props || typeof props !== "object") return head;
    const argLines = [];
    // Surface `function` first (it decides which operation runs), then the
    // rest of the args in schema order. Skip anything the platform pins for
    // this call — the model must never pass those, and listing them invites
    // it to try.
    const keys = Object.keys(props);
    keys.sort((a, b) => (a === "function" ? -1 : b === "function" ? 1 : 0));
    for (const key of keys) {
      if (pinned.has(key)) continue;
      const spec = props[key] && typeof props[key] === "object" ? props[key] : {};
      const type = typeof spec.type === "string" ? spec.type : "string";
      const enumValues = Array.isArray(spec.enum) ? spec.enum : null;
      const isRequired = required.includes(key);
      const enumLabel = enumValues && enumValues.length
        ? ` = one of { ${enumValues.slice(0, 24).join(", ")}${enumValues.length > 24 ? ", …" : ""} }`
        : "";
      const desc = typeof spec.description === "string" && spec.description
        ? ` — ${String(spec.description).slice(0, 180)}`
        : "";
      const req = isRequired ? "" : " (optional)";
      argLines.push(`      – ${key}: ${type}${enumLabel}${req}${desc}`);
    }
    if (c.defaultFunction && props.function) {
      head += ` (default function: \`${c.defaultFunction}\`)`;
    }
    if (pinned.size) {
      head += ` — the platform pins ${[...pinned].join(", ")}, do NOT pass ${pinned.size === 1 ? "it" : "them"}`;
    }
    if (!argLines.length) return head;
    return `${head}\n    tool_input:\n${argLines.join("\n")}`;
  };

  const render = (c) => renderTool(c);

  const sharedEnv = opts.sharedEnv && opts.sharedEnv.name ? opts.sharedEnv : null;
  const disabledBuiltins = Array.isArray(opts.disabledBuiltins) ? opts.disabledBuiltins.filter(Boolean) : [];
  const offClause = disabledBuiltins.length
    ? " Your engine's own built-in shell and file tools (" +
      disabledBuiltins.slice(0, 8).join(", ") +
      (disabledBuiltins.length > 8 ? ", …" : "") +
      ") are turned OFF in this space on purpose — running a command or touching a " +
      "file means calling `" +
      sharedEnv?.name +
      "`; there is no other shell or filesystem available to you here."
    : "";
  const sharedBlock = sharedEnv
    ? "SHARED WORKSPACE — `" +
      sharedEnv.name +
      "` is this space's shared cloud machine (a real filesystem + shell), bound to " +
      "this space and shared by everyone in it. IT, not your own local working " +
      "directory, is where the team collaborates: run shell commands, install, build, " +
      "test, and read/write the project's files THERE through that tool, so the other " +
      "agents and people see the same files and results. Your local working directory " +
      "is private scratch that no one else can see — never leave shared project work " +
      "only in it." +
      offClause +
      "\n"
    : "";

  const sections = [];
  if (tools.length) sections.push(`Tools & creatures you can call:\n${tools.map(render).join("\n")}`);

  /**
   * MCP servers the project attached (`opts.mcpServers`, from
   * `mcpAttach.mcpServerSummaries`). These are NOT Caspar creatures: the engine
   * connects to each one itself and exposes its tools as
   * `<server>__<tool>` — so the names cannot be listed up front, and the agent
   * has to look them up. Naming the servers is what makes it look: without this
   * the section above reads as the complete list of what it can do, and a
   * server the project deliberately added never gets used.
   */
  const mcpServers = Array.isArray(opts.mcpServers) ? opts.mcpServers.filter((m) => m && m.name) : [];
  if (mcpServers.length) {
    const lines = mcpServers.map((m) => {
      const bits = [`  • ${m.name}`];
      if (m.label && m.label !== m.name) bits.push(`(${m.label})`);
      if (m.description) bits.push(`— ${m.description}`);
      else if (m.host) bits.push(`— ${m.host}`);
      return bits.join(" ");
    });
    sections.push(
      "MCP servers connected to this space — external services this project added, " +
        "each with its own tools:\n" +
        lines.join("\n") +
        "\nTheir tools are named `<server>__<tool>` (e.g. `" +
        mcpServers[0].name +
        "__…`) and are called with `use_tool` exactly like the ones above. They are " +
        "part of what you can do here: when a request matches one of these services, " +
        "list its tools (`search_tool`, or your engine's tool list) and use them " +
        "instead of saying you have no access to that service.",
    );
  }

  return (
    "=== WHAT YOU CAN DO IN THIS SPACE ===\n" +
    "You are working inside a shared project space, not a private terminal. Your " +
    "real capabilities here are the space's own tools, its shared machine and the " +
    "other participants — exposed to you through the `caspar` MCP server. " +
    "Treat THESE as what you can do: when someone asks what tools or capabilities " +
    "you have, answer with these, not the generic editor/shell built-ins of the " +
    "harness you happen to run on.\n" +
    "HOW TO CALL THEM: each one is an MCP tool, so you invoke it with the `use_tool` " +
    'meta-tool — use_tool(tool_name: "<the name listed below>", tool_input: { … }). ' +
    "The names below are already fully qualified — use them verbatim, and NEVER " +
    "invent a compound tool name for an operation. A multi-function creature (its " +
    "listing shows a `function` field with an enum) selects the operation through " +
    "that argument: e.g. `use_tool(tool_name: \"caspar__sandbox\", " +
    'tool_input: { function: "exec", command: "npm test" })` — NOT ' +
    "`use_tool(tool_name: \"caspar__sandbox_exec\", …)`, which does not exist " +
    "and will come back as `Tool not found`. If a listing below shows no `function` " +
    'field, the tool has a single operation — just pass its named args. `search_tool` ' +
    "can refetch the live catalog when a teammate adds a tool mid-conversation.\n" +
    sharedBlock +
    sections.join("\n") +
    "\n" +
    "Plan with them: prefer a listed tool over guessing or doing by hand what one " +
    "of them is built for. Only call a capability when it actually helps the " +
    "current request. A chat-only plan or review memo is not a substitute for using " +
    "these tools. If the outcome needs a live page or service, write it on the shared " +
    "machine, start it, keep it running, and call sandbox `expose` (or `tunnel`) " +
    "with the listening port so people get a public URL they can Open in the app. " +
    "Do not leave the only URL as localhost — that is the sandbox VM, not their " +
    "laptop. Serve the actual app (index.html or the running process), never a " +
    "directory listing. To bring " +
    "in another agent for part of the work, do NOT look " +
    "for it here — @mention them in your reply (see the group chat section); that " +
    "hand-off happens asynchronously as its own chat turn, it is not a tool call.\n" +
    "=== END WHAT YOU CAN DO ===\n"
  );
}

/** Living project brief: the outcome this space is hired to accomplish. */
export function projectOutcomePreamble(task) {
  const brief =
    (typeof task.projectBrief === "string" && task.projectBrief.trim()) ||
    (typeof task.brief === "string" && task.brief.trim()) ||
    "";
  if (!brief) return "";
  return (
    "=== PROJECT OUTCOME ===\n" +
    "This space has a living brief — the outcome the team is hired to accomplish, " +
    "not a one-off chatbot prompt. Keep working toward it on every turn unless the " +
    "latest message clearly changes course. Do not stop at a plan, review memo, or " +
    "essay if tools can produce a real artifact (files on the shared machine, a " +
    "running public preview URL, sourced research, an operated system). Recurring " +
    "work named in the brief (daily posts, a weekly digest, a reminder) is part of " +
    "the outcome — schedule it with `schedule_routine`; a file on disk is not a schedule.\n\n" +
    brief +
    "\n=== END PROJECT OUTCOME ===\n"
  );
}

/**
 * Routines — scheduled follow-up work an agent can create for itself. Backed by
 * the `schedule_routine` tool (not a client-side fence): when the model calls
 * it, the backbone creates the routine on the routines creature and sets THIS
 * agent as the one responsible, so nothing here needs to parse the reply. The
 * preamble only tells the model WHEN to reach for the tool.
 */
export function projectRoutinesPreamble(task) {
  if (!task || (!task.spaceId && !task.groupChat && !isGroupChat(task))) return "";
  // Only advertise scheduling when the space actually wired the routines
  // endpoint through (older clients / non-space runs won't have the tool).
  const hasEndpoint =
    task.routinesEndpoint && typeof task.routinesEndpoint === "object"
      ? Boolean(task.routinesEndpoint.programId || task.routinesEndpoint.program_id)
      : false;
  if (!hasEndpoint) return "";
  return (
    "=== ROUTINES ===\n" +
    "You can schedule your OWN follow-up work in this project with the `schedule_routine` " +
    "tool. Call it whenever the user (or the living project brief) asks for work after a " +
    "delay or on a recurring cadence — including outcome language like \"posts I can put " +
    "on Google and Instagram every day at 9am\", not only the words \"schedule\" or " +
    "\"remind me\". Examples: \"remind me in an hour\", \"post a digest every morning\", " +
    "\"check the deploy in 30 minutes\". When it runs, the platform posts your `prompt` " +
    "into this chat mentioning you, and you handle it then — so you become the " +
    "responsible agent automatically; do not ask a person to click around.\n" +
    "For a clock time (9:00 am daily), pass `schedule=repeat` and `hour` (0–23 UTC, " +
    "convert from the user's local time if you know it) so the first fire is the next " +
    "occurrence, then every 24 hours. Use `minutes=1440` only when there is no clock time.\n" +
    "Use it ONLY for genuinely deferred or recurring work. Never schedule a routine for a " +
    "one-shot question you can answer now, and don't re-create a routine you already " +
    "scheduled in this conversation.\n" +
    "=== END ROUTINES ===\n"
  );
}

/**
 * The system prompt appended to Grok's own (`--rules`): the group-chat context, the
 * space's callable capabilities, plus the agent's persona (its deployed skill),
 * declared authoritative for identity so an agent deployed as "Tina" answers as
 * Tina and never as the underlying engine. Also states the answer contract: the
 * final assistant message is what the user in the chat receives.
 *
 * `opts.capabilities` (from the merged tool catalog) enumerates the space's
 * tools/creatures/sub-agents for the model to plan over; `opts.mcpServers`
 * names the remote MCP servers the project attached, whose tools the engine
 * reaches directly.
 */
export function buildSystemPrompt(task, opts = {}) {
  const parts = [];
  const group = groupChatPreamble(task);
  if (group) parts.push(group);

  const capabilities = capabilitiesPreamble(opts.capabilities, {
    sharedEnv: opts.sharedEnv,
    disabledBuiltins: opts.disabledBuiltins,
    mcpServers: opts.mcpServers,
  });
  if (capabilities) parts.push(capabilities);

  const outcome = projectOutcomePreamble(task);
  if (outcome) parts.push(outcome);

  const routines = projectRoutinesPreamble(task);
  if (routines) parts.push(routines);

  if (opts.workspace) {
    parts.push(
      "=== WORKSPACE ===\n" +
        `Your private working directory for this conversation is ${opts.workspace}. ` +
        "It persists between turns; shared project artifacts still belong in the space's shared machine when one is available.\n" +
        "=== END WORKSPACE ===\n",
    );
  }

  // When the shell/filesystem built-ins are disabled but the capabilities section
  // did not already explain it (no shared sandbox named there), state it plainly so
  // the model does not try — and get denied by — a local command or file edit.
  const disabled = Array.isArray(opts.disabledBuiltins) ? opts.disabledBuiltins.filter(Boolean) : [];
  if (disabled.length && !(capabilities && opts.sharedEnv && opts.sharedEnv.name)) {
    parts.push(
      "=== NO LOCAL SHELL OR FILESYSTEM ===\n" +
        "Your engine's built-in shell and file tools are DISABLED here. Do not try to " +
        "run local commands or read/write local files — those tools are gone on purpose. " +
        "Any command or file operation must go through this space's sandbox tool (a tool " +
        "under the `caspar` MCP server, called through `use_tool`). If no sandbox tool is " +
        "available to you, say so " +
        "plainly and ask for it to be attached — never claim to have run something you could not.\n" +
        "=== END ===\n",
    );
  }

  const skill = typeof task.skill === "string" && task.skill.trim() ? task.skill.trim() : typeof task.systemInstruction === "string" ? task.systemInstruction.trim() : "";
  if (skill) {
    parts.push(
      "You ARE the persona defined below. It is your identity, name, voice, " +
        "skills and rules, and it OVERRIDES any default name, role or personality " +
        "you would otherwise assume. When asked who you are or what you do, answer " +
        "strictly as this persona — never introduce yourself by the name of the " +
        "engine, harness or framework you run on.\n\n" +
        "=== YOUR PERSONA (system instruction) ===\n" +
        skill +
        "\n=== END PERSONA ===\n",
    );
  }

  parts.push(
    "=== HOW YOUR REPLY IS DELIVERED ===\n" +
      "You are running as an autonomous agent inside a chat product, not in a " +
      "terminal with a developer watching. Your FINAL assistant message is the " +
      "answer the person in the chat receives — write it as a reply to them: " +
      "self-contained prose, no meta-commentary about tools, files or steps you " +
      "took unless it is what they asked for. Intermediate work (thinking, tool " +
      "calls, their results) is streamed to the UI separately as progress, so do " +
      "not summarise your own process in the final message. Prefer a real artifact " +
      "the team can open (sandbox files, a public preview URL from an exposed " +
      "port, sourced findings) over a chat-only essay. You also have a " +
      "private local working directory of your own for scratch — but anything the " +
      "team must see belongs on the space's shared machine (see your capabilities " +
      "above), not there.\n" +
      "=== END DELIVERY ===\n",
  );
  return parts.join("\n");
}

/**
 * The user turn handed to Grok: only the current message and material that is
 * part of that message. Conversation history is deliberately absent: Grok owns
 * it through its persisted/resumed session and applies its native context
 * management instead of receiving a synthetic transcript on every turn.
 */
export function buildUserPrompt(task, { objective, attachments = [], extractedTexts = [], workspace }) {
  const parts = [];
  if (attachments.length) {
    parts.push(
      "=== FILES ATTACHED TO THIS MESSAGE ===\n" +
        attachments
          .map((a) => `  • ${a.path}${a.mimeType ? ` (${a.mimeType})` : ""}${a.description ? ` — ${a.description}` : ""}`)
          .join("\n") +
        "\n=== END FILES ===\n",
    );
  }
  // The model's message content is text + image only: an audio clip or a PDF/
  // document is not an image and the model cannot open the materialised file, so
  // its content is extracted (or transcribed) here and inlined as text — that is
  // what makes the agent able to answer about a PDF or an audio recording.
  if (Array.isArray(extractedTexts) && extractedTexts.length) {
    for (const doc of extractedTexts) {
      if (!doc || !doc.text) continue;
      const label = doc.kind === "transcript" ? "TRANSCRIPT OF" : "CONTENT OF";
      parts.push(`=== ${label} ${doc.name} ===\n${doc.text}\n=== END ${doc.name} ===\n`);
    }
  }
  parts.push(String(objective ?? ""));
  return parts.join("\n");
}
