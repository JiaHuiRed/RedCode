import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockRedCodeServer } from "../utils/mock-server"

test("turn outputs open a document and retain the producing tool as the return target", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const sessionID = "ses_deliverables"
  const userID = "msg_outputs_user"
  const assistantID = "msg_outputs_assistant"
  const now = Date.now()
  const files = ["docs/brief.md", "prototype/index.html", "src/one.ts", "src/two.ts", "src/three.ts"]
  const write = (path: string, index: number) => ({
    id: `prt_output_${index}`,
    sessionID,
    messageID: assistantID,
    type: "tool",
    tool: "write",
    callID: `call_output_${index}`,
    state: {
      status: "completed",
      input: { filePath: `${fixture.directory}/${path}`, content: "# Output" },
      metadata: { filepath: `${fixture.directory}/${path}`, exists: false },
      output: `Wrote ${path}`,
      title: path,
      time: { start: now + index, end: now + index + 1 },
    },
  })
  const parts = [
    ...files.map(write),
    {
      id: "prt_output_final",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "The brief and prototype are ready to review.",
    },
  ]
  const messages = [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "redcode", modelID: "claude-opus-4-6" },
      },
      parts: [
        {
          id: "prt_output_user",
          sessionID,
          messageID: userID,
          type: "text",
          text: "Create a brief and an HTML prototype.",
        },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: now + 1, completed: now + 20 },
        providerID: "redcode",
        modelID: "claude-opus-4-6",
        agent: "build",
        mode: "build",
        finish: "stop",
        cost: 0,
        path: { cwd: fixture.directory, root: fixture.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    },
  ]
  await mockRedCodeServer(page, {
    ...fixture,
    sessions: [{ ...fixture.sessions[0]!, id: sessionID, title: "Deliverables smoke" }],
    pageMessages: () => ({ items: messages }),
  })
  await page.route("**/file/content?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        type: "text",
        content: "# Delivery brief\n\nThis is the actual rendered document.",
        mimeType: "text/markdown",
      }),
    }),
  )
  await page.goto(`/${base64Encode(fixture.directory)}/session/${sessionID}`)
  const panel = page.locator('[data-component="turn-deliverables"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator("article")).toHaveCount(4)
  await page.setViewportSize({ width: 1279, height: 720 })
  await expect.poll(async () => {
    const cards = await panel.boundingBox()
    const side = await page.locator("#review-panel").boundingBox()
    return !!cards && !!side && cards.x + cards.width <= side.x
  }).toBe(true)
  const sidePanel = page.locator("#review-panel.session-side-panel__capsule--wide.session-side-panel__capsule--open")
  for (const width of [1280, 1440, 1600]) {
    await page.setViewportSize({ width, height: 720 })
    await expect(sidePanel).toBeVisible()
    await expect.poll(async () => {
      const cards = await panel.boundingBox()
      const side = await sidePanel.boundingBox()
      return !!cards && !!side && cards.x + cards.width <= side.x
    }).toBe(true)
  }
  await page.getByRole("button", { name: "Dock workspace beside chat" }).click()
  await expect(page.locator("#review-panel")).toHaveClass(/session-side-panel__capsule--docked/)
  await expect(page.locator("#session-chat-panel")).toHaveCSS("padding-right", "0px")
  await page.getByRole("button", { name: "Return to capsule" }).click()
  await page.getByRole("button", { name: "Float workspace" }).click()
  await expect(page.locator("#review-panel")).toHaveClass(/session-side-panel__capsule--floating/)
  await expect(page.locator("#session-chat-panel")).toHaveCSS("padding-right", "0px")
  await page.getByRole("button", { name: "Return to capsule" }).click()
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole("button", { name: "Collapse panel" }).click()
  await expect(page.locator("#session-chat-panel")).toHaveCSS("padding-right", "348px")
  await page.getByRole("button", { name: "Expand panel" }).click()
  await expect(sidePanel).toBeVisible()
  await panel.getByRole("button", { name: /Show 1 more|再看 1 个|さらに 1 件/ }).click()
  await expect(panel.locator("article")).toHaveCount(5)
  const open = panel.getByRole("button", { name: /^(Read document|阅读文档|文書を読む) docs\/brief.md$/ })
  await open.click()
  await expect(page.getByRole("heading", { name: "Delivery brief", exact: true })).toBeVisible()
  await expect(page.getByRole("tab", { name: "brief.md" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "brief.md" }).focus()
  await page.keyboard.press("Control+Shift+r")
  await expect(page.getByRole("button", { name: "Expand panel" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Context" })).toBeFocused()
  await expect(page.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "Review" }).click()
  await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("tab", { name: "Context" }).click()
  await expect(page.getByRole("tab", { name: "Context" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Expand panel" }).click()
  const openCode = panel.getByRole("button", { name: /^(Open file|打开文件|ファイルを開く) src\/three.ts$/ })
  await openCode.focus()
  await expect(openCode).toBeFocused()
  await openCode.press("Enter")
  await expect(page.getByRole("tab", { name: "three.ts" })).toHaveAttribute("aria-selected", "true")
  await open.click()
  await expect(page.getByRole("heading", { name: "Delivery brief", exact: true })).toBeVisible()
  await page.getByRole("button", { name: /返回工具|Back to tool|ツールに戻る/ }).click()
  await expect(page.locator('[data-timeline-part-id="prt_output_0"]')).toBeVisible()
  await panel.getByRole("button", { name: /^(View source step|查看来源|操作を確認) prototype\/index.html$/ }).click()
  await expect(page.locator('[data-timeline-part-id="prt_output_1"]')).toBeVisible()
  await panel.getByRole("button", { name: /^(Open file|打开文件|ファイルを開く) prototype\/index.html$/ }).click()
  await expect(page.getByRole("tab", { name: "index.html" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "brief.md" })).toHaveCount(0)
  await page.getByRole("tab", { name: "Review" }).click()
  await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true")
  expect(errors).toEqual([])
})

test("chat deliverable opens a standalone reading dialog with the document body", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const sessionID = "ses_chat_deliverable"
  const userID = "msg_chat_deliverable_user"
  const assistantID = "msg_chat_deliverable_assistant"
  const now = Date.now()
  const profile = { id: "scribe", soulID: "soul-scribe", name: "Scribe", directory: fixture.directory }
  const messages = [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "redcode", modelID: "claude-opus-4-6" },
      },
      parts: [
        { id: "prt_chat_deliverable_user", sessionID, messageID: userID, type: "text", text: "Write today's diary." },
      ],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: now + 1, completed: now + 20 },
        providerID: "redcode",
        modelID: "claude-opus-4-6",
        agent: "build",
        mode: "build",
        finish: "stop",
        cost: 0,
        path: { cwd: fixture.directory, root: fixture.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_chat_deliverable_write",
          sessionID,
          messageID: assistantID,
          type: "tool",
          tool: "write",
          callID: "call_chat_deliverable",
          state: {
            status: "completed",
            input: { filePath: `${fixture.directory}/memory/2026-11-21.md`, content: "# Diary title" },
            metadata: { filepath: `${fixture.directory}/memory/2026-11-21.md`, exists: false },
            output: "Wrote memory/2026-11-21.md",
            title: "memory/2026-11-21.md",
            time: { start: now + 2, end: now + 3 },
          },
        },
        { id: "prt_chat_deliverable_text", sessionID, messageID: assistantID, type: "text", text: "Diary saved." },
      ],
    },
  ]
  const sessions = [
    {
      ...fixture.sessions[0]!,
      id: sessionID,
      title: "Chat deliverable",
      mode: "chat",
      companionID: profile.id,
      soul: profile.soulID,
    },
  ]
  await mockRedCodeServer(page, {
    ...fixture,
    sessions,
    pageMessages: () => ({ items: messages }),
  })
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (url.pathname === "/companion") return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([profile]),
    })
    return route.fallback()
  })
  await page.route("**/file/content?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        type: "text",
        content: "# Diary title\n\nA line only the reading dialog can show.",
        mimeType: "text/markdown",
      }),
    }),
  )
  await page.goto(`/${base64Encode(fixture.directory)}/session/${sessionID}`)
  const opener = page.getByRole("button", { name: /^(Read document|阅读文档|文書を読む) memory\/2026-11-21\.md$/ })
  await opener.click()
  const dialog = page.getByRole("dialog", { name: /memory\/2026-11-21\.md/ })
  // 方案一验收：断言正文里的独有文字，不能只断言弹窗存在。
  await expect(dialog.getByText("A line only the reading dialog can show.")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
  expect(errors).toEqual([])
})

test("reading dialog survives background refreshes without losing the reading spot", async ({ page }) => {
  // 261121 Red 方案④验收：读到中段，连续两次原子保存（第二次发生在第一次读取在途时）。
  // 旧实现会把正文顶成加载占位（阅读被打断、滚动归零），且第二次保存的补读被在途
  // promise 复用吞掉——末次改动永远不上屏。现在正文不卸载（锚段节点全程 connected）、
  // 在途期间的更新合并成一次补读，末次改动可见、同一段仍在视野。
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const sessionID = "ses_read_refresh"
  const userID = "msg_read_refresh_user"
  const assistantID = "msg_read_refresh_assistant"
  const now = Date.now()
  const profile = { id: "scribe-r", soulID: "soul-scribe-r", name: "ScribeR", directory: fixture.directory }
  const filePath = `${fixture.directory}/memory/2026-11-21.md`
  const messages = [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "redcode", modelID: "claude-opus-4-6" },
      },
      parts: [{ id: "prt_read_refresh_user", sessionID, messageID: userID, type: "text", text: "Write today's diary." }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: now + 1, completed: now + 20 },
        providerID: "redcode",
        modelID: "claude-opus-4-6",
        agent: "build",
        mode: "build",
        finish: "stop",
        cost: 0,
        path: { cwd: fixture.directory, root: fixture.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_read_refresh_write",
          sessionID,
          messageID: assistantID,
          type: "tool",
          tool: "write",
          callID: "call_read_refresh",
          state: {
            status: "completed",
            input: { filePath, content: "# Diary title" },
            metadata: { filepath: filePath, exists: false },
            output: "Wrote memory/2026-11-21.md",
            title: "memory/2026-11-21.md",
            time: { start: now + 2, end: now + 3 },
          },
        },
        { id: "prt_read_refresh_text", sessionID, messageID: assistantID, type: "text", text: "Diary saved." },
      ],
    },
  ]
  const sessions = [
    {
      ...fixture.sessions[0]!,
      id: sessionID,
      title: "Reading refresh",
      mode: "chat",
      companionID: profile.id,
      soul: profile.soulID,
    },
  ]
  await mockRedCodeServer(page, {
    ...fixture,
    sessions,
    pageMessages: () => ({ items: messages }),
  })
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (url.pathname === "/companion")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify([profile]),
      })
    return route.fallback()
  })

  // 三个版本的正文：打开读到 v1；两次保存（watcher 事件）后最终应读到 v3。
  const paragraphs = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} of the diary entry.`)
  const v1 = `# Diary title\n\n${paragraphs.join("\n\n")}`
  const v2 = `${v1}\n\nIntermediate save landed.`
  const v3 = `${v2}\n\nFinal saved line.`
  let contentRequests = 0
  await page.route("**/file/content?**", async (route) => {
    contentRequests += 1
    const body = contentRequests === 1 ? v1 : contentRequests === 2 ? v2 : v3
    // 第一次后台刷新慢一拍：给第二次保存留出「在途窗口」
    if (contentRequests === 2) await new Promise((done) => setTimeout(done, 800))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ type: "text", content: body, mimeType: "text/markdown" }),
    })
  })

  // SSE 先挂起不放行：等弹窗打开、锚段装上观察器之后再推两个 watcher 事件。
  let releaseEvents!: () => void
  const eventsReleased = new Promise<void>((done) => (releaseEvents = done))
  await page.route("**/global/event", async (route) => {
    await eventsReleased
    const watcher = (id: string) =>
      JSON.stringify({
        directory: fixture.directory,
        payload: { id, type: "file.watcher.updated", properties: { file: filePath, event: "change" } },
      })
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "access-control-allow-origin": "*" },
      body: `event: message\ndata: ${watcher("evt_read_refresh_a")}\n\nevent: message\ndata: ${watcher("evt_read_refresh_b")}\n\n`,
    })
  })

  await page.goto(`/${base64Encode(fixture.directory)}/session/${sessionID}`)
  const opener = page.getByRole("button", { name: /^(Read document|阅读文档|文書を読む) memory\/2026-11-21\.md$/ })
  await opener.click()
  const dialog = page.getByRole("dialog", { name: /memory\/2026-11-21\.md/ })
  await expect(dialog.getByText("Paragraph 12 of the diary entry.")).toBeVisible()

  // 把锚段滚进视野，并给节点装上观察器：只要它被卸载过（哪怕重新挂出同文案）就算打断
  await dialog.getByText("Paragraph 12 of the diary entry.").scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const anchor = [...document.querySelectorAll("p")].find((p) => p.textContent?.includes("Paragraph 12 of the diary"))
    ;(window as unknown as { anchorKept: boolean }).anchorKept = !!anchor?.isConnected
    if (!anchor) return
    new MutationObserver(() => {
      if (!anchor.isConnected) (window as unknown as { anchorKept: boolean }).anchorKept = false
    }).observe(document.body, { childList: true, subtree: true })
  })

  // 放行两个 watcher 事件：保存 1 → 慢读取；保存 2 在其途中到达 → 合并成一次补读
  releaseEvents()
  await expect(dialog.getByText("Intermediate save landed.")).toBeVisible()
  await expect(dialog.getByText("Final saved line.")).toBeVisible()
  // 补读确实发生了（三读：打开 + 保存 1 + 合并补读），锚段节点全程未卸载
  expect(contentRequests).toBeGreaterThanOrEqual(3)
  expect(await page.evaluate(() => (window as unknown as { anchorKept: boolean }).anchorKept)).toBe(true)
  // 同一段仍在视野（窗口内可见）
  const anchorRect = await page.evaluate(() => {
    const anchor = [...document.querySelectorAll("p")].find((p) => p.textContent?.includes("Paragraph 12 of the diary"))
    if (!anchor) return null
    const rect = anchor.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight }
  })
  expect(anchorRect).not.toBeNull()
  expect(anchorRect!.top).toBeGreaterThanOrEqual(0)
  expect(anchorRect!.bottom).toBeLessThanOrEqual(anchorRect!.height)
  expect(errors).toEqual([])
})
