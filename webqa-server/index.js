// 260819 Karina: webqa MCP server — Playwright screenshot + interaction for visual verification.
// Tools:
//   webqa_screenshot(url, {width,height,fullPage,waitUntil,waitMs}) -> {path,width,height}
//   webqa_interact(steps) -> per-step results (goto/click/clickAt/hover/scroll/fill/type/press/
//                            screenshot/resize/wait/observe/waitFor/eval/tab/newpage/close)
// Screenshots land in os.tmpdir()/webqa so any agent can read them back.
// 260824 优化（借鉴 ego-lite 的 snapshotText 设计）：
//   - 新增 observe action：page.locator("body").ariaSnapshot({ mode: "ai" }) 输出带
//     [ref=eN] 注解的 aria 语义树；后续 click/fill/type 直接传 "aria-ref=eN"
//     作为 selector（Playwright 原生选择器引擎解析，无需自建 refMap）。
//     ref 只在页面结构稳定期间可靠，大幅 DOM 变化后请重新 observe；
//   - 新增 waitFor action：mode=selector/loadState/url，替代死等 wait(ms)；
//   - 截图文件名加 pid+序号，避免同毫秒覆盖。
//
// 260819 优化（跨调用保留页面状态）：
//   - browser/page 提升为进程级单例（每客户端会话独立进程，见 RedCode mcp/index.ts clients
//     按 Instance 隔离），interact 调用之间页面、DOM、localStorage 不再重置；
//   - 新增 press action（page.keyboard.press，支持 "Enter"/"Tab"/"Escape" 等键名），
//     补上 type 无法可靠模拟的特殊键；
//   - 新增 newpage（重置到空白页）/ close（关闭页面与浏览器）管理生命周期；
//   - 除 eval 外所有步骤结果附带当前 page.url()，便于跨调用定位页面。
//
// 260908 Red v1.2.0（对照 ZCode browser-use 实战缺口补齐）：
//   - clickAt：坐标点击（CSS 像素，视口左上为原点）。canvas / 自绘控件在 aria 快照里
//     不可见（实测 xterm.js 终端整页都是画出来的），observe 找不到目标时这是唯一兜底；
//   - scroll：滚轮，可先 move 到指定点再滚（hover 触发的懒加载/工具提示也能吃到）；
//   - hover：悬停（导航菜单、工具提示）；
//   - tab：多标签 list/new/switch/close，弹窗/新标签流不再挤死在单页里；
//   - screenshot 支持 selector 元素级特写，结果附带视口尺寸供坐标换算；
//   - observe 支持 selector 限定子树（弹窗/抽屉不必全页快照），结果带 title；
//   - 单步容错：一步失败返回已执行结果 + 该步 error 并中止，不再整批蒸发；
//   - describe 全面改写为「观察优先」纪律：observe（纯文本，便宜）→ aria-ref 定位 →
//     waitFor / 再 observe 验证效果 → 只有需要视觉判断时才 screenshot。
//
// 261024 Red v1.4.0：新增 drag（move→down→move(steps)→up 真实鼠标拖拽）。合成
//   PointerEvent 不建立活动指针，setPointerCapture 组件（如 ResizeHandle）会抛
//   NotFoundError 且测不出真实拖拽；drag 走 CDP 真输入管道，指针捕获语义全真。
//   起终点坐标同 clickAt 口径：视口内 CSS 像素，从截图上量。
//
// 261019 Red v1.3.0（公司日常高频使用下的内存/提效优化，工具名与参数保持兼容）：
//   - playwright 延迟加载：顶层 import 实测 50→113MiB RSS（+63MiB），没在用浏览器的
//     会话不该付这份常驻；首次调用再解析，模块缺失仍会在调用点报原错误；
//   - screenshot 复用已有浏览器（独立 context 隔离，不污染交互页面）；浏览器原本没开时
//     用完立即回收，保持"只截图不常驻"的旧行为；
//   - 交互调用串行化：MCP 客户端并发投递时共享 page 的 goto/click 不再交错；
//   - tab new 上限 10 个，超出关闭最旧的非当前页，避免长时间会话页面堆积；
//   - observe 默认 120000 字符上限（maxChars 可调），防整页快照失控；
//   - 启动时清理 7 天前的截图与 Playwright 残留 profile（实测 386 张 / 36MiB、93 个目录）；
//   - 可选 WEBQA_IDLE_CLOSE_MS：空闲自动关浏览器。默认关——Playwright 用临时 profile，
//     关掉会丢登录态；内网系统重新登录成本高，所以保持常驻是默认行为。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// 261019 Red 延迟加载：模块解析放在首次真实调用，省掉未使用时的 63MiB 常驻。
let chromiumPromise = null
const getChromium = () => {
  chromiumPromise ??= import("playwright").then((m) => m.chromium)
  return chromiumPromise
}

const OUT_DIR = path.join(os.tmpdir(), "webqa")
mkdirSync(OUT_DIR, { recursive: true })

// 261019 Red 清理历史残留：异常退出会留下截图与 Playwright 临时 profile。
// 只清 7 天前的，避免碰到另一个实例正在使用的 profile。
const STALE_MS = 7 * 24 * 60 * 60 * 1000
function cleanupStale() {
  const now = Date.now()
  const stale = (p) => {
    try {
      return now - statSync(p).mtimeMs > STALE_MS
    } catch {
      // 文件同时在别处被删/占用：跳过这一条即可，清理不是启动的前置条件
      return false
    }
  }
  try {
    for (const name of readdirSync(OUT_DIR)) {
      if (!/^shot-.*\.png$/.test(name)) continue
      const p = path.join(OUT_DIR, name)
      if (stale(p)) unlinkSync(p)
    }
  } catch {}
  try {
    for (const name of readdirSync(os.tmpdir())) {
      if (!name.startsWith("playwright_chromiumdev_profile-")) continue
      const p = path.join(os.tmpdir(), name)
      if (stale(p)) rmSync(p, { recursive: true, force: true })
    }
  } catch {} // temp 目录不可读时跳过清理；启动不因清扫失败而失败
}
cleanupStale()

// 截图序号：与 pid 组合保证并发/同毫秒不撞名（借鉴 ego-browser screenshot 命名）
let shotSeq = 0
const nextShotPath = () => path.join(OUT_DIR, `shot-${process.pid}-${++shotSeq}.png`)

const server = new McpServer({ name: "webqa", version: "1.4.0" })

// ---- 单例浏览器/页面：跨 interact 调用保留状态（per-session 进程，无并发共享） ----
let browser = null
let context = null
let page = null

async function getBrowser() {
  if (!browser) browser = await (await getChromium()).launch({ headless: true })
  return browser
}

async function getPage() {
  if (!page) {
    const b = await getBrowser()
    // 260908 Red 必须显式 context：browser.newPage() 造的隐式 context 禁止再 newPage()，
    // tab new 会直接抛 "Please use browser.newContext()"。显式 context 还让多标签
    // 共享 cookie/localStorage，与真实浏览器语义一致。
    context ??= await b.newContext({ viewport: { width: 1280, height: 800 } })
    page = context.pages()[0] ?? (await context.newPage())
  }
  return page
}

async function closePage() {
  clearIdle()
  try {
    if (page) await page.close()
  } catch {} // 关闭链 best-effort：前一步失败不能挡住后面的 browser 回收
  page = null
  try {
    if (context) await context.close()
  } catch {}
  context = null
  try {
    if (browser) await browser.close()
  } catch {}
  browser = null
}

// 261019 Red 空闲自动关闭（默认关）。Playwright 每次 launch 都用临时 profile，
// 关浏览器 = 丢登录态；内网系统重新登录成本高，所以默认常驻。
// 需要省内存时设 WEBQA_IDLE_CLOSE_MS（例如 900000 = 15 分钟）。
const IDLE_CLOSE_MS = Number(process.env.WEBQA_IDLE_CLOSE_MS ?? 0)
let idleTimer = null
function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}
function touchIdle() {
  if (!IDLE_CLOSE_MS || !browser) return
  clearIdle()
  idleTimer = setTimeout(() => void closePage(), IDLE_CLOSE_MS)
}

// 261019 Red 串行化：MCP 客户端可能并发投递工具调用，而 interact 共享单例 page，
// 交错执行会让 goto/click 落到彼此的页面。screenshot 共用同一 browser，一并排队。
let queue = Promise.resolve()
function serialize(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => {},
    () => {},
  )
  return run
}

// exit 事件里只能同步收尾：直接 kill chromium 子进程
process.on("exit", () => {
  try {
    if (browser && browser.process) browser.process()?.kill()
  } catch {}
}) // 进程已在退出，这里失败没有可恢复的动作

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
  async ({ url, width, height, fullPage, waitUntil, waitMs }) =>
    serialize(async () => {
      // 261019 Red 复用已有浏览器，用独立 context 隔离截图与交互页面；
      // 浏览器原本没开时用完立即回收，避免"只截一次图"把 Chromium 留成常驻。
      const reused = browser !== null
      const b = await getBrowser()
      const ctx = await b.newContext({ viewport: { width: width ?? 1280, height: height ?? 800 } })
      try {
        const p = await ctx.newPage()
        await p.goto(url, { waitUntil: waitUntil ?? "networkidle", timeout: 30000 })
        if (waitMs) await p.waitForTimeout(waitMs)
        const out = nextShotPath()
        await p.screenshot({ path: out, fullPage: fullPage ?? false })
        return {
          content: [{ type: "text", text: JSON.stringify({ path: out, width: width ?? 1280, height: height ?? 800 }) }],
        }
      } finally {
        await ctx.close()
        if (!reused && !page) await closePage()
        touchIdle()
      }
    }),
)

const stepSchema = z.object({
  action: z.enum([
    "goto",
    "click",
    "clickAt",
    "hover",
    "scroll",
    "fill",
    "type",
    "press",
    "drag",
    "screenshot",
    "resize",
    "wait",
    "observe",
    "waitFor",
    "eval",
    "tab",
    "newpage",
    "close",
  ]),
  url: z.string().optional(),
  selector: z
    .string()
    .optional()
    .describe("click/fill/type/hover/observe/screenshot 用 CSS 或 aria-ref=sXeY（取自最近一次 observe）"),
  value: z
    .string()
    .optional()
    .describe("press 时为键名（Enter/Tab/Escape/ArrowDown...），type/fill 时为文本，waitFor loadState 时为状态名"),
  path: z.string().optional(),
  fullPage: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  x: z
    .number()
    .optional()
    .describe("clickAt/scroll/drag 的视口内 CSS 像素横坐标（截图左上角为原点，1 截图像素 = 1 CSS 像素）"),
  y: z.number().optional().describe("clickAt/scroll/drag 的视口内 CSS 像素纵坐标"),
  x2: z.number().optional().describe("drag 的终点横坐标"),
  y2: z.number().optional().describe("drag 的终点纵坐标"),
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("drag 的 move 插值步数（默认 12），模拟真实拖拽速度"),
  deltaX: z.number().optional().describe("scroll 横向滚轮量，正=右"),
  deltaY: z.number().optional().describe("scroll 纵向滚轮量，正=下"),
  button: z.enum(["left", "right", "middle"]).optional().describe("clickAt 的鼠标键，默认 left"),
  index: z.number().int().nonnegative().optional().describe("tab switch/close 的目标页下标（tab list 里给的）"),
  ms: z.number().int().positive().optional().describe("waitFor 的超时上限；wait 时为等待时长"),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("observe 输出上限字符（默认 120000）；超出截断并提示用 selector 缩小范围"),
  expr: z.string().optional(),
  mode: z
    .enum(["selector", "loadState", "url"])
    .optional()
    .describe("waitFor 模式：selector 需 selector 字段，loadState 需 value（networkidle 等），url 需 url（支持 glob）"),
  tabMode: z.enum(["list", "new", "switch", "close"]).optional().describe("tab 动作的模式"),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
})

// 261019 Red 标签上限：长时间会话里弹窗/新标签会累积，超过就关最旧的非当前页。
const MAX_TABS = 10

server.tool(
  "webqa_interact",
  {
    steps: z
      .array(stepSchema)
      .min(1)
      .describe(
        "有序步骤，页面跨调用保留，首次请先 goto 或 newpage。纪律：先 observe 拿文本快照（便宜、带 [ref=sXeY]），" +
          "click/fill 用 aria-ref=sXeY 定位；动作后用 waitFor 或再 observe 验证效果，别只看 URL；" +
          "只有需要视觉判断（布局/样式/图表）才 screenshot。canvas、终端等自绘控件在 aria 里不可见，" +
          "用 clickAt 坐标点（坐标从截图上量，1 截图像素=1 CSS 像素）。大 DOM 变更后 ref 失效，重新 observe",
      ),
  },
  async ({ steps }) => serialize(() => runSteps(steps)),
)

async function runSteps(steps) {
  const results = []
  try {
    const first = steps[0]
    if (first.action !== "goto" && first.action !== "newpage") {
      if (!page) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([{ action: first.action, error: "no page open — start with goto or newpage" }]),
            },
          ],
        }
      }
    }
    for (const s of steps) {
      const p = await getPage()
      try {
        switch (s.action) {
          case "goto":
            await p.goto(s.url, { waitUntil: s.waitUntil ?? "networkidle", timeout: 30000 })
            results.push({ action: "goto", ok: true, url: p.url() })
            break
          case "click":
            await p.click(s.selector, { timeout: 10000 })
            results.push({ action: "click", ok: true, url: p.url() })
            break
          case "clickAt":
            // 260908 Red aria 快照看不见自绘控件（canvas/终端/图表），坐标是唯一落点
            await p.mouse.click(s.x, s.y, { button: s.button ?? "left" })
            results.push({ action: "clickAt", x: s.x, y: s.y, ok: true, url: p.url() })
            break
          case "hover":
            await p.hover(s.selector, { timeout: s.ms ?? 10000 })
            results.push({ action: "hover", ok: true, url: p.url() })
            break
          case "scroll": {
            if (s.x !== undefined || s.y !== undefined) await p.mouse.move(s.x ?? 640, s.y ?? 400)
            await p.mouse.wheel(s.deltaX ?? 0, s.deltaY ?? 0)
            // 260908 Red wheel 派发不等滚动完成，紧跟着的 eval/observe 会读到旧 scrollY——
            // 留一拍合成器沉降，避免模型每次都在 scroll 后面补一个 wait
            await p.waitForTimeout(50)
            results.push({ action: "scroll", deltaX: s.deltaX ?? 0, deltaY: s.deltaY ?? 0, ok: true, url: p.url() })
            break
          }
          case "fill":
            await p.fill(s.selector, s.value)
            results.push({ action: "fill", ok: true, url: p.url() })
            break
          case "type":
            await p.type(s.selector, s.value)
            results.push({ action: "type", ok: true, url: p.url() })
            break
          case "press":
            await p.keyboard.press(s.value)
            results.push({ action: "press", ok: true, url: p.url() })
            break
          case "drag": {
            // 261024 Red RC-A04 真实输入管道：合成 PointerEvent 不建立活动指针，
            // ResizeHandle 这类 setPointerCapture 组件会抛 NotFoundError，测的也是假链路。
            // mouse.move→down→move(steps)→up 走 CDP 真输入，capture/hover/焦点语义全真。
            if (s.x === undefined || s.y === undefined || s.x2 === undefined || s.y2 === undefined)
              throw new Error("drag 需要 x/y（起点）与 x2/y2（终点）")
            await p.mouse.move(s.x, s.y)
            await p.mouse.down()
            await p.mouse.move(s.x2, s.y2, { steps: s.steps ?? 12 })
            await p.mouse.up()
            results.push({ action: "drag", x: s.x, y: s.y, x2: s.x2, y2: s.y2, ok: true, url: p.url() })
            break
          }
          case "screenshot": {
            const out = s.path ?? nextShotPath()
            if (s.selector) {
              // 260908 Red 元素级特写：看清单个组件不必全页截图
              await p.locator(s.selector).first().screenshot({ path: out, timeout: 10000 })
            } else {
              await p.screenshot({ path: out, fullPage: s.fullPage ?? false })
            }
            results.push({ action: "screenshot", path: out, viewport: p.viewportSize(), url: p.url() })
            break
          }
          case "resize":
            await p.setViewportSize({ width: s.width, height: s.height })
            results.push({ action: "resize", ok: true, url: p.url() })
            break
          case "wait":
            await p.waitForTimeout(s.ms)
            results.push({ action: "wait", ok: true, url: p.url() })
            break
          case "observe": {
            // 261019 Red 整页 aria 快照可能上万 token；默认上限只防失控，正常页面不触发。
            const snapshot = await p.locator(s.selector ?? "body").ariaSnapshot({ mode: "ai" })
            const limit = s.maxChars ?? 120_000
            results.push({
              action: "observe",
              title: await p.title(),
              snapshot:
                snapshot.length > limit
                  ? `${snapshot.slice(0, limit)}\n[truncated ${snapshot.length - limit} chars — use selector to narrow]`
                  : snapshot,
              url: p.url(),
            })
            break
          }
          case "waitFor": {
            // selector → 元素出现；loadState → 页面状态；url → 导航目标（Playwright glob 匹配）
            const mode = s.mode ?? "selector"
            if (mode === "url") {
              await p.waitForURL(s.url, { timeout: s.ms ?? 30000 })
            } else if (mode === "loadState") {
              await p.waitForLoadState(s.value ?? "networkidle", { timeout: s.ms ?? 30000 })
            } else {
              await p.waitForSelector(s.selector, { timeout: s.ms ?? 10000 })
            }
            results.push({ action: "waitFor", mode, ok: true, url: p.url() })
            break
          }
          case "eval":
            results.push({ action: "eval", value: await p.evaluate(s.expr), url: p.url() })
            break
          case "tab": {
            // 260908 Red 多标签：弹窗/新标签流用 switch 切过去再操作，list 给出全部下标
            const ctx = p.context()
            const mode = s.tabMode ?? "list"
            if (mode === "list") {
              results.push({
                action: "tab",
                mode,
                pages: ctx.pages().map((pg, i) => ({ index: i, url: pg.url() })),
                url: p.url(),
              })
            } else if (mode === "new") {
              page = await ctx.newPage()
              // 261019 Red 上限保护：长时间会话里弹窗/新标签会累积，超限关最旧的非当前页。
              const pages = ctx.pages()
              if (pages.length > MAX_TABS) {
                const oldest = pages.find((pg) => pg !== page)
                if (oldest) await oldest.close()
              }
              results.push({ action: "tab", mode, index: ctx.pages().length - 1, ok: true, url: page.url() })
            } else if (mode === "switch") {
              const pages = ctx.pages()
              const target =
                (s.index !== undefined ? pages[s.index] : pages.find((pg) => pg.url().includes(s.url ?? ""))) ?? null
              if (!target)
                throw new Error(`no page matches ${s.index !== undefined ? `index ${s.index}` : `url ${s.url}`}`)
              await target.bringToFront()
              page = target
              results.push({ action: "tab", mode, ok: true, url: page.url() })
            } else {
              await p.close()
              page = null
              const rest = ctx.pages()
              if (rest.length) {
                page = rest[rest.length - 1]
                await page.bringToFront()
              }
              results.push({ action: "tab", mode, ok: true, url: page ? page.url() : "about:blank" })
            }
            break
          }
          case "newpage":
            await closePage()
            await getPage()
            results.push({ action: "newpage", ok: true, url: "about:blank" })
            break
          case "close":
            await closePage()
            results.push({ action: "close", ok: true, url: "about:blank" })
            break
        }
      } catch (e) {
        // 260908 Red 单步容错：状态链一步失败后面全错位，中止并保留已成功的结果，
        // 不让一次坏 selector 把整批 observe/截图一起带走。
        results.push({ action: s.action, error: String(e?.message ?? e).slice(0, 300), url: p.url() })
        break
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(results) }] }
  } finally {
    // 页面/浏览器保持打开，供下一次调用复用
    touchIdle()
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
