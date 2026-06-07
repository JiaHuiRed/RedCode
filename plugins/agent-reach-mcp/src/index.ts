#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { execSync } from "child_process"

// 260607 Red Agent Reach MCP — unified search: GitHub, Bilibili, Douyin

function run(cmd: string, timeout = 15000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout, windowsHide: true }).trim()
  } catch (e: any) {
    if (e.stderr) throw new Error(e.stderr.trim().split("\n").pop() || e.message)
    throw e
  }
}

function hasTool(name: string): boolean {
  try {
    execSync(`where.exe ${name}`, { encoding: "utf-8", windowsHide: true })
    return true
  } catch {
    return false
  }
}

const server = new McpServer({
  name: "agent-reach-mcp",
  version: "0.1.0",
  description: "Unified search — GitHub, Bilibili, Douyin",
})

// ── doctor ───────────────────────────────────────────────────────
server.tool(
  "doctor",
  "Check which search tools are available and authenticated.",
  async () => {
    const tools = [
      { name: "GitHub (gh)", ok: hasTool("gh") },
      { name: "Bilibili (yt-dlp+API)", ok: hasTool("yt-dlp") },
      { name: "Douyin (yt-dlp)", ok: hasTool("yt-dlp") },
    ]
    const lines = tools.map(t => `${t.ok ? "✅" : "❌"} ${t.name}`)
    return { content: [{ type: "text" as const, text: lines.join("\n") }] }
  },
)

// ── GitHub ───────────────────────────────────────────────────────
server.tool(
  "search_github",
  "Search GitHub (repos, issues, or PRs).",
  {
    query: z.string().describe("Search query"),
    type: z.enum(["repos", "issues", "prs"]).optional().default("repos").describe("Search type: repos (repositories), issues, or prs"),
  },
  async ({ query, type, limit }) => {
    if (!hasTool("gh")) throw new Error("GitHub CLI (gh) not found. Install: https://cli.github.com/")
    const fields = type === "repos" ? "fullName,description,url,stargazersCount,language" : "title,url,state,repository,number"
    const out = run(`gh search ${type} "${query.replace(/"/g, '\\"')}" --limit ${limit} --json=${fields}`)
    const items = JSON.parse(out) as Array<Record<string, any>>
    if (items.length === 0) return { content: [{ type: "text" as const, text: "No results found." }] }
    const lines = items.map((i, idx) => {
      if (type === "repos") {
        return `${idx + 1}. ${i.fullName} ⭐${i.stargazersCount}\n   ${i.description || ""}\n   ${i.url}`
      }
      return `${idx + 1}. [${i.repository?.nameWithOwner || i.repository}] ${i.title} (${i.state})\n   ${i.url}`
    })
    return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
  },
)

server.tool(
  "get_github_repo",
  "Get details about a GitHub repository.",
  {
    repo: z.string().describe("Repository name (e.g. 'owner/repo')"),
  },
  async ({ repo }) => {
    if (!hasTool("gh")) throw new Error("GitHub CLI (gh) not found.")
    const out = run(`gh repo view "${repo}" --json=name,owner,description,url,stargazerCount,forkCount,primaryLanguage,latestRelease,updatedAt`)
    return { content: [{ type: "text" as const, text: out }] }
  },
)



// ── Bilibili ─────────────────────────────────────────────────────
server.tool(
  "search_bilibili",
  "Search Bilibili videos.",
  {
    query: z.string().describe("Search keywords"),
    limit: z.number().min(1).max(30).optional().default(10),
  },
  async ({ query, limit }) => {
    const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.bilibili.com",
      },
    })
    if (!res.ok) throw new Error(`Bilibili API error: ${res.status}`)
    const data = (await res.json()) as any
    const videos = data?.data?.result?.find((r: any) => r.result_type === "video")?.result?.slice(0, limit) || []
    if (videos.length === 0) return { content: [{ type: "text" as const, text: "No results found." }] }
    const lines = videos.map((v: any, i: number) =>
      `${i + 1}. ${v.title?.replace(/<[^>]+>/g, "")}\n   https://www.bilibili.com/video/av${v.aid}\n   👁 ${v.play} 👍 ${v.like}`
    )
    return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
  },
)

server.tool(
  "get_bilibili_video",
  "Get Bilibili video info and subtitles.",
  {
    url: z.string().describe("Bilibili video URL (e.g. https://www.bilibili.com/video/BVxxx)"),
    getSubtitle: z.boolean().optional().default(false).describe("Extract subtitle/CC text"),
  },
  async ({ url, getSubtitle }) => {
    if (!hasTool("yt-dlp")) throw new Error("yt-dlp not found. Install: uv tool install yt-dlp")
    const info = run(`yt-dlp --dump-json --no-download "${url}"`, 30000)
    const parsed = JSON.parse(info)
    const lines = [
      `**${parsed.title}**`,
      `Uploader: ${parsed.uploader || parsed.channel || "?"}`,
      `Duration: ${Math.floor((parsed.duration || 0) / 60)}:${String((parsed.duration || 0) % 60).padStart(2, "0")}`,
      `Plays: ${parsed.view_count ?? "?"}`,
      parsed.description ? `\nDescription:\n${parsed.description.slice(0, 1000)}` : "",
    ]
    if (getSubtitle) {
      try {
        const sub = run(`yt-dlp --write-auto-sub --skip-download --sub-lang zh-Hans,zh-CN,zh --sub-format vtt --output "%(id)s" "${url}"`, 30000)
        lines.push(`\nSubtitles extracted.\nNote: Use yt-dlp subtitle files directly for full transcript.`)
      } catch {
        lines.push(`\nNo subtitles available for this video.`)
      }
    }
    return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
  },
)

// ── Douyin ───────────────────────────────────────────────────────
server.tool(
  "get_douyin_video",
  "Get Douyin video info (title, author, stats) from a share link.",
  {
    url: z.string().describe("Douyin share URL (e.g. https://v.douyin.com/xxx/)"),
  },
  async ({ url }) => {
    if (!hasTool("yt-dlp")) throw new Error("yt-dlp not found. Install: uv tool install yt-dlp")
    const info = run(`yt-dlp --dump-json --no-download "${url}"`, 30000)
    const parsed = JSON.parse(info)
    const lines = [
      `**${parsed.title || parsed.description || "?"}**`,
      `Uploader: ${parsed.uploader || parsed.channel || "?"}`,
      `Duration: ${Math.floor((parsed.duration || 0) / 60)}:${String((parsed.duration || 0) % 60).padStart(2, "0")}`,
      `Plays: ${parsed.view_count ?? "?"}`,
      `Likes: ${parsed.like_count ?? "?"}`,
      parsed.description ? `\n${parsed.description.slice(0, 500)}` : "",
    ]
    return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
  },
)

// ── start ────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
