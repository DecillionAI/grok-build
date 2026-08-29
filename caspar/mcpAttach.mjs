/**
 * HTTP / stdio MCP servers attached to a space (kind: mcp), handed to Grok as
 * native `[mcp_servers.*]` entries so the CLI speaks Streamable HTTP or spawns
 * the command itself.
 */

function slug(name) {
  const base = String(name || "mcp")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "mcp";
}

function bearerHeader(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  return /^bearer\s+/i.test(t) ? t : `Bearer ${t}`;
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).map((x) => String(x)).filter(Boolean);
}

function stringMap(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k && v != null && String(v).trim()) out[String(k)] = String(v);
  }
  return out;
}

/** Every attached MCP listing, in catalog order, with its config-file name. */
function attachedMcpEntries(catalog) {
  const out = [];
  const taken = new Set(["caspar"]);
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry !== "object") continue;
    if (String(entry.kind || "").toLowerCase() !== "mcp") continue;
    const url = String(entry.mcp_url || entry.mcpUrl || "").trim();
    const command = String(entry.mcp_command || entry.mcpCommand || "").trim();
    // HTTP needs a real url; stdio needs a command. A redacted/unhydrated
    // attach has neither the CLI can use — skip it.
    if (!/^https?:\/\//i.test(url) && !command) continue;
    const base = slug(entry.name || entry.tool_id || "mcp");
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    taken.add(name);
    out.push({ name, url, command, entry });
  }
  return out;
}

/** Catalog entries with kind mcp → grokConfig mcpServers map. */
export function httpMcpServersFromCatalog(catalog) {
  const out = {};
  for (const { name, url, command, entry } of attachedMcpEntries(catalog)) {
    if (url) {
      const headers = stringMap(entry.mcp_headers || entry.mcpHeaders);
      const auth = bearerHeader(entry.mcp_token || entry.mcpToken);
      if (auth && !headers.Authorization && !headers.authorization) headers.Authorization = auth;
      const transport = String(entry.mcp_transport || entry.mcpTransport || "").trim().toLowerCase();
      out[name] = {
        url,
        ...(transport === "sse" ? { type: "sse" } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      continue;
    }
    out[name] = {
      command,
      args: stringList(entry.mcp_args || entry.mcpArgs),
      env: stringMap(entry.mcp_env || entry.mcpEnv),
    };
  }
  return out;
}

/**
 * What to TELL the agent about those servers.
 *
 * The CLI connects to them itself and lists their tools under
 * `<server>__<tool>`, but the capabilities preamble is emphatic that the
 * space's own creatures are "what you can do here" — so without naming these
 * an agent reads that as an exhaustive list and never reaches for a tool the
 * project deliberately added. One line per server, no credentials.
 */
export function mcpServerSummaries(catalog) {
  return attachedMcpEntries(catalog).map(({ name, url, command, entry }) => ({
    name,
    label: String(entry.name || name),
    description: String(entry.description || "").slice(0, 300),
    host: (() => {
      if (url) {
        try {
          return new URL(url).host;
        } catch {
          return "";
        }
      }
      return command ? "local" : "";
    })(),
  }));
}
