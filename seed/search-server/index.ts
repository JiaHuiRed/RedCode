// 260604 Red Minimal web-search MCP server — only exposes web_search tool
// DuckDuckGo HTML + Yahoo fallback. Uses PowerShell for HTTP to respect system proxy
// (Node's / curl.exe bypass Windows proxy and can't reach external hosts on this machine).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 260604 Red Use PowerShell for HTTP — respects system proxy when enabled.
// 260605 Red Auto-detect proxy from registry; when ProxyEnable=1, pass -Proxy to Invoke-WebRequest.
// 260726 Red Also check HTTP_PROXY env var (set in MCP config) as fallback.
function getSystemProxy(): string | null {
  // Process env takes priority — MCP config may set HTTP_PROXY even when registry is disabled
  if (process.env.HTTP_PROXY) return process.env.HTTP_PROXY;
  try {
    const out = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable`,
      { timeout: 3000, encoding: "utf-8", windowsHide: true },
    );
    if (!out.includes("0x1")) return null; // ProxyEnable != 1
    const srv = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer`,
      { timeout: 3000, encoding: "utf-8", windowsHide: true },
    );
    // ProxyServer may be "http://127.0.0.1:7890" or "http=...;https=..."
    const m = srv.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    const raw = m[1].trim();
    // If it contains semicolons, pick the first http(s) one
    if (raw.includes(";")) {
      const part = raw.split(";").find(s => s.startsWith("http")) ?? raw.split(";")[0];
      return part?.trim() ?? null;
    }
    return raw || null;
  } catch {
    return null;
  }
}

const CACHED_PROXY = getSystemProxy()?.replace(/^(?!https?:\/\/)/, "http://"); // detect once at startup, ensure http:// prefix

function fetchHtml(url: string): string {
  const ua = CHROME_UA.replace(/'/g, "''");
  const proxyArg = CACHED_PROXY ? ` -Proxy '${CACHED_PROXY.replace(/'/g, "''")}'` : "";
  const cmd = `powershell.exe -NoProfile -NonInteractive -Command "try { (Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -UserAgent '${ua}' -UseBasicParsing${proxyArg} -TimeoutSec 15 -ErrorAction Stop).Content } catch { Write-Error $$_; exit 1 }"`;
  try {
    return execSync(cmd, { timeout: 25_000, encoding: "utf-8", windowsHide: true });
  } catch (e: any) {
    throw new Error(e.stderr ? String(e.stderr).trim() : String(e.message));
  }
}

// ── DuckDuckGo HTML ──────────────────────────────────────────────────

async function searchDdg(query: string): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  const blocks = html.split('<div class="results_links results_links_deep');
  for (const block of blocks) {
    const a = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const s = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeDdgUrl(a[1]);
    const title = a[2].replace(/<[^>]*>/g, "").trim();
    const snippet = s ? s[1].replace(/<[^>]*>/g, "").trim() : "";
    if (title && url && !results.some((r) => r.url === url))
      results.push({ title, url, snippet, engine: "duckduckgo" });
  }
  return results;
}

function decodeDdgUrl(raw: string): string {
  // DuckDuckGo redirect: //duckduckgo.com/l/?uddg=<base64-url>&rut=...
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  // Fallback: maybe it's a direct URL with protocol prefix
  if (raw.startsWith("http")) return raw;
  return raw.replace(/^\/\//, "https://");
}

// ── Yahoo (simple fallback) ──────────────────────────────────────────

async function searchYahoo(query: string): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  // Yahoo wraps each result: <div class="dd algo fst"> or <div class="dd algo">
  const blocks = html.split(/<div class="dd algo[^"]*"/);
  for (const block of blocks) {
    const h3a = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const s = block.match(/<p[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (!h3a) continue;
    const url = decodeYahooUrl(h3a[1]);
    const title = h3a[2].replace(/<[^>]*>/g, "").trim();
    const snippet = s ? s[1].replace(/<[^>]*>/g, "").trim() : "";
    if (title && url && !isYahooInternal(url) && !results.some((r) => r.url === url))
      results.push({ title, url, snippet, engine: "yahoo" });
  }
  return results;
}

function decodeYahooUrl(raw: string): string {
  // Yahoo redirect uses path segments: /RV=.../RU=<encoded-url>/RK=...
  const m = raw.match(/\/RU=([^\/]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* ignore */ }
  }
  // Also try query-param format
  const m2 = raw.match(/[?&]RU=([^&]+)/);
  if (m2) {
    try { return decodeURIComponent(m2[1]); } catch { /* ignore */ }
  }
  // Direct URL (not a Yahoo internal page)
  if (raw.startsWith("http") && !raw.includes("r.search.yahoo.com") && !raw.includes("scout.yahoo.com")) return raw;
  return "";
}

const YAHOO_INTERNAL = /\.(yahoo|yimg)\.com/;

function isYahooInternal(url: string): boolean { return YAHOO_INTERNAL.test(url); }

// ── Google (final fallback) ────────────────────────────────────────

async function searchGoogle(query: string): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  // Google wraps results: <div class="g"> ... <a href="/url?q=..."> ... <h3>title</h3>
  const blocks = html.split(/<div class="g">/);
  for (const block of blocks) {
    const a = block.match(/<a[^>]*href="\/url\?q=([^&"]+)/);
    const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const snippet = block.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    if (!a || !h3) continue;
    const url = decodeURIComponent(a[1]);
    const title = h3[1].replace(/<[^>]*>/g, "").trim();
    const snip = snippet ? snippet[1].replace(/<[^>]*>/g, "").trim() : "";
    if (title && url && !url.includes("google.com") && !results.some((r) => r.url === url))
      results.push({ title, url, snippet: snip, engine: "google" });
  }
  return results;
}

// ── MCP Server ──────────────────────────────────────────────────────

const server = new Server(
  { name: "web-search", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "web_search",
      description: "Search the web via DuckDuckGo + Yahoo + Google fallback. No API key needed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          count: { type: "number", description: "Results to return (1-50, default 10)" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "web_search")
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);

  const query = String(request.params.arguments?.query ?? "");
  const count = Math.min(Math.max(Number(request.params.arguments?.count) || 10, 1), 50);
  if (!query.trim()) throw new McpError(ErrorCode.InvalidParams, "query is required");

  let results: SearchResult[] = [];
  try { results = await searchDdg(query); } catch {
    try { results = await searchYahoo(query); } catch {
      try { results = await searchGoogle(query); } catch (e) {
        throw new McpError(ErrorCode.InternalError, `Search failed: ${(e as Error).message}`);
      }
    }
  }
  if (results.length < 5) {
    try {
      for (const r of await searchYahoo(query))
        if (!results.some((x) => x.url === r.url)) results.push(r);
    } catch { /* best effort */ }
  }
  if (results.length < 5) {
    try {
      for (const r of await searchGoogle(query))
        if (!results.some((x) => x.url === r.url)) results.push(r);
    } catch { /* best effort */ }
  }

  results = results.slice(0, count);

  return {
    content: [
      {
        type: "text",
        text: results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
          : "No results found.",
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
