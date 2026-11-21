import { expect, test, type Route } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockRedCodeServer } from "../utils/mock-server"

test("imported companion retries a deleted first-chat session and resumes the replacement", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const profile = {
    id: "existing-friend",
    name: "Existing friend",
    soulID: "companion-soul",
    directory: fixture.directory,
    createdAt: 1700000000000,
    files: 12,
    warnings: ["Historical conversation traces are preserved separately; this import covers the personal workspace."],
    timezone: "Asia/Shanghai",
  }
  const boundSession = {
    ...fixture.sessions[0]!,
    id: "ses_companion_chat",
    title: "A continuing conversation",
    mode: "chat",
    companionID: profile.id,
    soul: profile.soulID,
  }
  const deletedSession = { ...boundSession, id: "ses_companion_deleted" }
  const sessions = [...fixture.sessions]
  let imported = false
  let deleted = false
  let acknowledged: { messageID: string; parts: { type: string; text: string }[] } | undefined
  const promptSessions: string[] = []
  const imports: unknown[] = []
  const creates: unknown[] = []
  await mockRedCodeServer(page, { ...fixture, sessions, pageMessages: () => ({ items: [] }) })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    const reply = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
        body: JSON.stringify(body),
      })
    if (route.request().method() === "OPTIONS") return reply({})
    if (url.pathname === "/companion" && route.request().method() === "GET") return reply(imported ? [profile] : [])
    if (url.pathname === `/companion/${profile.id}`)
      return reply({ profile, paths: { soul: "", identity: "", user: "", memory: "" } })
    if (url.pathname === "/instructions") return reply({ sources: [] })
    if (url.pathname === "/config/providers") return reply({ providers: fixture.provider.all })
    if (url.pathname === "/companion/import") {
      imports.push(route.request().postDataJSON())
      if (imports.length === 1) return reply({ message: "Archive not found" }, 400)
      imported = true
      return reply({ profile, imported: true })
    }
    if (url.pathname === "/session" && route.request().method() === "POST") {
      creates.push({ ...route.request().postDataJSON(), directory: url.searchParams.get("directory") })
      const session = creates.length === 1 ? deletedSession : boundSession
      if (session === boundSession) sessions.push(session)
      return reply(session)
    }
    if (url.pathname === `/session/${deletedSession.id}` && deleted) return reply({ message: "Session not found" }, 404)
    if (url.pathname === `/session/${deletedSession.id}/prompt_async`) {
      promptSessions.push(deletedSession.id)
      return reply({ message: "Could not send the first message" }, 400)
    }
    if (url.pathname.startsWith(`/session/${deletedSession.id}/message/`)) return reply({}, 404)
    if (url.pathname === `/session/${boundSession.id}/prompt_async`) {
      promptSessions.push(boundSession.id)
      acknowledged = route.request().postDataJSON()
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (acknowledged && url.pathname === `/session/${boundSession.id}/message/${acknowledged.messageID}`) {
      return reply({ info: { id: acknowledged.messageID, role: "user" }, parts: acknowledged.parts })
    }
    if (url.pathname === "/soul")
      return reply([
        { id: "code-soul", name: "Code colleague", displayName: "Code colleague", commitPrefix: "Code" },
        { id: profile.soulID, name: profile.name, displayName: profile.name, commitPrefix: "Friend" },
      ])
    return route.fallback()
  })

  await page.goto("/chat")
  await expect(page.locator('[data-component="chat-home"] h1')).toBeVisible()
  const mode = page.locator('[data-component="product-mode-switch"]')
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  await page.getByRole("button", { name: "Conversation options" }).click()
  await page.getByRole("button", { name: "Companion settings" }).click()
  await page.getByRole("button", { name: "Files & data", exact: true }).click()
  await page
    .locator(".settings-section")
    .filter({ hasText: "Add an existing companion archive" })
    .getByRole("button", { name: "Open", exact: true })
    .click()
  const importDialog = page.getByRole("dialog", { name: "Add an existing companion archive" })
  const source = importDialog.getByLabel("Archive location")
  const importArchive = importDialog.getByRole("button", { name: "Import archive" })
  await source.fill("/archives/old-home.zip")
  await importArchive.click()
  await expect(importDialog.getByRole("alert")).toContainText("Archive not found")
  await expect(source).toHaveValue("/archives/old-home.zip")
  await importArchive.click()
  await expect(importDialog.getByRole("status")).toContainText("Materials added")
  await importDialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(importDialog).toBeHidden()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("button", { name: "Close", exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="chat-home"]').getByRole("button", { name: profile.name })).toBeVisible()
  expect(imports).toEqual([{ source: "/archives/old-home.zip" }, { source: "/archives/old-home.zip" }])

  const home = page.locator('[data-component="chat-home"]')
  const draft = home.locator('[data-action="chat-first-message"]')
  await draft.fill("Hello, friend")
  await home.getByRole("button", { name: "Send", exact: true }).click()
  const failure = home.getByRole("alert")
  await expect(failure).toContainText("Could not send the first message")
  await expect(draft).toHaveValue("Hello, friend")
  deleted = true
  await failure.getByRole("button", { name: "Retry" }).click()
  await expect.poll(() => acknowledged?.parts).toEqual([{ type: "text", text: "Hello, friend" }])
  expect(errors).toEqual([])
  await expect(page).toHaveURL(new RegExp(`/session/${boundSession.id}$`))
  const binding = { mode: "chat", companionID: profile.id, directory: profile.directory }
  expect(creates).toEqual([binding, binding])
  expect(promptSessions).toEqual([deletedSession.id, boundSession.id])
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  await expect(page.locator('[data-action="prompt-soul"]')).toHaveCount(0)

  await page.reload()
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  await page.keyboard.press("Control+Shift+s")
  await expect(page).toHaveURL(new RegExp(`/chat\\?companion=${profile.id}$`))
  await expect(draft).toHaveValue("")
  const recentChat = home.getByRole("link", { name: boundSession.title })
  await expect(recentChat).toBeVisible()
  await recentChat.click()
  await expect(page).toHaveURL(new RegExp(`/${base64Encode(fixture.directory)}/session/${boundSession.id}$`))
  await mode.locator('[data-mode="code"]').click()
  await expect(page.locator('[data-component="home-dashboard"]')).toBeVisible()
  await expect(mode.locator('[data-mode="code"]')).toHaveAttribute("aria-current", "page")
  expect(creates).toHaveLength(2)
  expect(errors).toEqual([])
})

// 261117 Red Hold both binding reads so cold navigation cannot borrow Code's defaults.
const coldChatSessionID = "ses_companion_cold_chat"

test("cold-opened bound Chat session keeps new-session entries off the Code route until the binding loads", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  const profile = {
    id: "existing-friend",
    name: "Existing friend",
    soulID: "companion-soul",
    directory: fixture.directory,
    createdAt: 1700000000000,
    files: 12,
    warnings: [],
    timezone: "Asia/Shanghai",
  }
  await mockRedCodeServer(page, {
    ...fixture,
    sessions: [
      ...fixture.sessions,
      {
        ...fixture.sessions[0]!,
        id: coldChatSessionID,
        title: "A continuing conversation",
        mode: "chat",
        companionID: profile.id,
        soul: profile.soulID,
      },
    ],
    pageMessages: () => ({ items: [] }),
  })

  const backendPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
  const backendPath = (url: string) => {
    const parsed = new URL(url)
    return parsed.port === backendPort ? parsed.pathname : undefined
  }
  const held = (path: string) => path === "/session" || path === `/session/${coldChatSessionID}`

  let releaseReads!: () => void
  const readsHeld = new Promise<void>((resolve) => (releaseReads = resolve))
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseReads()
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== backendPort) return route.fallback()
    if (url.pathname === "/companion") return json(route, [profile])
    if (!held(url.pathname)) return route.fallback()
    await readsHeld
    // A failed assertion may close the page before the held request is released.
    await route.fallback().catch(() => undefined)
  })

  const sessionUrl = `/${base64Encode(fixture.directory)}/session/${coldChatSessionID}`
  const mode = page.locator('[data-component="product-mode-switch"]')
  const newSession = page.locator('[data-frost-surface="titlebar"]').getByLabel("New session", { exact: true })
  const listSeen = page.waitForRequest(
    (request) => request.method() === "GET" && backendPath(request.url()) === "/session",
  )
  const detailSeen = page.waitForRequest(
    (request) => request.method() === "GET" && backendPath(request.url()) === `/session/${coldChatSessionID}`,
  )

  try {
    await page.goto(sessionUrl)
    await Promise.all([listSeen, detailSeen])
    await expect(newSession).toBeVisible()

    const codeEntry = `${new URL(page.url()).pathname.replace(/\/session\/[^/]+$/, "")}/session`

    expect(
      await newSession.getAttribute("href"),
      "titlebar new-session entry must not target the Code new-session route before the Chat binding loads",
    ).not.toBe(codeEntry)
    await expect(newSession).toBeDisabled()

    await page.keyboard.press("Control+Shift+s")
    release()
    await expect(page).toHaveURL(new RegExp(`/session/${coldChatSessionID}$`))
    await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
    await expect(newSession).toHaveAttribute("href", `/chat?companion=${profile.id}`)
    await expect(newSession).toBeEnabled()
    expect(errors).toEqual([])
  } finally {
    release()
  }
})

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
    body: JSON.stringify(body),
  })
}

test("read a companion's latest diary and switch to an earlier date", async ({ page }) => {
  const profile = {
    id: "diary-friend", soulID: "diary-friend", name: "Luna", directory: fixture.directory,
    createdAt: 1700000000000, files: 2, timezone: "UTC", warnings: [],
  }
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (url.pathname === "/companion") return json(route, [profile])
    if (url.pathname === "/companion/diary-friend")
      return json(route, { profile, paths: { directory: profile.directory, memory: profile.directory + "/MEMORY.md" } })
    if (url.pathname === "/soul/diary-friend") return json(route, { id: profile.id, name: profile.name })
    if (url.pathname === "/file" && url.searchParams.get("path") === "memory")
      return json(route, ["2026-05-01.md", "2026-05-03.md"].map((name) => ({ type: "file", name })))
    if (url.pathname === "/file/content") {
      expect(url.searchParams.get("directory")).toBe(profile.directory)
      const latest = url.searchParams.get("path") === "memory/2026-05-03.md"
      return json(route, { type: "text", content: latest ? "An egg tart at last!" : "One place too late." })
    }
    return route.fallback()
  })
  await page.goto("/chat")
  await page.getByRole("button", { name: "Conversation options" }).click()
  await page.getByRole("button", { name: "Companion settings" }).click()
  await page.locator("section").filter({ has: page.getByRole("heading", { name: "Memory", exact: true }) })
    .getByRole("button", { name: "View details" }).click()
  const diary = page.locator('[data-component="companion-diary"]')
  await expect(diary.getByText("An egg tart at last!")).toBeVisible()
  await diary.locator("select").selectOption("2026-05-01.md")
  await expect(diary.getByText("One place too late.")).toBeVisible()
})

test("read imported dreams on demand, retry a failed read and switch companions", async ({ page }) => {
  const first = {
    id: "dreamer", name: "Autumn", soulID: "dreamer", directory: fixture.directory,
    createdAt: 1700000000000, files: 1, timezone: "UTC", warnings: [],
  }
  const second = { ...first, id: "friend", name: "Friend", soulID: "friend", directory: fixture.directory + "-other" }
  const reads: string[] = []
  let modelRequests = 0
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (url.pathname.endsWith("/prompt_async")) modelRequests++
    if (url.pathname === "/companion") return json(route, [first, second])
    const owner = [first, second].find((item) => url.pathname === "/companion/" + item.id)
    if (owner) return json(route, { profile: owner, paths: { directory: owner.directory } })
    if (url.pathname === "/file" && url.searchParams.get("path") === ".") {
      return json(route, url.searchParams.get("directory") === first.directory ? [{ name: "dreams.md", type: "file" }] : [])
    }
    if (url.pathname === "/file/content" && url.searchParams.get("path") === "dreams.md") {
      reads.push(url.searchParams.get("directory")!)
      if (reads.length === 1)
        return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "Offline" })
      return json(route, { type: "text", content: "# Dream diary\nI dreamt of a silver boat." })
    }
    return route.fallback()
  })
  await page.goto("/chat?companion=dreamer")
  const open = page.getByRole("button", { name: "Dream diary", exact: true })
  await page.getByRole("button", { name: "Conversation options" }).click()
  await expect(open).toBeVisible()
  expect(reads).toEqual([])
  await open.click()
  const diary = page.getByRole("dialog", { name: "Dream diary" })
  await expect(diary.getByRole("alert")).toBeVisible()
  await diary.getByRole("button", { name: "Retry" }).click()
  await expect(diary.getByRole("article")).toContainText("I dreamt of a silver boat.")
  await diary.getByRole("button", { name: "Close" }).click()
  await page.getByRole("button", { name: "Conversation options" }).click()
  await page.locator('[data-component="chat-home"] select').first().selectOption(second.id)
  await expect(page.getByRole("button", { name: second.name })).toBeVisible()
  await page.getByRole("button", { name: "Conversation options" }).click()
  await open.click()
  await expect(diary).toContainText("No dream entries yet.")
  await expect(diary).not.toContainText("silver boat")
  expect(reads).toEqual([first.directory, first.directory])
  expect(modelRequests).toBe(0)
})

test("first-chat attachments follow the selected companion and the outgoing request", async ({ page }) => {
  const profiles = ["friend-a", "friend-b"].map(id => ({
    id, name: id, soulID: id, directory: fixture.directory, createdAt: 1, files: 2, warnings: [], timezone: "UTC",
    introduction: "complete",
  }))
  const session = { ...fixture.sessions[0]!, id: "ses_attachment_b", mode: "chat", companionID: "friend-b" }
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/*", async route => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (url.pathname === "/companion") return json(route, profiles)
    if (url.pathname === "/config/providers") return json(route, { providers: fixture.provider.all })
    if (url.pathname === "/session" && route.request().method() === "POST") return json(route, session)
    if (url.pathname.endsWith("/prompt_async")) return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    return route.fallback()
  })
  await page.goto("/chat?companion=friend-a")
  const home = page.locator('[data-component="chat-home"]')
  const pick = home.locator('input[type="file"]')
  const choose = home.locator("select").first()
  const first = { name: "for-a.txt", mimeType: "text/plain", buffer: Buffer.from("A") }
  const second = { name: "for-b.txt", mimeType: "text/plain", buffer: Buffer.from("B") }
  await expect(home.locator(".companion-profile")).toContainText(profiles[0]!.name)
  await pick.setInputFiles(first)
  await expect(home.getByText(first.name, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Conversation options" }).click()
  await choose.selectOption("friend-b")
  await expect(home.getByText(first.name, { exact: true })).toHaveCount(0)
  await pick.setInputFiles(second)
  await page.getByRole("button", { name: "Conversation options" }).click()
  await choose.selectOption("friend-a")
  await expect(home.getByText(first.name, { exact: true })).toBeVisible()
  await expect(home.getByText(second.name, { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Conversation options" }).click()
  await choose.selectOption("friend-b")
  await home.locator('[data-action="chat-first-message"]').fill("hello B")
  const sent = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname.endsWith("/prompt_async"))
  await home.locator('button[type="submit"]').click()
  expect((await sent).postDataJSON().parts).toEqual([
    { type: "text", text: "hello B" },
    { type: "file", mime: "text/plain", filename: second.name, url: "data:text/plain;base64,Qg==" },
  ])
})

test("mixed paste keeps both the screenshot and the typed note", async ({ browser }) => {
  // Chromium 构造的 ClipboardEvent 会把传入 DataTransfer 克隆成保护态：File 保留、
  // text/plain 的 getData 返回空——合成事件带不了文字。走真实剪贴板（授权后
  // navigator.clipboard.write 图+文，再真实 Ctrl+V），顺带覆盖「Windows 剪贴板实测」。
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  const profile = {
    id: "friend-p",
    name: "Pix",
    soulID: "soul-p",
    directory: fixture.directory,
    createdAt: 1,
    files: 2,
    warnings: [],
    timezone: "UTC",
    introduction: "complete",
  }
  const session = { ...fixture.sessions[0]!, id: "ses_mixed_paste", mode: "chat", companionID: profile.id }
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (url.pathname === "/companion") return json(route, [profile])
    if (url.pathname === "/config/providers") return json(route, { providers: fixture.provider.all })
    if (url.pathname === "/session" && route.request().method() === "POST") return json(route, session)
    if (url.pathname.endsWith("/prompt_async"))
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    return route.fallback()
  })
  await page.goto(`/chat?companion=${profile.id}`)
  const home = page.locator('[data-component="chat-home"]')
  const input = home.locator('[data-action="chat-first-message"]')
  await input.fill("请看这里的错误")
  // 选中「这里」，随后一次粘贴同时注入一张图和说明文字（可控 text/plain + File）
  await input.evaluate((el) => {
    const box = el as HTMLTextAreaElement
    const start = box.value.indexOf("这里")
    box.setSelectionRange(start, start + 2)
    box.focus()
  })
  await page.evaluate(() =>
    navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob(["第二行"], { type: "text/plain" }),
        // 1x1 透明 PNG：剪贴板写入要求 image blob 可解码，塞字符串会 DataError
        "image/png": new Blob(
          [
            new Uint8Array(
              atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
                .split("")
                .map((ch) => ch.charCodeAt(0)),
            ),
          ],
          { type: "image/png" },
        ),
      }),
    ]),
  )
  await input.press("Control+V")
  // 说明文字替换选区，光标落在新文字末尾；截图只出现一次
  await expect(input).toHaveValue("请看第二行的错误")
  const caret = await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)
  expect(caret).toBe("请看第二行".length)
  // Chromium 会把剪贴板里的图重命名为 image.png，断言附件条数与类型而不是写入名
  await expect(home.locator("li")).toHaveCount(1)
  // 发送后同一条消息含最终文字和一张图
  const sent = page.waitForRequest((req) => req.method() === "POST" && new URL(req.url()).pathname.endsWith("/prompt_async"))
  await home.locator('button[type="submit"]').click()
  const body = (await sent).postDataJSON()
  expect(body.parts[0]).toEqual({ type: "text", text: "请看第二行的错误" })
  expect(body.parts[1]).toMatchObject({ type: "file", mime: "image/png" })
  expect(String(body.parts[1].url)).toContain("data:image/png;base64,")
})

test("Chat remembers each conversation's model, filters the catalogue and uses both bubble colors", async ({
  page,
}) => {
  const profile = { id: "friend", soulID: "soul-friend", name: "Luna", directory: fixture.directory }
  const models = {
    alpha: { id: "alpha", name: "Alpha", variants: { high: {} }, limit: { context: 32_000 } },
    beta: { id: "beta", name: "Beta", variants: {}, limit: { context: 32_000 } },
    legacy: { id: "legacy", name: "Legacy", release_date: "2020-01-01", family: "test", limit: { context: 32_000 } },
  }
  const provider = { id: "studio", name: "Studio", models }
  const retired = {
    id: "unused",
    name: "Disconnected",
    models: { ghost: { ...models.beta, id: "ghost", name: "Ghost" } },
  }
  const sessions = fixture.sessions.map((s) => ({ ...s, mode: "chat", companionID: profile.id, soul: profile.soulID }))
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await mockRedCodeServer(page, {
    ...fixture,
    sessions,
    provider: { all: [provider, retired], connected: ["studio"], default: { studio: "beta" } },
    pageMessages: (id) => {
      const user = {
        id: "msg_a",
        sessionID: id,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: {
          providerID: "studio",
          modelID: id === sessions[0]!.id ? "alpha" : "beta",
          variant: id === sessions[0]!.id ? "high" : undefined,
        },
      }
      const reply = {
        id: "msg_b",
        sessionID: id,
        role: "assistant",
        time: { created: 2, completed: 3 },
        parentID: user.id,
        agent: "build",
        modelID: user.model.modelID,
        providerID: "studio",
        mode: "build",
        path: { cwd: fixture.directory, root: fixture.directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      return {
        items: [user, reply].map((info, i) => ({
          info,
          parts: [
            { id: "prt_" + i, messageID: info.id, sessionID: id, type: "text", text: i ? "Welcome back" : "Hello" },
          ],
        })),
      }
    },
  })
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    if (url.pathname === "/companion") return json(route, [profile])
    if (url.pathname === "/config/providers") return json(route, { providers: [provider], default: { studio: "beta" } })
    return route.fallback()
  })
  await page.goto("/chat?companion=friend")
  const homeModel = page.locator('[data-action="chat-choose-model"]')
  await homeModel.click()
  const menu = page.locator('[data-component="chat-model-popover"]')
  await expect(menu.getByText("Alpha", { exact: true })).toBeVisible()
  await expect(menu.getByText("Ghost", { exact: true })).toHaveCount(0)
  await expect(menu.getByText("Legacy", { exact: true })).toHaveCount(0)
  await menu.getByText("Beta", { exact: true }).click()
  await page.reload()
  await expect(homeModel).toContainText("Beta")
  const first = sessions[0]!
  await page.getByRole("link", { name: first.title }).click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Alpha")
  await expect(page.locator('[data-action="prompt-variant"]')).toContainText(/high/i)
  for (const scheme of ["light", "dark"]) {
    await page.evaluate((scheme) => (document.documentElement.dataset.colorScheme = scheme), scheme)
    const mine = page.locator('[data-slot="user-message-text"]').first()
    const theirs = page.locator('[data-slot="text-part-body"]').first()
    await expect(mine).toHaveCSS("background-color", "rgb(255, 179, 167)")
    await expect(theirs).toHaveCSS("background-color", "rgb(16, 174, 255)")
    await expect(mine).toHaveCSS("color", "rgb(64, 36, 46)")
    await expect(theirs.locator('[data-component="markdown"]')).toHaveCSS("color", "rgb(6, 39, 57)")
  }
  await page.locator(".companion-new").click()
  await expect(homeModel).toContainText("Alpha")
  await expect(page.locator('[data-action="chat-choose-variant"]')).toContainText(/high/i)
  await page.getByRole("link", { name: sessions[1]!.title }).click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Beta")
  await page.locator(".companion-new").click()
  await expect(homeModel).toContainText("Beta")
  expect(errors).toEqual([])
})

test.describe("companion arrival", () => {
  test.use({ locale: "zh-CN" })
  test("uses the bound partner's name until a reply arrives", async ({ page }) => {
    const partner = { id: "sky", name: "阿蓝", soulID: "sky-soul", directory: fixture.directory }
    const session = { ...fixture.sessions[0]!, mode: "chat", companionID: partner.id, soul: partner.soulID }
    const messages = fixture.messages[fixture.sourceID as keyof typeof fixture.messages]
    let replied = false
    await mockRedCodeServer(page, {
      ...fixture,
      sessions: [session],
      pageMessages: () => ({ items: messages.slice(0, replied ? 2 : 1) }),
    })
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url())
      if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
      if (url.pathname === "/companion") return json(route, [partner])
      if (url.pathname === "/session/status") return json(route, { [session.id]: { type: "busy" } })
      if (url.pathname === "/config/providers") return json(route, { providers: fixture.provider.all })
      return route.fallback()
    })
    await page.goto(`/${base64Encode(fixture.directory)}/session/${session.id}`)
    await expect(page.getByText("你的阿蓝正在赶来", { exact: true })).toBeVisible()
    replied = true
    await page.reload()
    await expect(page.locator('[data-timeline-row="AssistantPart"]').first()).toBeVisible()
    await expect(page.getByText("你的阿蓝正在赶来", { exact: true })).toHaveCount(0)
  })
})

test("Code uses the paper-plane send icon in its existing composer", async ({ page }) => {
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
  await expect(page.locator('[data-action="prompt-submit"] use')).toHaveAttribute("href", "#redcode-icon-paper-plane")
  await expect(page.locator(".companion-frame")).toHaveCount(0)
})
