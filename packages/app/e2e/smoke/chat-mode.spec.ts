import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockRedCodeServer } from "../utils/mock-server"

test("imported companion starts and resumes a bound Chat session without replacing Code identity", async ({ page }) => {
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
  const sessions = [...fixture.sessions]
  let imported = false
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
    if (url.pathname === "/companion/import") {
      imports.push(route.request().postDataJSON())
      if (imports.length === 1) return reply({ message: "Archive not found" }, 400)
      imported = true
      return reply({ profile, imported: true })
    }
    if (url.pathname === "/session" && route.request().method() === "POST") {
      creates.push({ ...route.request().postDataJSON(), directory: url.searchParams.get("directory") })
      sessions.push(boundSession)
      return reply(boundSession)
    }
    if (url.pathname === "/soul")
      return reply([
        { id: "code-soul", name: "Code colleague", displayName: "Code colleague", commitPrefix: "Code" },
        { id: profile.soulID, name: profile.name, displayName: profile.name, commitPrefix: "Friend" },
      ])
    return route.fallback()
  })

  await page.goto("/chat")
  const mode = page.locator('[data-component="product-mode-switch"]')
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  const source = page.locator('[data-action="chat-import-source"]')
  await source.fill("/archives/old-home.zip")
  await page.locator('[data-action="chat-import"]').click()
  await expect(page.getByRole("alert")).toContainText("Archive not found")
  await expect(source).toHaveValue("/archives/old-home.zip")
  await page.locator('[data-action="chat-import"]').click()
  await expect(page.getByRole("heading", { name: profile.name })).toBeVisible()
  expect(imports).toEqual([{ source: "/archives/old-home.zip" }, { source: "/archives/old-home.zip" }])

  await page.locator('[data-action="chat-start"]').click()
  await expect(page).toHaveURL(new RegExp(`/session/${boundSession.id}$`))
  expect(creates).toEqual([{ mode: "chat", companionID: profile.id, directory: profile.directory }])
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  await expect(page.locator('[data-action="prompt-soul"]')).toHaveCount(0)

  await page.reload()
  await expect(mode.locator('[data-mode="chat"]')).toHaveAttribute("aria-current", "page")
  await page.keyboard.press("Control+Shift+s")
  await expect(page).toHaveURL(new RegExp(`/chat\\?companion=${profile.id}$`))
  await expect(page.getByRole("link", { name: boundSession.title })).toBeVisible()
  await page.getByRole("link", { name: boundSession.title }).click()
  await expect(page).toHaveURL(new RegExp(`/${base64Encode(fixture.directory)}/session/${boundSession.id}$`))
  await mode.locator('[data-mode="code"]').click()
  await expect(page.locator('[data-component="home-dashboard"]')).toBeVisible()
  await expect(mode.locator('[data-mode="code"]')).toHaveAttribute("aria-current", "page")
  expect(creates).toHaveLength(1)
  expect(errors).toEqual([])
})
