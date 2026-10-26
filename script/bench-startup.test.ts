import { expect, test } from "bun:test"
import { hasCliStartupMarker, summarizeSamples, isHealthyResponse, withChildProcess } from "./bench-startup"

test("summarizes measured samples without including warmups", () => {
  expect(summarizeSamples([900], [5, 1, 9, 3])).toEqual({
    samples: [5, 1, 9, 3],
    min: 1,
    median: 4,
    average: 4.5,
    max: 9,
  })
})

test("server readiness requires a successful health payload", () => {
  expect(isHealthyResponse(200, { healthy: true, version: "0.13.1" })).toBe(true)
  expect(isHealthyResponse(200, { healthy: false, version: "0.13.1" })).toBe(false)
  expect(isHealthyResponse(503, { healthy: true, version: "0.13.1" })).toBe(false)
  expect(isHealthyResponse(200, { healthy: true })).toBe(false)
  expect(isHealthyResponse(200, undefined)).toBe(false)
})

test("empty CLI output is not a successful startup marker", () => {
  expect(hasCliStartupMarker("")).toBe(false)
  expect(hasCliStartupMarker(" \r\n ")).toBe(false)
  expect(hasCliStartupMarker("\n \n")).toBe(false)
  expect(hasCliStartupMarker("not a timer")).toBe(false)
  expect(hasCliStartupMarker("Infinity")).toBe(false)
  expect(hasCliStartupMarker("123.5\n")).toBe(true)
})

test("timeout terminates and awaits only the child created by the benchmark", async () => {
  let child: Bun.Subprocess | undefined
  let childExited = false
  const command = [process.execPath, "-e", "setInterval(() => {}, 1000)"]

  const result = withChildProcess(command, { cwd: process.cwd(), timeoutMs: 100 }, async (started) => {
    child = started
    void started.exited.then(() => (childExited = true))
    await new Promise<never>(() => {})
  }).then(
    () => "resolved",
    (error: unknown) => (error instanceof Error && /timed out/.test(error.message) ? "timed out" : "failed"),
  )
  await expect(Promise.race([result, Bun.sleep(300).then(() => "still waiting")])).resolves.toBe("timed out")

  expect(child).toBeDefined()
  if (!child) throw new Error("benchmark did not start its child process")
  expect(childExited).toBe(true)
  expect(await child.exited).not.toBe(0)
})

test("cancellation terminates its child without waiting for an uncooperative action", async () => {
  const controller = new AbortController()
  let child: Bun.Subprocess | undefined
  let childExited = false
  const result = withChildProcess(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { cwd: process.cwd(), timeoutMs: 30000, signal: controller.signal },
    async (started) => {
      child = started
      void started.exited.then(() => (childExited = true))
      await new Promise<never>(() => {})
    },
  ).then(
    () => "resolved",
    (error: unknown) => (error instanceof Error && /cancelled/.test(error.message) ? "cancelled" : "failed"),
  )
  setTimeout(() => controller.abort(), 50)
  await expect(Promise.race([result, Bun.sleep(300).then(() => "still waiting")])).resolves.toBe("cancelled")

  expect(child).toBeDefined()
  if (!child) throw new Error("benchmark did not start its child process")
  expect(childExited).toBe(true)
  expect(await child.exited).not.toBe(0)
})
