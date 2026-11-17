// 260828 cc：sync 写入路径的三条不变量。既有的 index.test.ts 覆盖了 run/replay 的
// 正常流，但它的 layer 写死 experimentalWorkspaces: true，只验了 flag 开的那一半；
// 另外两条（JSON 往返闭合、投影豁免名单）此前没有任何断言。
import { describe, expect, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { EventV2 } from "@redcode-ai/core/event"
import { Bus } from "../../src/bus"
import { SyncEvent } from "../../src/sync"
import { Database, eq } from "@/storage/db"
import { EventSequenceTable, EventTable } from "../../src/sync/event.sql"
import { initProjectors, NON_PROJECTING_EVENT_TYPES } from "../../src/server/projectors"
import sessionProjectors, { toPartialRow } from "../../src/session/projectors"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const bind = (experimentalWorkspaces: boolean) =>
  testEffect(
    Layer.mergeAll(
      SyncEvent.layer.pipe(
        Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces })),
        Layer.provideMerge(Bus.layer),
      ),
      CrossSpawnSpawner.defaultLayer,
    ),
  )

// 默认配置（flag 关）与实验配置（flag 开）各绑一个 `it`。
const offIt = bind(false)
const onIt = bind(true)

beforeEach(() => {
  Database.close()
})

afterAll(() => {
  SyncEvent.reset()
  initProjectors()
})

function expectDefect<A, E, R>(effect: Effect.Effect<A, E, R>, pattern: RegExp) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (exit._tag === "Success") throw new Error("Expected effect to fail")
    expect(String(exit.cause)).toMatch(pattern)
  })
}

describe("SyncEvent invariants", () => {
  // ── 10. 序号的读与写必须同门控 ────────────────────────────────────────────
  //
  // `run()` 无条件读 event_sequence 算 seq。如果计数器行只在 experimentalWorkspaces
  // 打开时才写（默认关），每个事件的 seq 恒为 0，并被 GlobalBus 原样广播。
  describe("sequence gating", () => {
    function setup() {
      SyncEvent.reset()
      const Created = SyncEvent.define({
        type: "gate.created",
        version: 1,
        aggregate: "id",
        schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
      })
      SyncEvent.init({ projectors: [SyncEvent.project(Created, () => {})] })
      return { Created }
    }

    offIt.live(
      "advances seq per aggregate with workspaces disabled",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          yield* SyncEvent.use.run(Created, { id: "agg_1", name: "first" }, { publish: false })
          yield* SyncEvent.use.run(Created, { id: "agg_1", name: "second" }, { publish: false })
          yield* SyncEvent.use.run(Created, { id: "agg_1", name: "third" }, { publish: false })

          const row = Database.use((db) =>
            db
              .select({ seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, "agg_1"))
              .get(),
          )
          expect(row?.seq).toBe(2)
        }),
      ),
    )

    offIt.live(
      "keeps the full event log behind the workspaces flag",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          yield* SyncEvent.use.run(Created, { id: "agg_2", name: "first" }, { publish: false })

          // 计数器行始终写（它是 seq 的唯一真相），事件全文只在 flag 开时写。
          const sequences = Database.use((db) => db.select().from(EventSequenceTable).all())
          const events = Database.use((db) => db.select().from(EventTable).all())
          expect(sequences).toHaveLength(1)
          expect(events).toHaveLength(0)
        }),
      ),
    )

    offIt.live(
      "keeps per-aggregate counters independent",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Created } = setup()
          yield* SyncEvent.use.run(Created, { id: "agg_a", name: "a1" }, { publish: false })
          yield* SyncEvent.use.run(Created, { id: "agg_b", name: "b1" }, { publish: false })
          yield* SyncEvent.use.run(Created, { id: "agg_a", name: "a2" }, { publish: false })

          const rows = Database.use((db) =>
            db
              .select({ id: EventSequenceTable.aggregate_id, seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .all(),
          )
          expect(rows.sort((l, r) => l.id.localeCompare(r.id))).toEqual([
            { id: "agg_a", seq: 1 },
            { id: "agg_b", seq: 0 },
          ])
        }),
      ),
    )
  })

  // ── 2. 每个注册类型要么有 projector，要么在显式豁免名单里 ──────────────────
  //
  // 判据从 `def.type.includes("next")` 改成显式名单后，这里守住两件事：
  // 名单与实际缺口逐条相等；以及名字里带 "next" 不再是免死金牌。
  describe("projector coverage", () => {
    // 直接读生产来源（sessionProjectors + EventV2.registry），不读 SyncEvent.registry
    // ——后者是模块级可变 Map，reset() 不清空，会被同进程里其他测试定义的事件污染。
    const projected = new Set(sessionProjectors.map(([def]) => def.type))
    const declared = EventV2.registry
      .values()
      .toArray()
      .filter((entry) => entry.version !== undefined && entry.aggregate !== undefined)
      .map((entry) => entry.type)
    const exempt = new Set<string>(NON_PROJECTING_EVENT_TYPES)

    offIt.effect("declared EventV2 types are projected or explicitly exempt", () =>
      Effect.sync(() => {
        expect(declared.filter((type) => !projected.has(type) && !exempt.has(type))).toEqual([])
      }),
    )

    offIt.effect("the exemption list carries no dead entries", () =>
      Effect.sync(() => {
        const declaredSet = new Set(declared)
        expect([...exempt].filter((type) => projected.has(type) || !declaredSet.has(type))).toEqual([])
      }),
    )

    offIt.live(
      "throws when a projector is missing and the type is not exempt",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          SyncEvent.reset()
          const Orphan = SyncEvent.define({
            type: "orphan.created",
            version: 1,
            aggregate: "id",
            schema: Schema.Struct({ id: Schema.String }),
          })
          SyncEvent.init({ projectors: [] })

          yield* expectDefect(
            SyncEvent.use.run(Orphan, { id: "orphan_1" }, { publish: false }),
            /Projector not found for event: orphan\.created/,
          )
        }),
      ),
    )

    // 回归：旧判据是 `def.type.includes("next")`，所以任何名字里带 next 的事件
    // 都会静默跳过投影、持久化与发布。现在它必须和别的孤儿事件一样抛错。
    offIt.live(
      "a type whose name merely contains 'next' gets no free pass",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          SyncEvent.reset()
          const Nextish = SyncEvent.define({
            type: "plugin.nextcloud.synced",
            version: 1,
            aggregate: "id",
            schema: Schema.Struct({ id: Schema.String }),
          })
          SyncEvent.init({ projectors: [] })

          yield* expectDefect(
            SyncEvent.use.run(Nextish, { id: "next_1" }, { publish: false }),
            /Projector not found for event: plugin\.nextcloud\.synced/,
          )
        }),
      ),
    )

    offIt.live(
      "an exempt type is skipped without touching persistence",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          SyncEvent.reset()
          const Delta = SyncEvent.define({
            type: "gate.delta",
            version: 1,
            aggregate: "id",
            schema: Schema.Struct({ id: Schema.String }),
          })
          SyncEvent.init({ projectors: [], nonProjecting: ["gate.delta"] })

          yield* SyncEvent.use.run(Delta, { id: "delta_1" }, { publish: false })
          const sequences = Database.use((db) => db.select().from(EventSequenceTable).all())
          expect(sequences).toHaveLength(0)
        }),
      ),
    )
  })

  // ── 1. run 与 replay 必须看到同一份 data ──────────────────────────────────
  //
  // run() 把内存对象直接交给 projector；replay() 拿到的是 JSON 往返后的产物
  // （EventTable.data 或 HTTP body）。中间没有一次 Schema.encode/decode，所以任何
  // 不能 JSON 往返闭合的值都会让两条路径产生不同的投影，而且不报错。
  describe("run/replay data parity", () => {
    const Recorded = () => {
      const seen: unknown[] = []
      SyncEvent.reset()
      const Def = SyncEvent.define({
        type: "parity.written",
        version: 1,
        aggregate: "id",
        schema: Schema.Struct({
          id: Schema.String,
          title: Schema.optional(Schema.String),
          count: Schema.optional(Schema.Number),
        }),
      })
      SyncEvent.init({
        projectors: [SyncEvent.project(Def, (_db, data) => void seen.push(structuredClone(data)))],
      })
      return { Def, seen }
    }

    onIt.live(
      "the projector sees the same data through run and through replay",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Def, seen } = Recorded()

          const payload = { id: "parity_1", title: "kept", count: 3 }
          yield* SyncEvent.use.run(Def, payload, { publish: false })

          const row = Database.use((db) => db.select().from(EventTable).get())
          expect(row).toBeDefined()

          yield* SyncEvent.use.replay(
            {
              id: "evt_parity_replay",
              type: SyncEvent.versionedType(Def.type, Def.version),
              seq: 0,
              aggregateID: "parity_replay",
              // 走一次真实的 JSON 往返，模拟 HTTP body / EventTable 读回。
              data: JSON.parse(JSON.stringify({ ...payload, id: "parity_replay" })),
            },
            { publish: false },
          )

          expect(seen).toHaveLength(2)
          expect({ ...(seen[0] as Record<string, unknown>), id: "x" }).toEqual({
            ...(seen[1] as Record<string, unknown>),
            id: "x",
          })
        }),
      ),
    )

    // 这条是真正的护栏。显式 undefined 的成员在 run 路径上原样到达 projector，
    // 在 replay 路径上被 JSON.stringify 静默丢掉；projector 靠 `key in obj` 区分
    // 「清空该字段」和「不动该字段」（session/projectors.ts 的 grab），所以键在不在
    // 直接改变语义。run() 在入口拒掉这类输入，两条路径的输入因此按构造相同。
    // 分叉是真实存在且已知的：显式 undefined 的成员只有 run 路径的 projector 看得见。
    // 这条把它钉成"已知事实"而不是"没人发现"—— 谁要是哪天把它抹平了（比如在 run() 里
    // 统一 JSON 归一化），这条会红，提醒去检查依赖键存在性的 projector。
    //
    // 注：在 run() 入口统一拒掉显式 undefined 试过了，不成立 —— 本仓构造事件时把可选
    // 字段留成 undefined 是普遍写法，加那条 throw 会打挂 146 个既有测试。
    onIt.live(
      "an explicitly undefined member is visible to run and invisible to replay",
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const { Def, seen } = Recorded()

          yield* SyncEvent.use.run(Def, { id: "parity_2", title: undefined, count: 1 }, { publish: false })
          yield* SyncEvent.use.replay(
            {
              id: "evt_parity_undef",
              type: SyncEvent.versionedType(Def.type, Def.version),
              seq: 0,
              aggregateID: "parity_undef",
              data: JSON.parse(JSON.stringify({ id: "parity_undef", title: undefined, count: 1 })),
            },
            { publish: false },
          )

          expect(seen).toHaveLength(2)
          expect(Object.keys(seen[0] as object)).toContain("title")
          expect(Object.keys(seen[1] as object)).not.toContain("title")
        }),
      ),
    )

    // 上面那条分叉之所以没有咬到人，全靠这一个护栏：唯一一个用 `key in obj` 区分
    // 「清空」和「不动」的 projector（session/projectors.ts 的 grab）对显式 undefined
    // 直接抛错，要求改传 null。新增会做 `in` 判断的 projector 时必须照做。
    offIt.effect("the only key-presence-sensitive projector rejects explicit undefined", () =>
      Effect.sync(() => {
        expect(() => toPartialRow({ title: undefined })).toThrow(/pass `null` to clear a field/)
        // 键不存在 = 不动该字段，正常通过（这正是 replay 侧看到的形态）。
        expect(toPartialRow({}).title).toBeUndefined()
        // null = 清空，能 JSON 往返，两条路径一致。
        expect(toPartialRow({ title: null }).title).toBeNull()
      }),
    )
  })
})
