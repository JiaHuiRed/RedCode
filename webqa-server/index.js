// 260807 Karina: webqa MCP server — Playwright screenshot + interaction for visual verification.
// Tools:
//   webqa_screenshot(url, {width,height,fullPage,waitUntil,waitMs}) -> {path,width,height}
//   webqa_interact(steps) -> per-step results (goto/click/fill/type/screenshot/resize/wait/eval)
// Screenshots land in os.tmpdir()/webqa so any agent can read them back.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT_DIR = path.join(os.tmpdir(), "webqa");
mkdirSync(OUT_DIR, { recursive: true });

const server = new McpServer({ name: "webqa", version: "1.0.0" });

server.tool(
  "webqa_screenshot",
  {
    url: z.string().describe("page URL (http/https/file)"),
    width: z.number().int().positive().optional().describe("viewport width, default 1280"),
    height: z.number().int().positive().optional().describe("viewport height, default 800"),
    fullPage: z.boolean().optional().describe("capture full scrollable page"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    waitMs: z.number().int().positive().optional().describe("extra settle time after load"),
  },
  async ({ url, width, height, fullPage, waitUntil, waitMs }) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: width ?? 1280, height: height ?? 800 },
      });
      await page.goto(url, { waitUntil: waitUntil ?? "networkidle", timeout: 30000 });
      if (waitMs) await page.waitForTimeout(waitMs);
      const out = path.join(OUT_DIR, `shot-${Date.now()}.png`);
      await page.screenshot({ path: out, fullPage: fullPage ?? false });
      return {
        content: [{ type: "text", text: JSON.stringify({ path: out, width: width ?? 1280, height: height ?? 800 }) }],
      };
    } finally {
      await browser.close();
    }
  },
);

const stepSchema = z.object({
  action: z.enum(["goto", "click", "fill", "type", "screenshot", "resize", "wait", "eval"]),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  path: z.string().optional(),
  fullPage: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  ms: z.number().int().positive().optional(),
  expr: z.string().optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
});

server.tool(
  "webqa_interact",
  { steps: z.array(stepSchema).min(1).describe("ordered action sequence") },
  async ({ steps }) => {
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      for (const s of steps) {
        switch (s.action) {
          case "goto":
            await page.goto(s.url, { waitUntil: s.waitUntil ?? "networkidle", timeout: 30000 });
            results.push({ action: "goto", ok: true });
            break;
          case "click":
            await page.click(s.selector, { timeout: 10000 });
            results.push({ action: "click", ok: true });
            break;
          case "fill":
            await page.fill(s.selector, s.value);
            results.push({ action: "fill", ok: true });
            break;
          case "type":
            await page.type(s.selector, s.value);
            results.push({ action: "type", ok: true });
            break;
          case "screenshot": {
            const out = s.path ?? path.join(OUT_DIR, `shot-${Date.now()}.png`);
            await page.screenshot({ path: out, fullPage: s.fullPage ?? false });
            results.push({ action: "screenshot", path: out });
            break;
          }
          case "resize":
            await page.setViewportSize({ width: s.width, height: s.height });
            results.push({ action: "resize", ok: true });
            break;
          case "wait":
            await page.waitForTimeout(s.ms);
            results.push({ action: "wait", ok: true });
            break;
          case "eval":
            results.push({ action: "eval", value: await page.evaluate(s.expr) });
            break;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    } finally {
      await browser.close();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
