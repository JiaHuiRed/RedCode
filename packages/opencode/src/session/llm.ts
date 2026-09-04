import { Provider } from "@/provider/provider"
import { serviceUse } from "@/effect/service-use"
import * as Log from "@redcode-ai/core/util/log"
import { Context, Duration, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import { streamText, wrapLanguageModel, type AssistantContent, type ModelMessage, type Tool } from "ai"
import { LLMEvent, Usage } from "@redcode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@redcode-ai/llm/route"
import type { LLMClientService } from "@redcode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

// 260818 Red response headers are exposed with provider-dependent casing and the legacy
// FreeLLMAPI name was `_routed_via`; normalize both forms before persisting the route marker.
export function routedVia(headers: HeadersInit | undefined) {
  const normalized = new Headers(headers)
  return normalized.get("x-routed-via") ?? normalized.get("_routed_via") ?? undefined
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const tResolveStart = performance.now()

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const tResolveEnd = performance.now()
      // 260727 Red 每次请求记录 resolve/prep 耗时到日志，排查 LLM 延迟时区分本地管线与服务端耗时
      l.info("llm.setup", {
        phase: "resolve",
        providerID: input.model.providerID,
        modelID: input.model.id,
        ms: Math.round(tResolveEnd - tResolveStart),
      })

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      const tPrepEnd = performance.now()
      l.info("llm.setup", {
        phase: "prep",
        providerID: input.model.providerID,
        modelID: input.model.id,
        ms: Math.round(tPrepEnd - tResolveEnd),
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via redcode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
              // 260807 Red v7: ToolExecutionOptions 新增必填 context（runtimeContext 载体），本仓不用，给空对象
              context: {},
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @redcode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
            "llm.native_unsupported_reason": native.reason,
          }),
        )
        l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
      }

      yield* Effect.logInfo("llm runtime selected").pipe(
        Effect.annotateLogs({
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        }),
      )
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      // 260803 Red DeepSeek 截断续写：max_tokens 撞顶（finish_reason=length）时，
      // withContinuation 会把已生成内容作为 assistant 前缀自动发起续写请求。
      const streamOnce = (msgs: ModelMessage[]) =>
        streamText({
          onError(error) {
            l.error("stream error", {
              error,
            })
          },
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              l.info("repairing tool call", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          // 260705 Red system 在 messages 里使用 {role: "system"} 是为了保持
          // HTTP 请求体结构稳定 → 云端 prefix cache key 不变 → 缓存命中率稳定。
          // AI SDK 6.x 检测到 system role 会 console.warn，显式置 true 关掉告警。
          // 260711 Red 全局共用的 {role: "system"} 模式，保持 HTTP 请求体结构稳定
          allowSystemInMessages: true,
          messages: msgs,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          // 260807 Red v7: TelemetryOptions 不再收 tracer —— OpenTelemetry 整体拆到 @ai-sdk/otel，
          // tracer 改为传给 OpenTelemetry 集成的构造函数并 registerTelemetry() 注册。当前
          // experimental.openTelemetry 开关只保留 isEnabled 语义；span 输出待接 @ai-sdk/otel
          // （见 docs/ai-sdk-v7-migration.md B 档 telemetry 条）。telemetryTracer 的会话标注
          // 逻辑随 tracer 一起悬置。
          // metadata 属性同样被移除（自定义标注改走集成层的 InferTelemetryEvent）
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
          },
        })
      return {
        type: "ai-sdk" as const,
        result: withContinuation(streamOnce, prepared.messages, input.model),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") return guardFirstEvent(result.stream, ctrl)

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            // 260624 Red AI SDK 的 .response 等整个流完成才 resolve（不是 HTTP 头），
            // 之前 await 它会阻塞流式输出并在网络异常时导致 NoOutputGeneratedError。
            // 改为异步捕获，不阻塞 fullStream 消费；终结事件再等待这个 promise，避免元数据
            // 在 finish 事件之后才到达，导致 routedVia 永远无法落库。
            state.routedViaPromise = Promise.resolve(result.result.response)
              .then((meta) => {
                state.routedVia = routedVia(meta.headers)
              })
              .catch(() => {})
            return guardFirstEvent(
              Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                e instanceof Error ? e : new Error(String(e)),
              ).pipe(
                Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                Stream.flatMap((events) => Stream.fromIterable(events)),
                // 260803 Red consumption protection: when the stream dies mid-flight the
                // provider usage chunk never arrives, so the session would bill zero cost
                // for a large aborted response. Emit an estimated step-finish before the
                // original failure propagates (processor taps it and books usage, then
                // halt runs as usual). Interruption passes through untouched so the
                // processor's onInterrupt -> abort path is preserved.
                Stream.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Stream.failCause(cause)
                    : Stream.fromIterable(estimatedFinishEvents(state)).pipe(Stream.concat(Stream.failCause(cause))),
                ),
              ),
              ctrl,
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

// 260816 Red 首事件超时兜底：LLM 出站请求此前没有任何超时——fetch 挂起就无限
// 等待，网络瞬断时用户只能干等（实测 184 秒无任何输出）。加 75s 首事件看门狗：
// "首事件" = 流开始产生任何 LLM 事件（≈ TTFT），正常响应十几二十秒，完全无感；
// 超时则先 abort 底层请求再报错，让会话层立刻看到结果，而不是无限挂起。
//
// 260903 cc 扩成**空闲看门狗**：原来那版是一次性的，`Stream.tap` 对流里**任何**元素
// 都会兑现 firstEvent，而协议层的第一个事件几乎立刻就到——看门狗一被满足，此后整条流
// 再无任何保护，中途静默就是无限挂起。
//
// 取证（260903，两个不同模型、同一签名）：`opencode-go/hy4-preview` 真题第 2 轮，末条
// assistant 消息**一个分片都没有**、`time.firstChunk` 空，却挂了 575 秒——首事件看门狗
// 本该在 75 秒时开火，说明它早被某个不产生分片的协议事件satisfied 掉了。同一模型第 3 轮
// 与 `muse-spark-1.3` 合成题第 2 轮则是另一种：分片有 step-start/reasoning/text/tool，
// 事件流到一半断掉，此前完全没有防线。两个模型都中 ⇒ 是传输层缺口，不是某家模型的毛病。
//
// 挂起率与任务重量强相关：7 步的任务 8 次挂 1 次，13–24 步的任务 4 次挂 3 次 ——
// 长会话正是日常形态，所以这条值得单独修。
export const FIRST_EVENT_TIMEOUT = Duration.seconds(75)

// 首事件之后，两个事件之间允许的最大静默。推理模型在思考段可能长时间不吐字，
// 所以给得比首事件更宽；它要挡的是"永远不再来"，不是"来得慢"。
export const IDLE_EVENT_TIMEOUT = Duration.seconds(120)

// 看门狗自己的轮询粒度。5s 足够精确（相对上面两个阈值），且空转成本可忽略。
const WATCHDOG_TICK = Duration.seconds(5)

export class FirstEventTimeoutError extends Error {
  readonly _tag = "FirstEventTimeoutError"
  constructor() {
    super("LLM 请求 75 秒内未收到首个响应事件（网络挂起或网关无响应），已中断")
    this.name = "FirstEventTimeoutError"
  }
}

export class StreamIdleTimeoutError extends Error {
  readonly _tag = "StreamIdleTimeoutError"
  constructor(readonly idleMs: number) {
    super(`LLM 流在中途静默 ${Math.round(idleMs / 1000)} 秒无新事件（网关停摆），已中断`)
    this.name = "StreamIdleTimeoutError"
  }
}

function guardFirstEvent<S, E>(
  stream: Stream.Stream<S, E>,
  ctrl: AbortController,
): Stream.Stream<S, E | FirstEventTimeoutError | StreamIdleTimeoutError> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const state = { last: Date.now(), seen: false, local: false }
      const timeoutSignal = yield* Deferred.make<never, FirstEventTimeoutError | StreamIdleTimeoutError>()
      // 看门狗 fiber：每 tick 比一次"距上一个事件多久"。超过当前档位的阈值就先 abort
      // 底层请求，再向 timeoutSignal 失败，merge 收到后让整体流失败。
      //
      // 不用 Effect.race 拼失败分支：v4 的 race 失败语义是"两边都失败才失败"，
      // 单边失败会继续等另一边，流就挂住了（260816 实测踩坑，勿改回去）。
      // 也不用 Stream.timeout —— 它掐的是整条流的总时长，长回答会被误杀。
      //
      // forkScoped：流的 scope 关闭时这个 fiber 一并被中断，正常结束不留空转。
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(WATCHDOG_TICK)
            // 260904 cc **本地在干活时不计时。** AI SDK 的工具执行跑在流内部：
            //   `tool-call` 之后到 `tool-result` 之前，流上一个事件都不会来。那段时间
            //   长短完全由本地决定——工具自己可以跑 10 分钟（bash 上限 600s、repo_clone
            //   300s），等用户点权限更没有上限。把它当成「网关停摆」是错的。
            //   实测代价：260904 一次外部目录授权，权限 02:26:20 弹出、用户还没点完，
            //   看门狗 120s 到点把整轮掐了（日志「静默 124 秒」），中断连带触发
            //   permission 的 replied 兜底，表现成「弹窗点了没反应、然后会话停摆」。
            //   看门狗要守的是「网关不再发」，不是「我们自己在忙」。
            if (state.local) continue
            const idle = Date.now() - state.last
            const limit = Duration.toMillis(state.seen ? IDLE_EVENT_TIMEOUT : FIRST_EVENT_TIMEOUT)
            if (idle < limit) continue
            ctrl.abort()
            yield* Deferred.fail(
              timeoutSignal,
              state.seen ? new StreamIdleTimeoutError(idle) : new FirstEventTimeoutError(),
            )
            return
          }
        }),
      )
      return Stream.merge(
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              state.last = Date.now()
              state.seen = true
              // tool-call 之后进入本地执行，tool-result / tool-error 回到等网关。
              // 只认这三个边界：其余事件（含 tool-input-*）都还在网关这一侧。
              const type = (event as { type?: string })?.type
              if (type === "tool-call") state.local = true
              else if (type === "tool-result" || type === "tool-error") state.local = false
            }),
          ),
        ),
        Stream.fromEffect(Deferred.await(timeoutSignal)),
        // either：任一边 halt（完成/失败）即整体终止——主流结束不挂等信号流，
        // 信号流失败立即让整体失败。
        { haltStrategy: "either" },
      )
    }),
  )
}

// 260803 Red consumption protection: estimate usage from streamed bytes when the
// stream fails before the provider usage chunk arrives. Reasonix-style estimate:
// ~4 bytes per token (see packages/llm/src/schema/events.ts visibleOutputTokens).
// Only emitted when output was actually produced — header-time failures estimate 0.
const estimatedFinishEvents = (state: ReturnType<typeof LLMAISDK.adapterState>): ReadonlyArray<LLMEvent> => {
  const textTokens = Math.ceil(state.textBytes / 4)
  const reasoningTokens = Math.ceil(state.reasoningBytes / 4)
  const completion = textTokens + reasoningTokens
  if (completion === 0) return []
  return [
    LLMEvent.stepFinish({
      index: state.step,
      reason: "unknown",
      usage: new Usage({
        outputTokens: completion,
        reasoningTokens: state.reasoningBytes > 0 ? reasoningTokens : undefined,
        totalTokens: completion,
      }),
    }),
  ]
}

// 260803 Red DeepSeek 截断续写。DeepSeek 长思考链 + 长正文容易撞 max_tokens 上限
// （finish_reason=length），输出被硬切。这里把已生成的 text/reasoning 作为 assistant
// 消息回传，自动发起下一轮请求续写，直到完整输出或达到续写次数上限。
// 只对 DeepSeek 家族生效；工具调用轮不续写（截断的工具调用交给 XML 打捞防线）。
const MAX_CONTINUATIONS = 2

export function isDeepSeekModel(model: Provider.Model): boolean {
  const id = model.api?.id?.toLowerCase() ?? model.id?.toLowerCase() ?? ""
  return id.includes("deepseek")
}

export function withContinuation(
  build: (msgs: ModelMessage[]) => ReturnType<typeof streamText>,
  messages: ModelMessage[],
  model: Provider.Model,
): Awaited<ReturnType<typeof streamText>> {
  if (!isDeepSeekModel(model)) return build(messages)

  const first = build(messages)
  const fullStream = (async function* () {
    let msgs = messages
    for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
      const result = round === 0 ? first : build(msgs)
      const texts: string[] = []
      const reasoning: string[] = []
      let sawToolCall = false
      let finishedWithLength = false
      for await (const event of result.fullStream) {
        switch (event.type) {
          case "text-delta":
            texts.push(event.text)
            break
          case "reasoning-delta":
            reasoning.push(event.text)
            break
          case "tool-input-start":
          case "tool-call":
            sawToolCall = true
            break
          case "finish":
            finishedWithLength = event.finishReason === "length"
            break
        }
        yield event
      }
      if (!finishedWithLength || sawToolCall || round === MAX_CONTINUATIONS) return
      if (!texts.length && !reasoning.length) return
      log.info("llm.continuation", {
        model: model.id,
        round: round + 1,
        textLen: texts.join("").length,
        reasoningLen: reasoning.join("").length,
      })
      const content: AssistantContent = []
      if (reasoning.length) content.push({ type: "reasoning", text: reasoning.join("") })
      if (texts.length) content.push({ type: "text", text: texts.join("") })
      msgs = [...msgs, { role: "assistant", content }]
    }
  })()
  // 消费方只用 AsyncIterable 语义（for await / Stream.fromAsyncIterable），
  // 自定义 generator 不实现 ReadableStream 方法，属故意 cast。
  return { ...first, fullStream: fullStream as unknown as typeof first.fullStream }
}

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export * as LLM from "./llm"
