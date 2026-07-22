#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// env overrides with defaults
const OLLAMA_BASE = process.env.VISION_BASE_URL || "http://localhost:11434"
const VISION_MODEL = process.env.VISION_MODEL || "minicpm-v4.6:q8_0"
const NUM_GPU_LAYERS = parseInt(process.env.VISION_NUM_GPU || "0", 10) || 0

const server = new McpServer({
  name: "vision-mcp-local",
  version: "1.0.0",
  description: "Local vision analysis via Ollama MiniCPM — analyzes images from file path or URL",
})

// ── analyze_image tool ──────────────────────────────────────────
server.tool(
  "analyze_image",
  "Analyze an image using the local vision model (MiniCPM via Ollama). Provide the file path or image URL.",
  {
    image: z.string().describe("Absolute file path or URL of the image to analyze"),
    prompt: z
      .string()
      .optional()
      .default("请详细描述这张图片的内容")
      .describe("Prompt for the vision model"),
  },
  async ({ image, prompt }) => {
    try {
      // resolve image source
      const isUrl = image.startsWith("http://") || image.startsWith("https://")
      let imageBuffer

      if (isUrl) {
        const resp = await fetch(image)
        if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`)
        imageBuffer = Buffer.from(await resp.arrayBuffer())
      } else {
        // expand ~ to home dir
        const resolvedPath = image.startsWith("~")
          ? path.join(os.homedir(), image.slice(1))
          : image
        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`File not found: ${resolvedPath}`)
        }
        imageBuffer = fs.readFileSync(resolvedPath)
      }

      const base64 = imageBuffer.toString("base64")
      const body = JSON.stringify({
        model: VISION_MODEL,
        prompt,
        images: [base64],
        stream: false,
        options: NUM_GPU_LAYERS > 0 ? { num_gpu_layers: NUM_GPU_LAYERS } : {},
      })

      const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })

      if (!resp.ok) {
        const errText = await resp.text()
        throw new Error(`Ollama API error (${resp.status}): ${errText}`)
      }

      const data = await resp.json()
      const result = (data.response || "").trim()

      return {
        content: [{ type: "text", text: result || "No response from vision model." }],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `Vision error: ${msg}` }], isError: true }
    }
  },
)

// ── start ──────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
