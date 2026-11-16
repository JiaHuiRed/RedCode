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
