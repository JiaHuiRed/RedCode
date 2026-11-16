import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { fixture } from "./session-timeline.fixture"
import { mockRedCodeServer } from "../utils/mock-server"

test("user guidance preserves drafts, retries the same request, and never restarts an ended task", async ({ page }) => {
  const failures: string[] = []
  const network: string[] = []
  const consoleErrors: string[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("request", (request) => {
    if (!["fetch", "xhr"].includes(request.resourceType())) return
    const url = new URL(request.url())
    network.push(`${url.origin}${url.pathname}`)
  })
  const directory = fixture.directory
  const parentID = "ses_guidance_parent"
  const children = ["ses_guidance_a", "ses_guidance_b"]
  const sessions = [parentID, ...children].map((id, index) => ({
    ...fixture.sessions[0]!,
    id,
    title: index === 0 ? "Guidance parent" : `Guidance child ${index}`,
    ...(index === 0 ? {} : { parentID }),
  }))
  const model = { providerID: "redcode", modelID: "claude-opus-4-6" }
  const seed = (sessionID: string) => [{
    info: {
      id: `msg_seed_${sessionID}`,
      sessionID,
      role: "user",
      time: { created: 1700000000000 },
      agent: "build",
      model,
    },
    parts: [{
      id: `prt_seed_${sessionID}`,
      messageID: `msg_seed_${sessionID}`,
      sessionID,
      type: "text",
      text: `Task for ${sessionID}`,
    }],
  }]
  await mockRedCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: fixture.project,
    pageMessages: (sessionID) => ({ items: seed(sessionID) }),
  })
  let running = true
  let delivery = "queued"
  const requests: { sessionID: string; requestID: string; message: string }[] = []
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    const reply = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
      body: JSON.stringify(body),
    })
    if (route.request().method() === "OPTIONS") return reply({})
    if (url.pathname === "/background") return reply(children.map((id, index) => ({
      id,
      type: "task",
      title: `Guidance child ${index + 1}`,
      status: running ? "running" : "completed",
      sessionID: id,
      parentSessionID: parentID,
      startedAt: 1700000000000,
    })))
    const steer = url.pathname.match(/^\/background\/tasks\/([^/]+)\/steer$/)
    if (steer) {
      const body = route.request().postDataJSON() as { requestID: string; message: string }
      requests.push({ sessionID: steer[1]!, ...body })
      if (requests.length === 1) return reply({ message: "temporary guidance failure" }, 500)
      return reply({ messageID: `msg_guidance_${requests.length}`, state: "queued" })
    }
    const receipt = url.pathname.match(/^\/session\/([^/]+)\/message\/(msg_guidance_\d+)$/)
    if (receipt) return reply({
      info: { ...seed(receipt[1]!)[0]!.info, id: receipt[2], delivery },
      parts: [],
    })
    return route.fallback()
  })
  const open = async (id: string) => {
    await page.goto(`/${base64Encode(directory)}/session/${id}`)
    await page.locator('[data-action="subagent-guidance"]').click({ timeout: 30000 })
  }
  const composer = page.locator('[data-component="task-steering"]')
  const input = composer.locator("textarea")
  const send = composer.locator("button").last()
  await open(children[0]!)
  await expect(input).toBeVisible().catch((error: unknown) => {
    throw new Error(`${String(error)}\nClient evidence: ${JSON.stringify({ failures, consoleErrors, network })}`)
  })
  await expect(input).toBeEnabled()
  await input.fill("只核查 KH 的同步入口，先别看归档")
  await send.click()
  await expect(composer.getByRole("alert")).toBeVisible().catch((error: unknown) => {
    throw new Error(`${String(error)}\nDelivery evidence: ${JSON.stringify({ requests, consoleErrors, failures, network })}`)
  })
  await expect(input).toHaveValue("只核查 KH 的同步入口，先别看归档")
  await send.click()
  await expect(input).toHaveValue("")
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]!.requestID).toBe(requests[0]!.requestID)
  expect(requests.every((request) => request.sessionID === children[0])).toBe(true)
  delivery = "delivered"
  await expect(composer.getByRole("status")).toContainText(/Delivered|已送达|配信済み/)

  delivery = "queued"
  await input.fill("只核查 KH 的同步入口，先别看归档")
  await send.click()
  await expect.poll(() => requests.length).toBe(3)
  expect(requests[2]!.requestID).not.toBe(requests[1]!.requestID)
  running = false
  await expect(composer.getByRole("status")).toContainText(/ended|已结束|終了/)
  await composer.getByRole("status").getByRole("button").click()
  await expect(input).toHaveValue("只核查 KH 的同步入口，先别看归档")
  await expect(send).toBeDisabled()
  await open(children[1]!)
  await expect(input).toBeVisible()
  await input.fill("B 的未发送草稿")
  await open(children[0]!)
  await expect(input).toHaveValue("只核查 KH 的同步入口，先别看归档")
  await open(children[1]!)
  await expect(input).toHaveValue("B 的未发送草稿")
  expect(requests).toHaveLength(3)
  expect(failures).toEqual([])
})
