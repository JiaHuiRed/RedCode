import { expect, test } from "@playwright/test"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { mockRedCodeServer } from "../utils/mock-server"
import { fixture } from "./session-timeline.fixture"

test("moves background activity into the composer when the left gutter is too narrow", async ({ page }) => {
  const session = fixture.sessions[0]!
  await mockRedCodeServer(page, { ...fixture, pageMessages: () => ({ items: [] }) })
  await page.route(
    (url) => url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && ["/background", "/pty", "/file"].includes(url.pathname),
    (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname === "/pty" ? [{ id: "pty_running", status: "running" }] : [],
        headers: { "access-control-allow-origin": "*" },
      }),
  )

  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(`/${base64Encode(fixture.directory)}/session/${session.id}`)
  const action = page.locator('[data-action="prompt-background"]')
  const composer = page.locator('[data-component="session-composer"]')
  const bounds = page.locator('[data-component="session-prompt-dock"]')
  await page.getByRole("button", { name: "Focus", exact: true }).click()
  await expect(action).toBeVisible()
  await expect(composer.locator(action)).toHaveCount(0)
  const [capsule, dock, input] = await Promise.all([action.boundingBox(), bounds.boundingBox(), composer.boundingBox()])
  expect(capsule!.x).toBeGreaterThanOrEqual(dock!.x)
  expect(capsule!.x + capsule!.width).toBeLessThan(input!.x)

  await page.getByRole("button", { name: "Build", exact: true }).click()
  await expect(composer.locator(action)).toBeVisible()

  await page.getByRole("button", { name: "Focus", exact: true }).click()
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(composer.locator(action)).toBeVisible()
  await expect(action).toHaveCount(1)
  await action.click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
