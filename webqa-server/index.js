// 260819 Karina: webqa MCP server — Playwright screenshot + interaction for visual verification.
// Tools:
//   webqa_screenshot(url, {width,height,fullPage,waitUntil,waitMs}) -> {path,width,height}
//   webqa_interact(steps) -> per-step results (goto/click/fill/type/press/screenshot/resize/wait/eval/newpage/close)
// Screenshots land in os.tmpdir()/webqa so any agent can read them back.
//
// 260819 优化（跨调用保留页面状态）：
//   - browser/page 提升为进程级单例（每客户端会话独立进程，见 RedCode mcp/index.ts clients
//     按 Instance 隔离），interact 调用之间页面、DOM、localStorage 不再重置；
//   - 新增 press action（page.keyboard.press，支持 "Enter"/"Tab"/"Escape" 等键名），
//     补上 type 无法可靠模拟的特殊键；
//   - 新增 newpage（重置到空白页）/ close（关闭页面与浏览器）管理生命周期；
//   - 除 eval 外所有步骤结果附带当前 page.url()，便于跨调用定位页面。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT_DIR = path.join(os.tmpdir(), "webqa");
mkdirSync(OUT_DIR, { recursive: true });

const server = new McpServer({ name: "webqa", version: "1.1.0" });

// ---- 单例浏览器/页面：跨 interact 调用保留状态（per-session 进程，无并发共享） ----
let browser = null;
let page = null;

async function getPage() {
  if (!page) {
    if (!browser) browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  }
  return page;
}

async function closePage() {
  try {
    if (page) await page.close();
  } catch {}
  page = null;
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
}

// exit 事件里只能同步收尾：直接 kill chromium 子进程
process.on("exit", () => {
  try {
    if (browser && browser.process) browser.process()?.kill();
  } catch {}
});

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
    const b = await chromium.launch({ headless: true });
    try {
      const p = await b.newPage({
        viewport: { width: width ?? 1280, height: height ?? 800 },
      });
      await p.goto(url, { waitUntil: waitUntil ?? "networkidle", timeout: 30000 });
      if (waitMs) await p.waitForTimeout(waitMs);
      const out = path.join(OUT_DIR, `shot-${Date.now()}.png`);
      await p.screenshot({ path: out, fullPage: fullPage ?? false });
      return {
        content: [{ type: "text", text: JSON.stringify({ path: out, width: width ?? 1280, height: height ?? 800 }) }],
      };
    } finally {
      await b.close();
    }
  },
);

const stepSchema = z.object({
  action: z.enum(["goto", "click", "fill", "type", "press", "screenshot", "resize", "wait", "eval", "newpage", "close"]),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional().describe("press 时为键名（Enter/Tab/Escape/ArrowDown...），type/fill 时为文本"),
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
  { steps: z.array(stepSchema).min(1).describe("ordered action sequence; 页面跨调用保留，首次请先 goto 或 newpage") },
  async ({ steps }) => {
    const results = [];
    try {
      const first = steps[0];
      if (first.action !== "goto" && first.action !== "newpage") {
        if (!page) {
          return {
            content: [{ type: "text", text: JSON.stringify([{ action: first.action, error: "no page open — start with goto or newpage" }]) }],
          };
        }
      }
      for (const s of steps) {
        const p = await getPage();
        switch (s.action) {
          case "goto":
            await p.goto(s.url, { waitUntil: s.waitUntil ?? "networkidle", timeout: 30000 });
            results.push({ action: "goto", ok: true, url: p.url() });
            break;
          case "click":
            await p.click(s.selector, { timeout: 10000 });
            results.push({ action: "click", ok: true, url: p.url() });
            break;
          case "fill":
            await p.fill(s.selector, s.value);
            results.push({ action: "fill", ok: true, url: p.url() });
            break;
          case "type":
            await p.type(s.selector, s.value);
            results.push({ action: "type", ok: true, url: p.url() });
            break;
          case "press":
            await p.keyboard.press(s.value);
            results.push({ action: "press", ok: true, url: p.url() });
            break;
          case "screenshot": {
            const out = s.path ?? path.join(OUT_DIR, `shot-${Date.now()}.png`);
            await p.screenshot({ path: out, fullPage: s.fullPage ?? false });
            results.push({ action: "screenshot", path: out, url: p.url() });
            break;
          }
          case "resize":
            await p.setViewportSize({ width: s.width, height: s.height });
            results.push({ action: "resize", ok: true, url: p.url() });
            break;
          case "wait":
            await p.waitForTimeout(s.ms);
            results.push({ action: "wait", ok: true, url: p.url() });
            break;
          case "eval":
            results.push({ action: "eval", value: await p.evaluate(s.expr), url: p.url() });
            break;
          case "newpage":
            await closePage();
            await getPage();
            results.push({ action: "newpage", ok: true, url: "about:blank" });
            break;
          case "close":
            await closePage();
            results.push({ action: "close", ok: true, url: "about:blank" });
            break;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    } finally {
      // 页面/浏览器保持打开，供下一次调用复用
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
