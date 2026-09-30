import { Context, Effect, Layer } from "effect"
import { Database } from "./storage/db"
import { DataMigrationTable } from "./data-migration.sql"
import * as Log from "@redcode-ai/core/util/log"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Provider } from "@/provider/provider"
import type { ProviderID } from "@/provider/schema"
import { MessageTable, SessionTable } from "./session/session.sql"
import type { SessionID } from "./session/schema"

export type Migration<R = never> = {
  name: string
  run: Effect.Effect<void, unknown, R>
}

const log = Log.create({ service: "data-migration" })

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@redcode/DataMigration") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
   // 260930 Red 币种回填要读 Provider 目录（models.dev 原值 + CNY_PRICING 覆盖 +
   // config 声明的并集）——分桶的正确性是「写时刻定格」，回填只能按当前目录近似，
   // 无法命中的模型按 USD 并入桶并在汇总日志里计数，不静默。
   const provider = yield* Provider.Service
    const migrations: Migration[] = [
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
       name: "session_cost_currency_from_messages",
       run: Effect.gen(function* () {
         const providers = yield* provider.list()
         const currencyOf = (providerID: string, modelID: string) =>
           providers[providerID as ProviderID]?.models[modelID]?.cost?.currency

         let attributed = 0
         let unresolved = 0
         for (let cursor: SessionID | undefined, page = 1; ; page++) {
           const next = yield* Effect.gen(function* () {
             // 只扫未归属的旧行（两桶皆 NULL）。回填与 projector 写并发时以本迁移的
             // WHERE 兜底：projector 已写过任意一桶的行不在扫描集里，不会互相覆盖。
             const sessions = yield* Effect.sync(() =>
               Database.use((db) =>
                 db
                   .select({ id: SessionTable.id })
                   .from(SessionTable)
                   .where(
                     and(
                       cursor ? gt(SessionTable.id, cursor) : undefined,
                       sql`${SessionTable.cost_cny} is null and ${SessionTable.cost_usd} is null`,
                     ),
                   )
                   .orderBy(asc(SessionTable.id))
                   .limit(100)
                   .all(),
               ),
             )
             if (sessions.length === 0) return

             yield* Effect.sync(() =>
               Database.transaction((db) => {
                 // 消息级 cost 是该消息所有 step 之和，与 part 级增量等价；按
                 // session × provider × model 聚合后一次映射定桶，避免逐条查目录。
                 const rows = db
                   .select({
                     session_id: MessageTable.session_id,
                     provider_id: sql<string>`json_extract(${MessageTable.data}, '$.providerID')`,
                     model_id: sql<string>`json_extract(${MessageTable.data}, '$.modelID')`,
                     cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
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
                   .groupBy(
                     MessageTable.session_id,
                     sql`json_extract(${MessageTable.data}, '$.providerID')`,
                     sql`json_extract(${MessageTable.data}, '$.modelID')`,
                   )
                   .all()

                 const buckets = new Map<SessionID, { cny: number; usd: number; unresolved: boolean }>()
                 for (const row of rows) {
                   const entry = buckets.get(row.session_id) ?? { cny: 0, usd: 0, unresolved: false }
                   // 目录里找不到的模型按 USD 并入桶——与 projector 的边界一致；
                   // 但记下 unresolved，汇总日志按会话计数，不静默。
                   if (currencyOf(row.provider_id, row.model_id) === "CNY") entry.cny += row.cost
                   else {
                     entry.usd += row.cost
                     if (row.cost > 0) entry.unresolved = true
                   }
                   buckets.set(row.session_id, entry)
                 }

                 for (const session of sessions) {
                   const value = buckets.get(session.id) ?? { cny: 0, usd: 0, unresolved: false }
                   db.update(SessionTable)
                     .set({
                       cost_cny: value.cny,
                       cost_usd: value.usd,
                       time_updated: sql`${SessionTable.time_updated}`,
                     })
                     .where(
                       and(
                         eq(SessionTable.id, session.id),
                         sql`${SessionTable.cost_cny} is null and ${SessionTable.cost_usd} is null`,
                       ),
                     )
                     .run()
                   attributed += 1
                   if (value.unresolved) unresolved += 1
                 }
               }),
             )

             return sessions.at(-1)?.id
           }).pipe(
             Effect.withSpan("DataMigration.sessionCostCurrency.page", {
               attributes: {
                 "data_migration.name": "session_cost_currency_from_messages",
                 "data_migration.page": page,
                 "data_migration.cursor": cursor ?? "",
               },
             }),
           )
           if (!next) {
             // 汇总一行：回填了多少会话、其中多少吃了「目录查不到按 USD」的近似。
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
export const defaultLayer = layer.pipe(Layer.provide(Provider.defaultLayer))

export * as DataMigration from "./data-migration"
