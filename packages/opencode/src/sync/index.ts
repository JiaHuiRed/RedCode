// Legacy sync event system. It should stay unaware of core EventV2 execution;
// the only temporary V2 coupling here is exposing versioned core event schemas
// in effectPayloads() so existing HTTP/SDK schema generation remains stable.
// Remove that registry read when event schemas are generated from core directly.
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { GlobalBus } from "@/bus/global"
import { Bus as ProjectBus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EventSequenceTable, EventTable } from "./event.sql"
import { EventID } from "./schema"
import { Context, Effect, Layer, Schema as EffectSchema } from "effect"
import type { DeepMutable } from "@redcode-ai/core/schema"
import { EventV2 } from "@redcode-ai/core/event"
import { serviceUse } from "@/effect/service-use"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EffectBridge } from "@/effect/bridge"

// Keep `Event["data"]` mutable because projectors mutate the persisted shape
// when writing to the database. Bus payloads (`Properties`) stay readonly —
// subscribers only read.

export type Definition<
  Type extends string = string,
  Schema extends EffectSchema.Top = EffectSchema.Top,
  BusSchema extends EffectSchema.Top = Schema,
> = {
  type: Type
  version: number
  aggregate: string
  schema: Schema
  // Bus event payload schema. Defaults to `schema` unless `busSchema` was
  // passed at definition time (see `session.updated`, whose projector
  // expands the persisted data to a `{ sessionID, info }` bus payload).
  properties: BusSchema
}

export type Event<Def extends Definition = Definition> = {
  id: string
  seq: number
  aggregateID: string
  data: DeepMutable<EffectSchema.Schema.Type<Def["schema"]>>
}

export type Properties<Def extends Definition = Definition> = EffectSchema.Schema.Type<Def["properties"]>

export type SerializedEvent<Def extends Definition = Definition> = Event<Def> & { type: string }

type ProjectorFunc = (db: Database.TxOrDb, data: unknown, event: Event) => void
type ConvertEvent = (type: string, data: Event["data"]) => unknown | Promise<unknown>

export interface Interface {
  readonly run: <Def extends Definition>(
    def: Def,
    data: Event<Def>["data"],
    options?: { publish?: boolean },
  ) => Effect.Effect<void>
  readonly replay: (event: SerializedEvent, options?: { publish: boolean; ownerID?: string }) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { publish: boolean; ownerID?: string },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SyncEvent") {}

export const layer = Layer.effect(Service)(
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const bus = yield* ProjectBus.Service

    const replay: Interface["replay"] = Effect.fn("SyncEvent.replay")(function* (event, options) {
      const def = registry.get(event.type)
      if (!def) {
        throw new Error(`Unknown event type: ${event.type}`)
      }

      const row = Database.use((db) =>
        db
          .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, event.aggregateID))
          .get(),
      )

      const latest = row?.seq ?? -1
      if (event.seq <= latest) return

      if (row?.ownerID && row.ownerID !== options?.ownerID) {
        return
      }

      const expected = latest + 1
      if (event.seq !== expected) {
        throw new Error(
          `Sequence mismatch for aggregate "${event.aggregateID}": expected ${expected}, got ${event.seq}`,
        )
      }

      const publish = !!options?.publish
      // Bridge captures handler-fiber refs (InstanceRef/WorkspaceRef) and the
      // full Effect context, so the forked publish + GlobalBus emit run with
      // the right state without a per-call attachWith.
      const bridge = yield* EffectBridge.make()
      process(def, event, {
        bus,
        bridge,
        publish,
        ownerID: options?.ownerID,
        experimentalWorkspaces: flags.experimentalWorkspaces,
      })
    })

    const replayAll: Interface["replayAll"] = Effect.fn("SyncEvent.replayAll")(function* (events, options) {
      const source = events[0]?.aggregateID
      if (!source) return undefined
      if (events.some((item) => item.aggregateID !== source)) {
        throw new Error("Replay events must belong to the same session")
      }
      const start = events[0].seq
      for (const [i, item] of events.entries()) {
        const seq = start + i
        if (item.seq !== seq) {
          throw new Error(`Replay sequence mismatch at index ${i}: expected ${seq}, got ${item.seq}`)
        }
      }
      for (const item of events) {
        yield* replay(item, options)
      }
      return source
    })

    const run: Interface["run"] = Effect.fn("SyncEvent.run")(function* (def, data, options) {
      const agg = (data as Record<string, string>)[def.aggregate]
      // This should never happen: we've enforced it via typescript in
      // the definition
      if (agg == null) {
        throw new Error(`SyncEvent.run: "${def.aggregate}" required but not found: ${JSON.stringify(data)}`)
      }

      if (def.version !== versions.get(def.type)) {
        throw new Error(`SyncEvent.run: running old versions of events is not allowed: ${def.type}`)
      }

      const { publish = true } = options || {}
      const bridge = yield* EffectBridge.make()

      // Note that this is an "immediate" transaction which is critical.
      // We need to make sure we can safely read and write with nothing
      // else changing the data from under us
      Database.transaction(
        (tx) => {
          const id = EventID.ascending()
          const row = tx
            .select({ seq: EventSequenceTable.seq })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, agg))
            .get()
          const seq = row?.seq != null ? row.seq + 1 : 0

          const event = { id, seq, aggregateID: agg, data }
          process(def, event, { bus, bridge, publish, experimentalWorkspaces: flags.experimentalWorkspaces })
        },
        {
          behavior: "immediate",
        },
      )
    })

    const remove: Interface["remove"] = Effect.fn("SyncEvent.remove")(function* (aggregateID) {
      Database.transaction((tx) => {
        tx.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
        tx.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
      })
    })

    const claim: Interface["claim"] = Effect.fn("SyncEvent.claim")((aggregateID, ownerID) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .update(EventSequenceTable)
            .set({ owner_id: ownerID })
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .run(),
        ),
      ),
    )

    return Service.of({
      run,
      replay,
      replayAll,
      remove,
      claim,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide([ProjectBus.defaultLayer, RuntimeFlags.defaultLayer]))

export const use = serviceUse(Service)

export const registry = new Map<string, Definition>()
let projectors: Map<string, ProjectorFunc> | undefined
let nonProjecting = new Set<string>()
const versions = new Map<string, number>()
let frozen = false
let convertEvent: ConvertEvent

export function reset() {
  frozen = false
  projectors = undefined
  nonProjecting = new Set()
  convertEvent = (_, data) => data
}

export function init(input: {
  projectors: Array<[Definition, ProjectorFunc]>
  // Event types that deliberately have no projector: streaming deltas and
  // progress notifications that carry no durable state. Keyed by unversioned
  // type, so a later version of the same event stays exempt. Anything not
  // listed here and not in `projectors` throws at `process()` — see
  // `test/sync/invariants.test.ts` for the set-equality gate that catches a new
  // event type whose projector was forgotten.
  nonProjecting?: readonly string[]
  convertEvent?: ConvertEvent
}) {
  projectors = new Map(input.projectors.map(([def, func]) => [versionedType(def.type, def.version), func]))
  nonProjecting = new Set(input.nonProjecting ?? [])
  for (let entry of EventV2.registry.values()) {
    if (!entry.version || !entry.aggregate) continue
    register({
      type: entry.type,
      version: entry.version,
      aggregate: entry.aggregate,
      properties: entry.data,
      schema: entry.data,
    })
  }

  // Install all the latest event defs to the bus. We only ever emit
  // latest versions from code, and keep around old versions for
  // replaying. Replaying does not go through the bus, and it
  // simplifies the bus to only use unversioned latest events
  for (let [type, version] of versions.entries()) {
    let def = registry.get(versionedType(type, version))!
    BusEvent.define(def.type, def.properties)
  }

  // Freeze the system so it clearly errors if events are defined
  // after `init` which would cause bugs
  frozen = true
  convertEvent = input.convertEvent ?? ((_, data) => data)
}

export function versionedType<A extends string>(type: A): A
export function versionedType<A extends string, B extends number>(type: A, version: B): `${A}/${B}`
export function versionedType(type: string, version?: number) {
  return version ? `${type}.${version}` : type
}

export function define<
  Type extends string,
  Agg extends string,
  Schema extends EffectSchema.Top,
  BusSchema extends EffectSchema.Top = Schema,
>(input: {
  type: Type
  version: number
  aggregate: Agg
  schema: Schema
  busSchema?: BusSchema
}): Definition<Type, Schema, BusSchema> {
  if (frozen) {
    throw new Error("Error defining sync event: sync system has been frozen")
  }

  const def = {
    type: input.type,
    version: input.version,
    aggregate: input.aggregate,
    schema: input.schema,
    properties: (input.busSchema ?? input.schema) as BusSchema,
  }

  register(def)

  return def
}

export function project<Def extends Definition>(
  def: Def,
  func: (db: Database.TxOrDb, data: Event<Def>["data"], event: Event<Def>) => void,
): [Definition, ProjectorFunc] {
  return [def, func as ProjectorFunc]
}

function register(def: Definition) {
  versions.set(def.type, Math.max(def.version, versions.get(def.type) || 0))
  registry.set(versionedType(def.type, def.version), def)
}

// 260828 cc：run() 与 replay() 的 data 不同源 —— run 把内存对象原样交给 projector，
// replay 拿到的是 JSON 往返之后的产物（EventTable.data 或 HTTP body）。显式 undefined
// 的成员只在前者可见，所以任何用 `key in obj` 区分「清空该字段」和「不动该字段」的
// projector，在两条路径上会得到不同的语义。
//
// 试过在 run() 入口统一拒掉显式 undefined：不成立 —— 本仓构造事件时把可选字段留成
// undefined 是普遍写法（如 session.created 的 info.workspaceID），加上这条 throw 会
// 打挂 146 个既有测试。所以这条契约只由**关心键存在性的 projector 自己**负责：
// session/projectors.ts 的 grab() 就是唯一一个，它对显式 undefined 直接抛错，要求改
// 传 null（null 能 JSON 往返，两条路径因此一致）。新增会 `in` 判断的 projector 时必须
// 照做，test/sync/invariants.test.ts 钉住了这条。

function process<Def extends Definition>(
  def: Def,
  event: Event<Def>,
  options: {
    bus: ProjectBus.Interface
    bridge: EffectBridge.Shape
    publish: boolean
    ownerID?: string
    experimentalWorkspaces: boolean
  },
) {
  if (projectors == null) {
    throw new Error("No projectors available. Call `SyncEvent.init` to install projectors")
  }

  const projector = projectors.get(versionedType(def.type, def.version))
  if (!projector) {
    // 260828 cc：这里原本是 `def.type.includes("next")` —— 名字含 "next" 就静默
    // 跳过投影、持久化与发布。护栏对着唯一在长的命名空间（session.next.*）关掉了，
    // 而且下一个名字里碰巧带 next 的事件会免费拿到同样的豁免。改成显式名单。
    if (!nonProjecting.has(def.type)) throw new Error(`Projector not found for event: ${def.type}`)
    return
  }

  Database.transaction((tx) => {
    projector(tx, event.data, event)

    // 260828 cc：序号的读与写必须同门控。`run()` 无条件读 event_sequence 算 seq，
    // 而这两条 insert 原本都在 experimentalWorkspaces 后面（默认关）—— 结果默认配置下
    // 每个事件的 seq 恒为 0，还被 GlobalBus 原样广播出去。计数器行很小（一个 aggregate
    // 一行三列），始终写；事件全文体积大且只有 workspace 同步要用，继续留在 flag 后面。
    // 副作用是好的：flag 中途打开时,对端会因 seq 从 N 起跳而抛 Sequence mismatch（响），
    // 而不是接受一条从 0 重新开始、缺掉全部历史的流（哑）。
    tx.insert(EventSequenceTable)
      .values({
        aggregate_id: event.aggregateID,
        seq: event.seq,
        owner_id: options?.ownerID,
      })
      .onConflictDoUpdate({
        target: EventSequenceTable.aggregate_id,
        set: { seq: event.seq },
      })
      .run()

    if (options.experimentalWorkspaces) {
      tx.insert(EventTable)
        .values({
          id: event.id,
          seq: event.seq,
          aggregate_id: event.aggregateID,
          type: versionedType(def.type, def.version),
          data: event.data as Record<string, unknown>,
        })
        .run()
    }

    Database.effect(() => {
      if (!options.publish) return
      const result = convertEvent(def.type, event.data)
      // The bridge was built inside the caller's fiber so it already carries
      // InstanceRef/WorkspaceRef and the full Effect context. Both the bus
      // publish and the GlobalBus emit run inside the forked Effect so they
      // share the same instance/workspace lookup.
      const publish = (data: unknown) =>
        options.bridge.fork(
          Effect.gen(function* () {
            yield* options.bus.publish(def, data as Properties<Def>, { id: event.id })
            const instance = yield* InstanceState.context
            const workspace = yield* InstanceState.workspaceID
            GlobalBus.emit("event", {
              directory: instance.directory,
              project: instance.project.id,
              workspace,
              payload: {
                type: "sync",
                syncEvent: {
                  type: versionedType(def.type, def.version),
                  ...event,
                },
              },
            })
          }),
        )
      if (result instanceof Promise) {
        void result.then(publish)
      } else {
        publish(result)
      }
    })
  })
}

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(type),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(def.aggregate),
          data: def.schema,
        }).annotate({ identifier: `SyncEvent.${type}` }),
      )
      .toArray(),
    ...EventV2.registry
      .values()
      .filter(
        (definition) =>
          definition.version !== undefined && !registry.has(versionedType(definition.type, definition.version)),
      )
      .map((definition) =>
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(versionedType(definition.type, definition.version!)),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(definition.aggregate!),
          data: definition.data,
        }).annotate({ identifier: `SyncEvent.${definition.type}` }),
      )
      .toArray(),
  ]
}

export * as SyncEvent from "."
