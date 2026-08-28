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

/** Catalog entries with kind mcp + an http(s) URL → grokConfig mcpServers map. */
export function httpMcpServersFromCatalog(catalog) {
  const out = {};
  const taken = new Set(["caspar"]);
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry !== "object") continue;
    if (String(entry.kind || "").toLowerCase() !== "mcp") continue;
    const url = String(entry.mcp_url || entry.mcpUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let name = slug(entry.name || entry.tool_id || "mcp");
    let n = 2;
    while (taken.has(name)) name = `${slug(entry.name || "mcp")}_${n++}`;
    taken.add(name);
    const headers = {};
    const extra = entry.mcp_headers || entry.mcpHeaders;
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (k && v != null && String(v).trim()) headers[String(k)] = String(v);
      }
    }
    const auth = bearerHeader(entry.mcp_token || entry.mcpToken);
    if (auth && !headers.Authorization && !headers.authorization) headers.Authorization = auth;
    out[name] = {
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }
  return out;
}
