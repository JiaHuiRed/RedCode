import { describe, expect, test, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"
import { backfillSessionCostCurrency } from "@/data-migration"
import type { TxOrDb } from "@/storage/db"
import type { SessionID } from "@/session/schema"

let sqlite: Database

function migrations() {
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.split("_")[0]),
      sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf-8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

beforeAll(() => {
  sqlite = new Database(":memory:")
  migrate(drizzle({ client: sqlite }), migrations())
  sqlite.run(
    "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["project_1", "/tmp/project", "git", "project", 1, 1, "[]"],
  )
})

// 260930 Red 目录替身：deepseek-chat 记 CNY，其余查不到（走 USD 边界）
const currencyOf = (providerID: string, modelID: string): "USD" | "CNY" | undefined =>
  providerID === "deepseek" && modelID === "deepseek-chat" ? "CNY" : undefined

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function seed(
  sessionID: string,
  input: {
    providerID?: string
    modelID?: string
    parts: { id: string; data: Record<string, unknown> }[]
    session?: { cost?: number; cost_cny?: number | null; cost_usd?: number | null; time_updated?: number }
  },
) {
  sqlite.run(
    "INSERT INTO session (id, project_id, slug, directory, title, version, cost, cost_cny, cost_usd, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    [
      sessionID,
      "project_1",
      sessionID,
      "/tmp",
      sessionID,
      "0",
      input.session?.cost ?? 0,
      input.session?.cost_cny ?? null,
      input.session?.cost_usd ?? null,
      input.session?.time_updated ?? 1,
    ],
  )
  sqlite.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)", [
    `${sessionID}_msg`,
    sessionID,
    JSON.stringify({
      role: "assistant",
      providerID: input.providerID ?? "deepseek",
      modelID: input.modelID ?? "deepseek-chat",
      cost: input.parts.reduce((sum, part) => sum + Number(part.data.cost ?? 0), 0),
      tokens,
    }),
  ])
  for (const part of input.parts) {
    sqlite.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
      [part.id, `${sessionID}_msg`, sessionID, JSON.stringify(part.data)],
    )
  }
}

function backfill(sessionID: string) {
  return backfillSessionCostCurrency(db() as unknown as TxOrDb, [sessionID as SessionID], currencyOf)
}

function db() {
  return drizzle({ client: sqlite })
}

const sessionRow = (sessionID: string) =>
  sqlite.query("SELECT cost, cost_cny, cost_usd, time_updated FROM session WHERE id = ?").get(sessionID) as {
    cost: number
    cost_cny: number | null
    cost_usd: number | null
    time_updated: number
  }

const partData = (partID: string) =>
  JSON.parse((sqlite.query("SELECT data FROM part WHERE id = ?").get(partID) as { data: string }).data) as Record<
    string,
    unknown
  >

describe("session cost currency backfill (part-table rewrite)", () => {
  test("backfills legacy CNY part into CNY bucket and stamps part currency", () => {
    const s = "s_legacy_cny"
    seed(s, {
      parts: [{ id: `${s}_p1`, data: { type: "step-finish", cost: 50, tokens } }],
      session: { cost: 50, time_updated: 42 },
    })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })
    // 桶归位；time_updated 保持 42——回填不算会话活动
    expect(sessionRow(s)).toEqual({ cost: 50, cost_cny: 50, cost_usd: 0, time_updated: 42 })
    // 旧 part 拿到确定币种，此后 projector 的 revert 负冲抵走 CNY 桶
    expect(partData(`${s}_p1`).currency).toBe("CNY")
  })

  test("projector-first interleave: bucket already written is replaced by full part aggregate, legacy cost no longer lost", () => {
    const s = "s_race_projector_first"
    seed(s, {
      parts: [
        { id: `${s}_p_old`, data: { type: "step-finish", cost: 50, tokens } },
        { id: `${s}_p_new`, data: { type: "step-finish", cost: 1, tokens, currency: "CNY" } },
      ],
      // projector 已把新 part 的 1 记进 CNY 桶，旧 50 永远没人管——旧扫描集（双 NULL）就此漏掉该会话
      session: { cost: 51, cost_cny: 1 },
    })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })
    expect(sessionRow(s)).toEqual({ cost: 51, cost_cny: 51, cost_usd: 0, time_updated: 1 })
    expect(partData(`${s}_p_old`).currency).toBe("CNY")
    // 已有币种的 part 不动
    expect(partData(`${s}_p_new`)).toEqual({ type: "step-finish", cost: 1, tokens, currency: "CNY" })
  })

  test("migration-first interleave: later projector increment adds on top of backfilled bucket", () => {
    const s = "s_race_migration_first"
    seed(s, {
      parts: [{ id: `${s}_p1`, data: { type: "step-finish", cost: 50, tokens } }],
    })
    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })

    // 回填后 projector 写入新 part（带币种）：增量落在回填后的桶上
    sqlite.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 2, 2, ?)",
      [`${s}_p2`, `${s}_msg`, s, JSON.stringify({ type: "step-finish", cost: 1, tokens, currency: "CNY" })],
    )
    // 直接模拟 projector 的桶增量：coalesce 桶 + delta
    sqlite.run("UPDATE session SET cost_cny = coalesce(cost_cny, 0) + 1, cost = cost + 1 WHERE id = ?", [s])
    expect(sessionRow(s)).toEqual({ cost: 51, cost_cny: 51, cost_usd: 0, time_updated: 1 })
  })

  test("unknown model routes to USD bucket, stamps USD, counts unresolved", () => {
    const s = "s_unknown_model"
    seed(s, {
      providerID: "ghost",
      modelID: "ghost-mini",
      parts: [{ id: `${s}_p1`, data: { type: "step-finish", cost: 5, tokens } }],
    })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 1 })
    expect(sessionRow(s)).toEqual({ cost: 5, cost_cny: 0, cost_usd: 5, time_updated: 1 })
    expect(partData(`${s}_p1`).currency).toBe("USD")
  })

  test("zero-cost parts stay unstamped and contribute nothing", () => {
    const s = "s_free"
    seed(s, {
      parts: [{ id: `${s}_p1`, data: { type: "step-finish", cost: 0, tokens } }],
    })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })
    expect(sessionRow(s)).toEqual({ cost: 0, cost_cny: 0, cost_usd: 0, time_updated: 1 })
    expect(partData(`${s}_p1`).currency).toBeUndefined()
  })

  test("heals drifted scalar cost on sessions without parts", () => {
    const s = "s_no_parts"
    seed(s, { parts: [], session: { cost: 999, cost_cny: 30 } })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })
    expect(sessionRow(s)).toEqual({ cost: 0, cost_cny: 0, cost_usd: 0, time_updated: 1 })
  })

  test("mixed currencies stay in separate buckets without cross-currency sum", () => {
    const s = "s_mixed"
    seed(s, {
      parts: [
        { id: `${s}_p_cny`, data: { type: "step-finish", cost: 69.21, tokens } },
        { id: `${s}_p_usd`, data: { type: "step-finish", cost: 0.3, tokens, currency: "USD" } },
      ],
      session: { cost: 69.51, cost_cny: null, cost_usd: 0.3 },
    })

    expect(backfill(s)).toEqual({ attributed: 1, unresolved: 0 })
    const row = sessionRow(s)
    expect(row.cost).toBeCloseTo(69.51, 10)
    expect(row.cost_cny).toBeCloseTo(69.21, 10)
    expect(row.cost_usd).toBeCloseTo(0.3, 10)
    expect(row.time_updated).toBe(1)
  })
})
