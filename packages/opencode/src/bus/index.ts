import { Effect, Exit, Layer, PubSub, Scope, Context, Stream, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import * as Log from "@redcode-ai/core/util/log"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { serviceUse } from "@/effect/service-use"
import { Identifier } from "@/id/id"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "bus" })

// 260821 cc 事件总线的背压策略
//
// 原来 wildcard 与每个 typed 通道都是 PubSub.unbounded —— publish 永不阻塞，队列
// 没有上限。慢订阅者（断了但没清理的 SSE 连接、卡住的 renderer）会让事件无限堆积，
// 直到 OOM 把整个进程带走。这是冻结家族谱里"无界"那一支。
//
// 分类思路取自 codex app-server：按"丢了会怎样"决定策略，而不是一刀切。
//
//   wildcard —— 订阅者是 SSE 连接（每个已连客户端一条）和插件，生命周期不受本进程
//     控制，是唯一真正会失控的通道。改成 sliding：满了丢最旧的，publish 永不阻塞。
//     丢旧帧对 UI 是可恢复的（下一条状态会纠正），OOM 不可恢复 —— 严格优于 unbounded。
//
//   typed —— 订阅者全在进程内且即时消费（lsp 诊断、mcp 通知、github 进度、
//     session/llm.ts 的审批回调）。量小、消费快，不是失控源；且 permission.asked
//     这类"丢了就再也等不到人"的事件走这里，保守起见维持 unbounded。
//
// 明确不用 PubSub.bounded：它在满时挂起 publish，而 publish 是在会话主流程里 await 的，
// 那等于把"内存无界"换成"业务冻结" —— 用一个更难查的 bug 换掉当前这个。
//
// 丢弃不能是静默的：sliding 的 publish 不返回丢弃信号，所以用 sizeUnsafe 做高水位
// 告警，跨越阈值时 warn 一次、回落时 info 一次（不是每条都打，否则日志自己变成负载）。
/** 导出供 test/bus/bus.test.ts 的有界性回归测试引用，避免测试里写死魔数。 */
export const WILDCARD_CAPACITY = 4096
const WILDCARD_WARN_AT = Math.floor(WILDCARD_CAPACITY * 0.75)
const WILDCARD_RECOVER_AT = Math.floor(WILDCARD_CAPACITY * 0.25)

type BusProperties<D extends BusEvent.Definition<string, Schema.Top>> = Schema.Schema.Type<D["properties"]>

export const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  Schema.Struct({
    directory: Schema.String,
  }),
)

type Payload<D extends BusEvent.Definition = BusEvent.Definition> = {
  id: string
  type: D["type"]
  properties: BusProperties<D>
}

type State = {
  wildcard: PubSub.PubSub<Payload>
  typed: Map<string, PubSub.PubSub<Payload>>
  /** wildcard 是否已越过高水位；用来让告警只在跨越时打一次，而不是每条事件都打。 */
  wildcardSaturated: boolean
}

export interface Interface {
  readonly publish: <D extends BusEvent.Definition>(
    def: D,
    properties: BusProperties<D>,
    options?: { id?: string },
  ) => Effect.Effect<void>
  // subscribe / subscribeAll are eager: the underlying PubSub subscription is
  // acquired in the caller's Scope at `yield*` time. Any publish after the
  // yield is delivered, even if stream consumption starts later. The previous
  // Stream-returning shape acquired the subscription lazily on first pull,
  // opening a race window during which publishes were lost — see
  // test/bus/bus-effect.test.ts RACE tests.
  readonly subscribe: <D extends BusEvent.Definition>(
    def: D,
  ) => Effect.Effect<Stream.Stream<Payload<D>>, never, Scope.Scope>
  readonly subscribeAll: () => Effect.Effect<Stream.Stream<Payload>, never, Scope.Scope>
  readonly subscribeCallback: <D extends BusEvent.Definition>(
    def: D,
    callback: (event: Payload<D>) => unknown,
  ) => Effect.Effect<() => void>
  readonly subscribeAllCallback: (callback: (event: any) => unknown) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Bus") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("Bus.state")(function* (ctx) {
        const wildcard = yield* PubSub.sliding<Payload>(WILDCARD_CAPACITY)
        const typed = new Map<string, PubSub.PubSub<Payload>>()

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // Publish InstanceDisposed before shutting down so subscribers see it
            yield* PubSub.publish(wildcard, {
              type: InstanceDisposed.type,
              id: createID(),
              properties: { directory: ctx.directory },
            })
            yield* PubSub.shutdown(wildcard)
            for (const ps of typed.values()) {
              yield* PubSub.shutdown(ps)
            }
          }),
        )

        return { wildcard, typed, wildcardSaturated: false }
      }),
    )

    function getOrCreate<D extends BusEvent.Definition>(state: State, def: D) {
      return Effect.gen(function* () {
        let ps = state.typed.get(def.type)
        if (!ps) {
          // 维持 unbounded：typed 订阅者全在进程内且即时消费，量小；且
          // permission.asked 这类不可丢的事件走 typed。理由见文件顶部策略注释。
          ps = yield* PubSub.unbounded<Payload>()
          state.typed.set(def.type, ps)
        }
        return ps as unknown as PubSub.PubSub<Payload<D>>
      })
    }

    function publish<D extends BusEvent.Definition>(def: D, properties: BusProperties<D>, options?: { id?: string }) {
      return Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const payload: Payload = { id: options?.id ?? createID(), type: def.type, properties }
        log.info("publishing", { type: def.type })

        const ps = s.typed.get(def.type)
        if (ps) yield* PubSub.publish(ps, payload)
        yield* PubSub.publish(s.wildcard, payload)

        // wildcard 是 sliding：满了会静默丢最旧的一条。sliding 的 publish 不返回
        // 丢弃信号，所以在这里读一次 size 做高水位告警 —— 让"有订阅者跟不上"这件事
        // 在真正开始丢数据之前就可见，而不是事后从 UI 缺帧倒推。
        const backlog = PubSub.sizeUnsafe(s.wildcard)
        if (!s.wildcardSaturated && backlog >= WILDCARD_WARN_AT) {
          s.wildcardSaturated = true
          log.warn("wildcard subscriber falling behind", {
            backlog,
            capacity: WILDCARD_CAPACITY,
            type: def.type,
          })
        } else if (s.wildcardSaturated && backlog <= WILDCARD_RECOVER_AT) {
          s.wildcardSaturated = false
          log.info("wildcard drained", { backlog })
        }

        const dir = yield* InstanceState.directory
        const context = yield* InstanceState.context
        const workspace = yield* InstanceState.workspaceID

        GlobalBus.emit("event", {
          directory: dir,
          project: context.project.id,
          workspace,
          payload,
        })
      })
    }

    const subscribe = <D extends BusEvent.Definition>(
      def: D,
    ): Effect.Effect<Stream.Stream<Payload<D>>, never, Scope.Scope> =>
      Effect.gen(function* () {
        log.info("subscribing", { type: def.type })
        const s = yield* InstanceState.get(state)
        const ps = yield* getOrCreate(s, def)
        const subscription = yield* PubSub.subscribe(ps)
        yield* Effect.addFinalizer(() => Effect.sync(() => log.info("unsubscribing", { type: def.type })))
        return Stream.fromSubscription(subscription)
      })

    const subscribeAll = (): Effect.Effect<Stream.Stream<Payload>, never, Scope.Scope> =>
      Effect.gen(function* () {
        log.info("subscribing", { type: "*" })
        const s = yield* InstanceState.get(state)
        const subscription = yield* PubSub.subscribe(s.wildcard)
        yield* Effect.addFinalizer(() => Effect.sync(() => log.info("unsubscribing", { type: "*" })))
        return Stream.fromSubscription(subscription)
      })

    function on<T>(pubsub: PubSub.PubSub<T>, type: string, callback: (event: T) => unknown) {
      return Effect.gen(function* () {
        log.info("subscribing", { type })
        const bridge = yield* EffectBridge.make()
        const scope = yield* Scope.make()
        const subscription = yield* Scope.provide(scope)(PubSub.subscribe(pubsub))

        yield* Scope.provide(scope)(
          Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((msg) =>
              Effect.tryPromise({
                try: () => Promise.resolve().then(() => callback(msg)),
                catch: (cause) => {
                  log.error("subscriber failed", { type, cause })
                },
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          ),
        )

        return () => {
          log.info("unsubscribing", { type })
          bridge.fork(Scope.close(scope, Exit.void))
        }
      })
    }

    const subscribeCallback = Effect.fn("Bus.subscribeCallback")(function* <D extends BusEvent.Definition>(
      def: D,
      callback: (event: Payload<D>) => unknown,
    ) {
      const s = yield* InstanceState.get(state)
      const ps = yield* getOrCreate(s, def)
      return yield* on(ps, def.type, callback)
    })

    const subscribeAllCallback = Effect.fn("Bus.subscribeAllCallback")(function* (callback: (event: any) => unknown) {
      const s = yield* InstanceState.get(state)
      return yield* on(s.wildcard, "*", callback)
    })

    return Service.of({ publish, subscribe, subscribeAll, subscribeCallback, subscribeAllCallback })
  }),
)

export const defaultLayer = layer

const { runPromise, runSync } = makeRuntime(Service, layer)

// runSync is safe here because the subscribe chain (InstanceState.get, PubSub.subscribe,
// Scope.make, Effect.forkScoped) is entirely synchronous. If any step becomes async, this will throw.
export function createID() {
  return Identifier.create("evt", "ascending")
}

export async function publish<D extends BusEvent.Definition>(
  ctx: InstanceContext,
  def: D,
  properties: BusProperties<D>,
  options?: { id?: string },
) {
  return runPromise((svc) => svc.publish(def, properties, options).pipe(Effect.provideService(InstanceRef, ctx)))
}

export function subscribe<D extends BusEvent.Definition>(def: D, callback: (event: Payload<D>) => unknown) {
  return runSync((svc) => svc.subscribeCallback(def, callback))
}

export function subscribeAll(callback: (event: any) => unknown) {
  return runSync((svc) => svc.subscribeAllCallback(callback))
}

export * as Bus from "."
