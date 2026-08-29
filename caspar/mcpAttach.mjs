/**
 * HTTP MCP servers attached to a space (kind: mcp), handed to Grok as native
 * `[mcp_servers.*]` URL entries so the CLI speaks Streamable HTTP itself.
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

/** Every attached MCP listing, in catalog order, with its config-file name. */
function attachedMcpEntries(catalog) {
  const out = [];
  const taken = new Set(["caspar"]);
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry !== "object") continue;
    if (String(entry.kind || "").toLowerCase() !== "mcp") continue;
    const url = String(entry.mcp_url || entry.mcpUrl || "").trim();
    // A listing whose connection did not reach us (an unhydrated attach, a
    // redacted read) is not something the CLI can dial — skip it rather than
    // writing a server entry that fails at startup.
    if (!/^https?:\/\//i.test(url)) continue;
    const base = slug(entry.name || entry.tool_id || "mcp");
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    taken.add(name);
    out.push({ name, url, entry });
  }
  return out;
}

/** Catalog entries with kind mcp + an http(s) URL → grokConfig mcpServers map. */
export function httpMcpServersFromCatalog(catalog) {
  const out = {};
  for (const { name, url, entry } of attachedMcpEntries(catalog)) {
    const headers = {};
    const extra = entry.mcp_headers || entry.mcpHeaders;
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (k && v != null && String(v).trim()) headers[String(k)] = String(v);
      }
    }
    const auth = bearerHeader(entry.mcp_token || entry.mcpToken);
    if (auth && !headers.Authorization && !headers.authorization) headers.Authorization = auth;
    const transport = String(entry.mcp_transport || entry.mcpTransport || "").trim().toLowerCase();
    out[name] = {
      url,
      ...(transport === "sse" ? { type: "sse" } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
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
  return attachedMcpEntries(catalog).map(({ name, url, entry }) => ({
    name,
    label: String(entry.name || name),
    description: String(entry.description || "").slice(0, 300),
    host: (() => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })(),
  }));
}
