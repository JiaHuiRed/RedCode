import crypto from "crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import * as Log from "@redcode-ai/core/util/log"
import { LLMEvent, type Usage } from "@redcode-ai/llm"
import type { Provider } from "@/provider/provider"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"
import { ConfigRequestEvidence } from "@/config/request-evidence"

const log = Log.create({ service: "request-evidence" })
const transportScope = new AsyncLocalStorage<{
  observer: Pick<Observer, "capture"> & Partial<Pick<Observer, "transport">>
  requestID: string
  actualCapture?: CaptureObservation
}>()
// 261007 Red 进程内匿名关联：不保存账号、端点或缓存亲和键原文，也不跨重启追踪身份。
const identitySalt = crypto.randomBytes(32)

export type Runtime = "ai-sdk" | "native"

export type Context = {
  readonly sessionID: string
  readonly modelKey: string
  readonly runtime: Runtime
  readonly model?: Provider.Model
}

type Entry = {
  readonly sha256: string
  readonly length: number
}

type Sequence = {
  readonly entries: readonly Entry[]
  readonly sha256: string
  readonly length: number
}

type SectionObservation = {
  readonly sha256: string
  readonly count: number
  readonly length: number
  readonly change: "baseline" | "unchanged" | "append" | "rewind" | "rewrite"
  readonly difference?: {
    readonly index: number
    readonly previous?: Entry
    readonly current?: Entry
  }
}

type Compression = {
  readonly blockCount: number
  readonly inputTokensEstimated: number
  readonly summaryTokensEstimated: number
  readonly netSavingsEstimated: number
}

type Fingerprint = {
  readonly system: Sequence
  readonly tools: Sequence
  readonly history: Sequence
  readonly parameters: Sequence
  readonly serialized: Entry
  // 261006 Red whole-wire 只留 sha256 + length：跨段相对顺序变了但两段各自不变时，
  // section diff 全是 unchanged，只有这条能证明重排真的发生过
  readonly wire: {
    readonly sha256: string
    readonly length: number
  }
}

type Bucket = {
  fingerprint?: Fingerprint
  pending: Map<string, Compression>
}

export type CaptureObservation =
  | {
      readonly status: "captured"
      readonly requestID: string
      readonly system: SectionObservation
      readonly tools: SectionObservation
      readonly history: SectionObservation
      readonly parameters: SectionObservation
      readonly serialized: Entry & { readonly change: "baseline" | "unchanged" | "changed" }
      readonly affinity: Readonly<Record<string, string>>
      readonly wire: {
        readonly sha256: string
        readonly length: number
        readonly change: "baseline" | "unchanged" | "changed"
      }
      readonly afterCompression: readonly Compression[]
    }
  | {
      readonly status: "unsupported"
      readonly requestID: string
      readonly reason: "body-too-large" | "body-unavailable" | "invalid-json" | "unsupported-shape" | "message-limit" | "field-limit"
    }

export type EventObservation =
  | {
      readonly type: "usage"
      readonly usageStatus: "reported" | "output-only-estimated" | "missing"
      readonly rawUsage?: Readonly<Record<string, number>>
      readonly cache: {
        readonly status: "reported" | "unknown"
        readonly cacheReadInputTokens?: number
        readonly cacheWriteInputTokens?: number
      }
      readonly lastCompression?: Compression
    }
  | ({
      readonly type: "compression"
      readonly status: "recorded"
    } & Compression)
  | {
      readonly type: "compression"
      readonly status: "invalid" | "metadata-unavailable"
    }

export type Observer = {
  readonly limits: ConfigRequestEvidence.Limits
  capture(body: unknown, source?: "adapter" | "transport"): CaptureObservation
  event(event: LLMEvent): EventObservation | undefined
  transport(input: TransportInput, requestID: string): TransportObservation
}

export type TransportInput = {
  readonly accountID?: string
  readonly endpoint: string
  readonly responseRequestID?: string
  readonly status?: number
  readonly body?: unknown
}

export type TransportObservation = {
  readonly requestID: string
  readonly accountHash?: string
  readonly endpointHash: string
  readonly responseRequestHash?: string
  readonly status?: number
}

type RecordValue = Record<string, unknown>

const buckets = new Map<string, Bucket>()
const evictor = sessionEvictor({
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
  drop: (key) => (buckets.delete(key) ? 1 : 0),
})

function record(message: string, fields: Record<string, unknown>) {
  try {
    log.info(message, fields)
  } catch {
    // 261004 Red Log sink failures must not change provider request or stream behavior.
  }
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function serialize(value: unknown): string | undefined {
  // 261004 Red Diagnostic serialization must never interfere with provider dispatch.
  try {
    return JSON.stringify(value)
  } catch {
    // 261004 Red Cyclic or throwing non-wire values are unsupported; the request still proceeds untouched.
    return undefined
  }
}

function parse(text: string): unknown {
  // 261004 Red Invalid diagnostic JSON must not change request behavior.
  try {
    return JSON.parse(text) as unknown
  } catch {
    // 261004 Red Unparseable provider bodies are unsupported without retaining their contents.
    return undefined
  }
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function identity(text: string): string {
  return crypto.createHmac("sha256", identitySalt).update(text).digest("hex")
}

function entry(value: unknown): Entry | undefined {
  const text = serialize(value)
  if (text === undefined) return undefined
  return { sha256: hash(text), length: Buffer.byteLength(text, "utf8") }
}

function sequence(values: readonly unknown[], cache: Map<unknown, Entry>): Sequence | undefined {
  // 261007 Red section 与 wire 共用条目；只在本次捕获内缓存 hash，避免长消息重复序列化。
  const entries = values.map((value) => {
    const known = cache.get(value) ?? entry(value)
    if (known) cache.set(value, known)
    return known
  })
  if (entries.some((value) => value === undefined)) return undefined
  const known = entries as Entry[]
  return {
    entries: known,
    sha256: hash(known.map((value) => value.sha256).join("")),
    length: known.reduce((total, value) => total + value.length, 0),
  }
}

function transition(previous: Sequence | undefined, current: Sequence): SectionObservation {
  if (!previous)
    return {
      sha256: current.sha256,
      count: current.entries.length,
      length: current.length,
      change: "baseline",
    }

  let index = 0
  while (
    index < Math.min(previous.entries.length, current.entries.length) &&
    previous.entries[index]?.sha256 === current.entries[index]?.sha256
  ) {
    index++
  }
  const same = index === previous.entries.length && index === current.entries.length
  const change = same
    ? "unchanged"
    : index === previous.entries.length
      ? "append"
      : index === current.entries.length
        ? "rewind"
        : "rewrite"
  const before = previous.entries[index]
  const after = current.entries[index]
  return {
    sha256: current.sha256,
    count: current.entries.length,
    length: current.length,
    change,
    ...(same
      ? {}
      : {
          difference: {
            index,
            ...(before ? { previous: before } : {}),
            ...(after ? { current: after } : {}),
          },
        }),
  }
}

function project(body: RecordValue):
  | {
      readonly system: readonly unknown[]
      readonly tools: readonly unknown[]
      readonly history: readonly unknown[]
      readonly messageCount: number
      readonly wire: readonly unknown[]
    }
  | undefined {
  const system: unknown[] = []
  const history: unknown[] = []
  // 261006 Red wire 与 system/history 共享同一批 {field, value} 条目、按遭遇顺序排列：
  // system 字段在前，messages 按原数组序（无论落进哪段），tools 在末。分家进 section 之后
  // 相对顺序就丢了，wire 补的正是这部分信息；只参与 hash，不额外存正文
  const wire: unknown[] = []
  for (const field of ["system", "instructions", "system_instruction", "systemInstruction"]) {
    if (!Object.hasOwn(body, field) || body[field] === undefined) continue
    const value = body[field]
    if (Array.isArray(value)) {
      if (value.length === 0) system.push({ field, empty: true })
      else system.push(...value.map((item) => ({ field, value: item })))
      continue
    }
    system.push({ field, value })
  }
  wire.push(...system)

  let source: unknown
  let sourceField: string
  if (Object.hasOwn(body, "messages")) {
    source = body.messages
    sourceField = "messages"
  } else if (Object.hasOwn(body, "input")) {
    source = body.input
    sourceField = "input"
  } else if (Object.hasOwn(body, "contents")) {
    source = body.contents
    sourceField = "contents"
  } else return

  const messageCount = Array.isArray(source) ? source.length : 1
  if (typeof source === "string") {
    const item = { field: sourceField, value: source }
    history.push(item)
    wire.push(item)
  } else if (Array.isArray(source)) {
    for (const item of source) {
      const role = isRecord(item) ? item.role : undefined
      const projected = { field: sourceField, value: item }
      if (role === "system" || role === "developer") system.push(projected)
      else history.push(projected)
      wire.push(projected)
    }
  } else return

  let tools: unknown[] = []
  if (body.tools !== undefined) {
    const definitions = body.tools
    if (Array.isArray(definitions)) tools = definitions
    else if (isRecord(definitions)) {
      tools = Object.keys(definitions)
        .map((name) => ({ name, definition: definitions[name] }))
    } else return
  }

  wire.push(...tools)

  return {
    system,
    tools,
    history,
    messageCount,
    wire,
  }
}

function compression(value: unknown): Compression | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    // 261004 Red DCP allocateRunId 返回数字；校验口径必须与插件实际回执一致。
    !Number.isSafeInteger(value.runId) ||
    (value.runId as number) < 0
  )
    return
  const blockCount = value.blockCount
  const inputTokensEstimated = value.inputTokensEstimated
  const summaryTokensEstimated = value.summaryTokensEstimated
  const netSavingsEstimated = value.netSavingsEstimated
  if (
    !Number.isSafeInteger(blockCount) ||
    !Number.isSafeInteger(inputTokensEstimated) ||
    !Number.isSafeInteger(summaryTokensEstimated) ||
    !Number.isSafeInteger(netSavingsEstimated) ||
    (blockCount as number) < 0 ||
    (inputTokensEstimated as number) < 0 ||
    (summaryTokensEstimated as number) < 0 ||
    (netSavingsEstimated as number) !== (inputTokensEstimated as number) - (summaryTokensEstimated as number)
  )
    return
  return {
    blockCount: blockCount as number,
    inputTokensEstimated: inputTokensEstimated as number,
    summaryTokensEstimated: summaryTokensEstimated as number,
    netSavingsEstimated: netSavingsEstimated as number,
  }
}

function usageFields(usage: Usage | undefined): Readonly<Record<string, number>> | undefined {
  if (!usage) return
  const fields = (
    [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "nonCachedInputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "reasoningTokens",
    ] as const
  ).reduce<Record<string, number>>((result, key) => {
    const value = usage[key]
    if (value !== undefined) result[key] = value
    return result
  }, {})
  return Object.keys(fields).length > 0 ? fields : undefined
}

// 261004 Red 收窄返回类型，status 才能作为可判别字段（usage 变体没有 status）。
type CompressionObservation = Extract<EventObservation, { type: "compression" }>

function observeCompression(
  bucket: Bucket,
  event: Extract<LLMEvent, { type: "tool-result" }>,
  maxPending: number,
): CompressionObservation | undefined {
  const wrapped = event.result.value
  const metadata = isRecord(wrapped) ? wrapped.metadata : undefined
  const candidate = isRecord(metadata) ? metadata.nativeCompression ?? metadata.dcpCompression : undefined
  if (!candidate) return { type: "compression", status: "metadata-unavailable" }
  const value = compression(candidate)
  if (!value) return { type: "compression", status: "invalid" }
  bucket.pending.delete(event.id)
  bucket.pending.set(event.id, value)
  while (bucket.pending.size > maxPending) {
    const oldest = bucket.pending.keys().next().value
    if (oldest === undefined) break
    bucket.pending.delete(oldest)
  }
  return { type: "compression", status: "recorded", ...value }
}

export function create(context: Context, limits = ConfigRequestEvidence.resolve()): Observer {
  const sessionID = context.sessionID
  const modelKey = context.modelKey
  const runtime = context.runtime
  const id = JSON.stringify([sessionID, modelKey, runtime])
  let requestID = ""
  let lastCompression: Compression | undefined
  const common = () => ({
    sessionID,
    modelKey,
    runtime,
    requestID,
  })

  const observer: Observer = {
    limits,
    capture(body, source = "adapter") {
      const scoped = transportScope.getStore()
      if (scoped?.observer === observer && scoped.actualCapture && source !== "transport") return scoped.actualCapture
      requestID = scoped?.observer === observer ? scoped.requestID : crypto.randomUUID()
      const bucket = buckets.get(id) ?? { pending: new Map<string, Compression>() }
      buckets.set(id, bucket)
      evictor.touch(id)
      if (body instanceof Uint8Array && body.byteLength > limits.maxBodyBytes) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "body-too-large" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const bodyText = typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : serialize(body)
      if (bodyText === undefined) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "body-unavailable" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      if (bodyText.length > limits.maxBodyBytes || Buffer.byteLength(bodyText, "utf8") > limits.maxBodyBytes) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "body-too-large" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const decoded = parse(bodyText)
      if (!isRecord(decoded)) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "invalid-json" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const fields = Object.keys(decoded)
      if (fields.length > limits.maxMessages) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "field-limit" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const projected = project(decoded)
      if (!projected) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "unsupported-shape" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      if (projected.messageCount > limits.maxMessages) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "message-limit" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      if (projected.system.length > limits.maxMessages || projected.tools.length > limits.maxMessages) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "field-limit" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const cache = new Map<unknown, Entry>()
      const system = sequence(projected.system, cache)
      const tools = sequence(projected.tools, cache)
      const history = sequence(projected.history, cache)
      const wire = sequence(projected.wire, cache)
      const parameters = sequence(
        fields.filter((field) => ![
          "system", "instructions", "system_instruction", "systemInstruction", "messages", "input", "contents", "tools",
        ].includes(field)).map((field) => ({ field, value: decoded[field] })),
        cache,
      )
      if (!system || !tools || !history || !wire || !parameters) {
        const observation: CaptureObservation = { status: "unsupported", requestID, reason: "unsupported-shape" }
        record("request.prefix", { ...common(), ...observation })
        return observation
      }
      const current: Fingerprint = {
        system, tools, history, parameters,
        serialized: { sha256: hash(bodyText), length: Buffer.byteLength(bodyText, "utf8") },
        wire: { sha256: wire.sha256, length: wire.length },
      }

      const previous = bucket.fingerprint
      const afterCompression = [...bucket.pending.values()]
      bucket.pending.clear()
      bucket.fingerprint = current
      const observation: CaptureObservation = {
        status: "captured",
        requestID,
        system: transition(previous?.system, current.system),
        tools: transition(previous?.tools, current.tools),
        history: transition(previous?.history, current.history),
        parameters: transition(previous?.parameters, current.parameters),
        serialized: {
          ...current.serialized,
          change: previous
            ? previous.serialized.sha256 === current.serialized.sha256 ? "unchanged" : "changed"
            : "baseline",
        },
        affinity: Object.fromEntries(
          ["model", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "service_tier", "reasoning"]
            .filter((field) => Object.hasOwn(decoded, field))
            .map((field) => [field, identity(serialize(decoded[field]) ?? "")]),
        ),
        wire: {
          sha256: current.wire.sha256,
          length: current.wire.length,
          change: previous
            ? previous.wire.sha256 === current.wire.sha256
              ? "unchanged"
              : "changed"
            : "baseline",
        },
        afterCompression,
      }

      record("request.prefix", {
        ...common(),
        status: observation.status,
        system: observation.system,
        tools: observation.tools,
        history: observation.history,
        parameters: observation.parameters,
        serialized: observation.serialized,
        affinity: observation.affinity,
        wire: observation.wire,
        afterCompression: observation.afterCompression,
      })
      return observation
    },
    event(event) {
      if (event.type === "tool-result") {
        if (event.name !== "compress" || event.providerExecuted) return
        const bucket = buckets.get(id) ?? { pending: new Map<string, Compression>() }
        buckets.set(id, bucket)
        evictor.touch(id)
        const observed = observeCompression(bucket, event, limits.maxPendingCompressions)
        if (!observed) return
        if (observed.status === "recorded") {
          lastCompression = {
            blockCount: observed.blockCount,
            inputTokensEstimated: observed.inputTokensEstimated,
            summaryTokensEstimated: observed.summaryTokensEstimated,
            netSavingsEstimated: observed.netSavingsEstimated,
          }
        }
        record("request.compression", { ...common(), ...observed })
        return observed
      }
      if (event.type !== "step-finish") return

      const usageStatus = event.usage?.inputTokens !== undefined
        ? "reported"
        : event.usage?.outputTokens !== undefined
          ? "output-only-estimated"
          : "missing"
      const rawUsage = usageFields(event.usage)
      const cacheReadInputTokens = event.usage?.cacheReadInputTokens
      const cacheWriteInputTokens = event.usage?.cacheWriteInputTokens
      const observation: EventObservation = {
        type: "usage",
        usageStatus,
        ...(rawUsage ? { rawUsage } : {}),
        cache:
          cacheReadInputTokens === undefined && cacheWriteInputTokens === undefined
            ? { status: "unknown" }
            : {
                status: "reported",
                ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
                ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
              },
        ...(lastCompression ? { lastCompression } : {}),
      }
      record("request.usage", {
        ...common(),
        ...observation,
        costObservation: "delegated-to-session-processor",
        costSource: "Session.getUsage",
        costReason: "The processor owns model rates, cache rules, and currency normalization.",
      })
      return observation
    },
    transport(input, scopedRequestID) {
      const observation: TransportObservation = {
        requestID: scopedRequestID,
        ...(input.accountID === undefined ? {} : { accountHash: identity(input.accountID) }),
        endpointHash: identity(input.endpoint),
        ...(input.responseRequestID === undefined ? {} : { responseRequestHash: identity(input.responseRequestID) }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }
      record("request.transport", { sessionID, modelKey, runtime, ...observation })
      return observation
    },
  }
  return observer
}

// 261007 Red 只传播诊断关联号，不加 HTTP header，也不修改 SDK 参数或实际 body。
export function withRequest<T>(observer: Pick<Observer, "capture"> & Partial<Pick<Observer, "transport">>, work: () => T): T {
  return transportScope.run({ observer, requestID: crypto.randomUUID() }, work)
}

export function observeTransport(input: TransportInput): TransportObservation | undefined {
  const scoped = transportScope.getStore()
  if (!scoped?.observer.transport) return
  try {
    const body = typeof input.body === "string" || input.body instanceof Uint8Array ? input.body : undefined
    if (body !== undefined && !scoped.actualCapture) {
      scoped.actualCapture = scoped.observer.capture(body, "transport")
    }
    return scoped.observer.transport(input, scoped.requestID)
  } catch {
    // 261007 Red 诊断 sink 失败不影响认证、路由及 fetch；账号/端点原文从不落日志。
    return undefined
  }
}

export function middleware(observer: Pick<Observer, "capture"> & Partial<Pick<Observer, "transport">>) {
  return {
    specificationVersion: "v3" as const,
    async wrapStream<T>({ doStream }: { readonly doStream: () => PromiseLike<T> }): Promise<T> {
      return withRequest(observer, async () => {
        const result = await doStream()
        try {
          observer.capture((result as { request?: { body?: unknown } }).request?.body)
        } catch {
          // 261004 Red Evidence logging is best-effort and must not fail the provider stream.
        }
        return result
      })
    },
  }
}

export function reset() {
  buckets.clear()
  evictor.clear()
}

export function size() {
  return buckets.size
}

export * as RequestEvidence from "./request-evidence"
