// Tier-A smoke tests for read-only commands. Each test asserts only that the
// command exits 0 and produces *some* output in the isolated harness env.
//
// These are not behavioral tests — they're the cheapest possible signal that
// the dependency-layer wiring (config load, DB init, server boot, provider
// resolution) doesn't crash for the broad class of "no inputs, no side
// effects" commands. A regression in any shared layer (an Effect.fail that
// propagates out of a service constructor, a renamed env var, a broken DB
// migration) will fail one or more of these tests.
//
// If a future change should make one of these commands intentionally fail in
// an empty env, update the assertion + add a note explaining the new contract.
//
// Speed: each test pays ~1.5s for bun startup. 7 tests serialize within this
// file. See script/prebuild-test-cli.ts for an opt-in pre-built binary that
// cuts per-spawn cost when this suite gets bigger.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { httpError } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

// doctor --json 的输出形状契约。顶层/嵌套键集合是给脚本和 issue 模板消费的公共面，
// 多一个未知键（或丢一个）都算破坏性变更 —— 所以断言「恰好这些键」，不是「包含这些键」。
type DoctorCheck = { name: string; status: string; detail: string }
type DoctorJson = {
  groups: { name: string; status: string; checks: DoctorCheck[] }[]
  tally: Record<string, number>
  checks: DoctorCheck[]
}

const STATUS = ["ok", "warn", "error", "skip"]

describe("redcode read-only commands (smoke)", () => {
  // `mcp list` reads MCP server config and pings each one. With the empty
  // REDCODE_CONFIG_CONTENT={} we provide, no servers should be configured
  // and the command should report that cleanly.
  cliIt.live(
    "mcp list: exits 0",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["mcp", "list"])
        redcode.expectExit(r, 0, "mcp list")
      }),
    60_000,
  )

  // `providers list` enumerates credentials + env-resolved providers.
  // (Not config-injected ones — those don't appear here by design.) The
  // Credentials header always renders; the Environment header only renders
  // when at least one provider env var is set, which the isolation harness
  // deliberately doesn't guarantee. Assert the always-present marker so the
  // test passes on a clean CI runner without env-var leakage.
  cliIt.live(
    "providers list: exits 0 and prints the credentials section",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["providers", "list"])
        redcode.expectExit(r, 0, "providers list")
        expect(r.stdout).toContain("Credentials")
      }),
    60_000,
  )

  // `models` lists models from configured providers. Our test/test-model
  // should appear because it's wired into the test provider config.
  cliIt.live(
    "models: exits 0 and lists the test model",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["models"])
        redcode.expectExit(r, 0, "models")
        expect(r.stdout).toContain("test/test-model")
      }),
    60_000,
  )

  // `agent list` walks the agent config. Empty config means no agents
  // configured; the command should still exit 0 with a "no agents" line or
  // similar. We don't pin the message — just exit cleanly.
  cliIt.live(
    "agent list: exits 0",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["agent", "list"])
        redcode.expectExit(r, 0, "agent list")
      }),
    60_000,
  )

  // `session list` reads the session DB. Fresh REDCODE_TEST_HOME means
  // empty DB. Exit 0 with no sessions.
  cliIt.live(
    "session list: exits 0",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["session", "list"])
        redcode.expectExit(r, 0, "session list")
      }),
    60_000,
  )

  // `stats` aggregates token usage from the session DB. Empty DB → all zeros.
  cliIt.live(
    "stats: exits 0",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["stats"])
        redcode.expectExit(r, 0, "stats")
      }),
    60_000,
  )

  // `db path` prints the DB file location. Under harness isolation the DB
  // resolves to SQLite's `:memory:` (no on-disk pollution between tests);
  // in production it'd be a path under REDCODE_TEST_HOME / XDG_DATA_HOME.
  // Accept either form — both prove the resolver ran without crashing.
  cliIt.live(
    "db path: exits 0 and prints a path or :memory:",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["db", "path"])
        redcode.expectExit(r, 0, "db path")
        expect(r.stdout.trim()).toMatch(/^(:memory:|[/\\].+\.(db|sqlite|sqlite3))$/i)
      }),
    60_000,
  )

  // 261109 Karina --json 形状契约：顶层 {groups, tally, checks}、组 {name, checks, status}、
  // 检查 {name, status, detail}、tally {ok, warn, error, skip} 且计数与 checks 一致 ——
  // 顶层与嵌套都不允许未知键混入。
  cliIt.live(
    "doctor --json: output shape has exactly the contract keys",
    ({ redcode }) =>
      Effect.gen(function* () {
        const r = yield* redcode.spawn(["doctor", "--json"])
        redcode.expectExit(r, 0, "doctor --json")
        const parsed = JSON.parse(r.stdout) as DoctorJson
        expect(Object.keys(parsed).sort()).toEqual(["checks", "groups", "tally"])
        expect(Object.keys(parsed.tally).sort()).toEqual(["error", "ok", "skip", "warn"])
        expect(parsed.tally.ok + parsed.tally.warn + parsed.tally.error + parsed.tally.skip).toBe(
          parsed.checks.length,
        )
        for (const group of parsed.groups) {
          expect(Object.keys(group).sort()).toEqual(["checks", "name", "status"])
          expect(STATUS).toContain(group.status)
          for (const check of group.checks) {
            expect(Object.keys(check).sort()).toEqual(["detail", "name", "status"])
            expect(STATUS).toContain(check.status)
          }
        }
        // 扁平 checks 与 groups 内嵌 checks 是同一集合
        expect(parsed.checks.length).toBe(parsed.groups.reduce((sum, g) => sum + g.checks.length, 0))
      }),
    60_000,
  )

  // 261109 Karina --probe happy path：fixture 的 provider test 指向进程内 TestLLMServer，
  // 排一行回复后探测应报 ok。enabled_providers 钉死候选 —— spawn 继承父进程环境，
  // 机器上若配了真实 provider key（env 型凭据），不钉就会对真实上游发起真实请求。
  cliIt.live(
    "doctor --probe: probes the test provider and reports ok",
    ({ llm, redcode }) =>
      Effect.gen(function* () {
        yield* llm.text("pong")
        const config = JSON.stringify({ ...testProviderConfig(llm.url), enabled_providers: ["test"] })
        const r = yield* redcode.spawn(["doctor", "--probe", "--json"], {
          timeoutMs: 90_000,
          env: { REDCODE_CONFIG_CONTENT: config },
        })
        redcode.expectExit(r, 0, "doctor --probe")
        const parsed = JSON.parse(r.stdout) as DoctorJson
        const probe = parsed.groups.find((g) => g.name === "probe")
        expect(probe).toBeDefined()
        expect(probe?.checks.find((c) => c.name === "model:test")).toMatchObject({
          status: "ok",
          detail: expect.stringContaining("ok via test-model"),
        })
        // fixture 配置没有 mcp 键：MCP 探测如实报 skip，不凑数
        expect(probe?.checks.find((c) => c.name === "mcp")).toMatchObject({ status: "skip" })
      }),
    90_000,
  )

  // 261109 Karina --probe 失败 path：上游 401 → model:test 记 error，且按 doctor 的
  // 「只有 error 才算失败」契约退出码 1。
  cliIt.live(
    "doctor --probe: reports a failing provider and exits 1",
    ({ llm, redcode }) =>
      Effect.gen(function* () {
        yield* llm.push(httpError(401, { error: "bad key" }))
        const config = JSON.stringify({ ...testProviderConfig(llm.url), enabled_providers: ["test"] })
        const r = yield* redcode.spawn(["doctor", "--probe", "--json"], {
          timeoutMs: 90_000,
          env: { REDCODE_CONFIG_CONTENT: config },
        })
        redcode.expectExit(r, 1, "doctor --probe failing")
        const parsed = JSON.parse(r.stdout) as DoctorJson
        const probe = parsed.groups.find((g) => g.name === "probe")
        expect(probe?.checks.find((c) => c.name === "model:test")?.status).toBe("error")
      }),
    90_000,
  )
})
