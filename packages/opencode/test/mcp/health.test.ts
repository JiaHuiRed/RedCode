import { expect, test } from "bun:test"
import { Effect } from "effect"
import { checkHealthCycle, type HealthFailure } from "../../src/mcp/health"

// 260913 Red 这里只验证独立健康检查 Effect，不加载实例、配置或数据库测试服务。
type Client = { request: (signal: AbortSignal) => Promise<unknown> }

function fixture(clients: Record<string, Client>) {
  const failures = new Map<string, HealthFailure<Client>>()
  const unhealthy: string[] = []
  const warnings: Array<[string, number]> = []
  return {
    failures,
    unhealthy,
    warnings,
    cycle: () =>
      checkHealthCycle({
        clients,
        failures,
        connected: () => true,
        request: (client, signal) => client.request(signal),
        unhealthy: (name) =>
          Effect.sync(() => {
            unhealthy.push(name)
            delete clients[name]
          }),
        warn: (name, count) => {
          warnings.push([name, count])
        },
        timeout: 5,
      }),
  }
}

test("MCP health failure survives later cycles and does not suppress other clients", () =>
  Effect.gen(function* () {
    let good = 0
    const input = fixture({
      bad: {
        request: async () => {
          throw new Error("offline")
        },
      },
      good: {
        request: async () => {
          good++
          return {}
        },
      },
    })
    for (let attempt = 0; attempt < 3; attempt++) yield* input.cycle()
    expect(good).toBe(3)
    expect(input.unhealthy).toEqual(["bad"])
    expect(input.warnings).toEqual([
      ["bad", 1],
      ["bad", 2],
      ["bad", 3],
    ])
  }).pipe(Effect.scoped, Effect.runPromise))

test("MCP successful probe resets consecutive failures", () =>
  Effect.gen(function* () {
    let offline = true
    const input = fixture({
      server: {
        request: async () => {
          if (offline) throw new Error("offline")
          return {}
        },
      },
    })
    yield* input.cycle()
    offline = false
    yield* input.cycle()
    expect(input.failures.size).toBe(0)
    offline = true
    yield* input.cycle()
    expect(input.failures.get("server")?.count).toBe(1)
    expect(input.unhealthy).toEqual([])
  }).pipe(Effect.scoped, Effect.runPromise))

test("MCP timeout cancels the request and keeps the cycle alive", () =>
  Effect.gen(function* () {
    let aborted = false
    const input = fixture({
      server: {
        request: (signal) =>
          new Promise(() => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
              },
              { once: true },
            )
          }),
      },
    })
    yield* input.cycle()
    expect(aborted).toBe(true)
    expect(input.failures.get("server")?.count).toBe(1)
  }).pipe(Effect.scoped, Effect.runPromise))

test("MCP delayed result cannot mark a replacement client unhealthy", () =>
  Effect.gen(function* () {
    const replacement: Client = { request: async () => ({}) }
    const clients: Record<string, Client> = {}
    clients.server = {
      request: async () => {
        clients.server = replacement
        throw new Error("old client")
      },
    }
    const input = fixture(clients)
    yield* input.cycle()
    expect(input.failures.size).toBe(0)
    expect(input.warnings).toEqual([])
    expect(clients.server).toBe(replacement)
  }).pipe(Effect.scoped, Effect.runPromise))
