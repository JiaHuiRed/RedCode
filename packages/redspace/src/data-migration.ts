import { Context, Effect, Layer } from "effect"
import { Database, type TxOrDb } from "./storage/db"
import { DataMigrationTable } from "./data-migration.sql"
import * as Log from "@redcode-ai/core/util/log"
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { Provider } from "@/provider/provider"
import type { ProviderID } from "@/provider/schema"
import { MessageTable, PartTable, SessionTable } from "./session/session.sql"
import type { SessionID } from "./session/schema"
import { Global } from "@redcode-ai/core/global"
import { migrateLegacySouls } from "@/soul/migration"
import path from "node:path"
import { Soul } from "@/soul"
import { saveSoulVersion } from "./session/soul"

export type Migration<R = never> = {
  name: string
  run: Effect.Effect<void, unknown, R>
}

const log = Log.create({ service: "data-migration" })
// 260930 Red 会话费用币种回填核心：以 part 表为权威源重算两桶并覆盖。
// step-finish part 的写入与桶增量在同一个事务（projectors.ts 的 PartUpdated
// projector），所以「part 聚合 == 桶投影终态」由事务原子性保证；本函数的聚合
// 与覆盖又由调用方包进同一个事务，SQLite 串行事务让两者与 projector 写天然
// 互斥，不存在「回填窗口内 projector 先写、会话永久退出扫描集」的丢账窗口。
// 覆盖式写入还顺带自愈桶与标量 cost 的历史漂移；无币种旧 part 的 currency 按
// 同一目录边界写回，此后 revert 的负冲抵落在正确桶里。
export function backfillSessionCostCurrency(
  tx: TxOrDb,
  sessionIDs: SessionID[],
  currencyOf: (providerID: string, modelID: string) => "USD" | "CNY" | undefined,
): { attributed: number; unresolved: number } {
  // part × message 聚合，按 会话 × 供应商 × 模型 × part币种 定币种，一次映射避免逐条查目录
  const rows = tx
    .select({
      session_id: PartTable.session_id,
      provider_id: sql<string>`json_extract(${MessageTable.data}, '$.providerID')`,
      model_id: sql<string>`json_extract(${MessageTable.data}, '$.modelID')`,
      part_currency: sql<string | null>`json_extract(${PartTable.data}, '$.currency')`,
      cost: sql<number>`coalesce(sum(coalesce(json_extract(${PartTable.data}, '$.cost'), 0)), 0)`,
    })
    .from(PartTable)
    .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
    .where(
      and(inArray(PartTable.session_id, sessionIDs), sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`),
    )
    .groupBy(
      PartTable.session_id,
      sql`json_extract(${MessageTable.data}, '$.providerID')`,
      sql`json_extract(${MessageTable.data}, '$.modelID')`,
      sql`json_extract(${PartTable.data}, '$.currency')`,
    )
    .all()

  const buckets = new Map<SessionID, { cny: number; usd: number; unresolved: boolean }>()
  for (const row of rows) {
    const entry = buckets.get(row.session_id) ?? { cny: 0, usd: 0, unresolved: false }
    // 已定格币种的 part 按自身走（与 projector 增量同界，目录后来改了也不改写历史）；
    // 无币种旧 part 才按目录近似。目录查不到按 USD；cost>0 才记 unresolved——
    // 免费模型的 0 账吃 USD 边界不算「未解析」，汇总日志不虚报
    const currency = row.part_currency ?? currencyOf(row.provider_id, row.model_id)
    if (currency === "CNY") entry.cny += row.cost
    else {
      entry.usd += row.cost
      if (row.cost > 0 && row.part_currency == null) entry.unresolved = true
    }
    buckets.set(row.session_id, entry)
  }

  let unresolved = 0
  for (const id of sessionIDs) {
    const value = buckets.get(id) ?? { cny: 0, usd: 0, unresolved: false }
    // 桶 = part 聚合（无条件覆盖），标量 cost = 两桶之和；time_updated 保持原值，
    // 回填不算会话活动
    tx.update(SessionTable)
      .set({
        cost: value.cny + value.usd,
        cost_cny: value.cny,
        cost_usd: value.usd,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, id))
      .run()
    if (value.unresolved) unresolved += 1
  }

  // 无币种旧 part 写回 currency（cost≠0 才动，+0 分片无桶差异）；此后 projector
  // 读 part 的 usage() 拿到确定币种，revert/负冲抵与桶边界一致。
  // part_currency 非空的组整体已有币种，整组跳过
  for (const row of rows) {
    if (row.part_currency != null || row.cost === 0) continue
    const currency = currencyOf(row.provider_id, row.model_id) ?? "USD"
    tx.update(PartTable)
      .set({ data: sql`json_set(${PartTable.data}, '$.currency', ${currency})` })
      .where(
        and(
          eq(PartTable.session_id, row.session_id),
          sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`,
          sql`json_extract(${PartTable.data}, '$.currency') is null`,
          sql`coalesce(json_extract(${PartTable.data}, '$.cost'), 0) != 0`,
          // 261003 Red 按当前 part 的消息主键查找，避免每组扫描全库；见 docs/notes/implemented/bug-fix/2026-10-03-cost-currency-migration-startup-scan.md。
          sql`exists (select 1 from ${MessageTable}
             where ${MessageTable.id} = ${PartTable.message_id}
               and json_extract(${MessageTable.data}, '$.providerID') = ${row.provider_id}
               and json_extract(${MessageTable.data}, '$.modelID') = ${row.model_id})`,
        ),
      )
      .run()
  }

  return { attributed: sessionIDs.length, unresolved }
}

// 261007 Red Legacy sessions are interpreted once; runtime identity never derives from client.
export function backfillSessionSoul(
  tx: TxOrDb,
  defaults: { tui?: string; desktop?: string },
  versions: Map<string, string> = new Map(),
): { assigned: number; unresolved: number } {
  const rows = tx
    .select({
      id: SessionTable.id,
      parent_id: SessionTable.parent_id,
      client: SessionTable.client,
      soul: SessionTable.soul,
      soul_body_hash: SessionTable.soul_body_hash,
    })
    .from(SessionTable)
    .all()
  const byID = new Map(rows.map((row) => [row.id, row]))
  const resolved = new Map<SessionID, string>()
  const resolvedHash = new Map<SessionID, string>()
  for (const row of rows) {
    if (row.soul) resolved.set(row.id, row.soul)
    if (row.soul_body_hash) resolvedHash.set(row.id, row.soul_body_hash)
  }
  const resolving = new Set<SessionID>()
  const resolve = (id: SessionID): { soul?: string; hash?: string } => {
    const row = byID.get(id)
    if (!row) return {}
    if (resolved.has(id)) {
      const soul = resolved.get(id)
      const pinnedHash = resolvedHash.get(id)
      if (pinnedHash || !soul) return { soul, hash: pinnedHash }
      if (resolving.has(id)) return { soul }
      resolving.add(id)
      const parent = row.parent_id ? resolve(row.parent_id) : {}
      resolving.delete(id)
      const hash = (parent.soul === soul ? parent.hash : undefined) ?? versions.get(soul)
      if (hash) resolvedHash.set(id, hash)
      return { soul, hash }
    }
    if (resolving.has(id)) return {}
    resolving.add(id)
    const parent = row.parent_id ? resolve(row.parent_id) : {}
    resolving.delete(id)
    const soul = parent.soul ?? (row.client === "desktop" ? defaults.desktop : row.client === "tui" ? defaults.tui : undefined)
    const hash = parent.hash ?? (soul ? versions.get(soul) : undefined)
    if (soul) resolved.set(id, soul)
    if (hash) resolvedHash.set(id, hash)
    return { soul, hash }
  }
  const pending = rows.filter((row) => !row.soul || !row.soul_body_hash)
  let assigned = 0
  for (const row of pending) {
    const result = resolve(row.id)
    const soul = row.soul ?? result.soul
    const hash = row.soul_body_hash ?? result.hash
    if ((!result.soul || row.soul) && (!result.hash || row.soul_body_hash)) continue
    tx.update(SessionTable)
      .set({
        soul,
        soul_body_hash: hash,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, row.id))
      .run()
    assigned++
  }
  const unresolved = rows.filter(
    (row) => !(row.soul ?? resolved.get(row.id)) || !(row.soul_body_hash ?? resolvedHash.get(row.id)),
  ).length
  return { assigned, unresolved }
}

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@redcode/DataMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 260930 Red 币种回填要读 Provider 目录（models.dev 原值 + CNY_PRICING 覆盖 +
    // config 声明的并集）——分桶的正确性是「写时刻定格」，回填只能按当前目录近似，
    // 无法命中的模型按 USD 并入桶并在汇总日志里计数，不静默。
    const provider = yield* Provider.Service
    const soulSvc = yield* Soul.Service
    const currentSoulVersions = Effect.fn("DataMigration.currentSoulVersions")(function* () {
      const versions = new Map<string, string>()
      for (const issue of yield* soulSvc.issues()) log.warn("soul unavailable during session backfill", issue)
      for (const summary of yield* soulSvc.list()) {
        const info = yield* soulSvc.get(summary.id)
        if (!info) {
          log.warn("soul missing during session backfill", { soulID: summary.id })
          continue
        }
        const hash = yield* Effect.sync(() => saveSoulVersion(info))
        if (hash) versions.set(summary.id, hash)
      }
      return versions
    })
    const migrations: Migration[] = [
      {
        name: "session_soul_from_client",
        run: Effect.gen(function* () {
          const migration = migrateLegacySouls(path.join(Global.Path.home, ".redcode", "souls"))
          for (const issue of migration.issues) log.warn(issue)
          const currentVersions = yield* currentSoulVersions()
          return Database.transaction((tx) => {
            const result = backfillSessionSoul(tx, migration.defaults, currentVersions)
            if (result.unresolved) log.warn("sessions without pinned soul version retained", { unresolved: result.unresolved })
          })
        }),
      },
      {
        name: "session_soul_body_from_registry",
        run: Effect.gen(function* () {
          const versions = yield* currentSoulVersions()
          const result = Database.transaction((tx) => backfillSessionSoul(tx, {}, versions))
          if (result.unresolved) log.warn("sessions without soul body snapshot retained", { unresolved: result.unresolved })
        }),
      },
      {
        name: "session_usage_from_messages",
        run: Effect.gen(function* () {
          type Usage = {
            cost: number
            tokens: {
              input: number
              output: number
              reasoning: number
              cache: { read: number; write: number; miss: number }
            }
          }

          for (let cursor: SessionID | undefined, page = 1; ; page++) {
            const next = yield* Effect.gen(function* () {
              const sessions = yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .select({ id: SessionTable.id })
                    .from(SessionTable)
                    .where(cursor ? gt(SessionTable.id, cursor) : undefined)
                    .orderBy(asc(SessionTable.id))
                    .limit(100)
                    .all(),
                ),
              )
              if (sessions.length === 0) return

              yield* Effect.sync(() =>
                Database.transaction((db) => {
                  const usageBySession = new Map<SessionID, Usage>(
                    sessions.map((session) => [
                      session.id,
                      { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } } },
                    ]),
                  )

                  for (const row of db
                    .select({
                      session_id: MessageTable.session_id,
                      cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
                      tokens_input: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0)), 0)`,
                      tokens_output: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0)), 0)`,
                      tokens_reasoning: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0)), 0)`,
                      tokens_cache_read: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0)), 0)`,
                      tokens_cache_write: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)), 0)`,
                    })
                    .from(MessageTable)
                    .where(
                      and(
                        inArray(
                          MessageTable.session_id,
                          sessions.map((session) => session.id),
                        ),
                        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
                      ),
                    )
                    .groupBy(MessageTable.session_id)
                    .all()) {
                    const current = usageBySession.get(row.session_id)
                    if (!current) continue
                    current.cost = row.cost
                    current.tokens.input = row.tokens_input
                    current.tokens.output = row.tokens_output
                    current.tokens.reasoning = row.tokens_reasoning
                    current.tokens.cache.read = row.tokens_cache_read
                    current.tokens.cache.write = row.tokens_cache_write
                  }

                  for (const [sessionID, value] of usageBySession) {
                    db.update(SessionTable)
                      .set({
                        cost: value.cost,
                        tokens_input: value.tokens.input,
                        tokens_output: value.tokens.output,
                        tokens_reasoning: value.tokens.reasoning,
                        tokens_cache_read: value.tokens.cache.read,
                        tokens_cache_write: value.tokens.cache.write,
                        time_updated: sql`${SessionTable.time_updated}`,
                      })
                      .where(eq(SessionTable.id, sessionID))
                      .run()
                  }
                }),
              )

              return sessions.at(-1)?.id
            }).pipe(
              Effect.withSpan("DataMigration.sessionUsage.page", {
                attributes: {
                  "data_migration.name": "session_usage_from_messages",
                  "data_migration.page": page,
                  "data_migration.cursor": cursor ?? "",
                },
              }),
            )
            if (!next) return
            cursor = next
            yield* Effect.sleep("10 millis")
          }
        }),
      },
      {
        name: "session_cost_currency_from_parts",
        run: Effect.gen(function* () {
          const providers = yield* provider.list()
          const currencyOf = (providerID: string, modelID: string) =>
            providers[providerID as ProviderID]?.models[modelID]?.cost?.currency

          // 260930 Red 旧版 session_cost_currency_from_messages 只扫「桶双 NULL」且按
          // 消息行聚合：projector 在回填窗口内写过任一桶的会话会永久退出扫描集，旧
          // 费用永远没人归位（attributed 还在 guard 未命中时虚增）。换名重跑——旧完成
          // 行不阻塞新迁移——改为全量重算 + 覆盖，权威源换成 part 表，事务原子性
          // 论证见 backfillSessionCostCurrency。
          let attributed = 0
          let unresolved = 0
          for (let cursor: SessionID | undefined, page = 1; ; page++) {
            const next = yield* Effect.gen(function* () {
              const sessions = yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .select({ id: SessionTable.id })
                    .from(SessionTable)
                    .where(cursor ? gt(SessionTable.id, cursor) : undefined)
                    .orderBy(asc(SessionTable.id))
                    .limit(100)
                    .all(),
                ),
              )
              if (sessions.length === 0) return

              const counted = yield* Effect.sync(() =>
                Database.transaction((tx) =>
                  backfillSessionCostCurrency(
                    tx,
                    sessions.map((session) => session.id),
                    currencyOf,
                  ),
                ),
              )
              attributed += counted.attributed
              unresolved += counted.unresolved

              return sessions.at(-1)?.id
            }).pipe(
              Effect.withSpan("DataMigration.sessionCostCurrency.page", {
                attributes: {
                  "data_migration.name": "session_cost_currency_from_parts",
                  "data_migration.page": page,
                  "data_migration.cursor": cursor ?? "",
                },
              }),
            )
            if (!next) {
              // 汇总一行：重算了多少会话、其中多少吃了「目录查不到按 USD」的近似
              log.info("session cost currency backfill done", { attributed, unresolved })
              return
            }
            cursor = next
            yield* Effect.sleep("10 millis")
          }
        }),
      },
    ]

    yield* Effect.gen(function* () {
      if (migrations.length === 0) return

      // Migrations run in a background fiber, so they must be resumable until
      // their completion row is written.
      for (const migration of migrations) {
        const completed = Database.use((db) =>
          db
            .select({ name: DataMigrationTable.name })
            .from(DataMigrationTable)
            .where(eq(DataMigrationTable.name, migration.name))
            .get(),
        )
        if (completed) continue

        log.info("running data migration", { name: migration.name })
        yield* migration.run.pipe(Effect.withSpan("DataMigration", { attributes: { name: migration.name } }))
        Database.use((db) =>
          db
            .insert(DataMigrationTable)
            .values({ name: migration.name, time_completed: Date.now() })
            .onConflictDoNothing()
            .run(),
        )
      }
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("failed to run data migrations").pipe(Effect.annotateLogs("cause", cause)),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )
    return Service.of({})
  }),
)

// 260930 Red Provider 依赖自供（本仓 defaultLayer 惯例：mergeAll 不做兄弟层消解）。
export const defaultLayer = layer.pipe(Layer.provide(Layer.mergeAll(Provider.defaultLayer, Soul.defaultLayer)))

export * as DataMigration from "./data-migration"
