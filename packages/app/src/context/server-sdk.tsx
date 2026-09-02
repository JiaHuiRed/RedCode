import type { Event } from "@redcode-ai/sdk/v2/client"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { SSE_MAX_RETRY_ATTEMPTS, sseLogLine } from "@/utils/sse-log"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

function createServerSdkContext(server: ServerConnection.Any) {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: eventFetch,
    server: server.http,
  })
  const emitter = createGlobalEmitter<{
    [key: string]: Event
  }>()

  type Queued = { directory: string; payload: Event }
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8

  let queue: Queued[] = []
  let buffer: Queued[] = []
  const coalesced = new Map<string, number>()
  const staleDeltas = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

  const key = (directory: string, payload: Event) => {
    if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
    if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      return `message.part.updated:${directory}:${part.messageID}:${part.id}`
    }
  }

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
    queue = buffer
    buffer = events
    queue.length = 0
    coalesced.clear()
    staleDeltas.clear()

    last = Date.now()
    batch(() => {
      for (const event of events) {
        if (skip && event.payload.type === "message.part.delta") {
          const props = event.payload.properties
          if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
        }
        emitter.emit(event.directory, event.payload)
      }
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const aborted = isAbortError

  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  // 260706 Red: 90s — 实测 sidecar event loop 阻塞可 >30s（重请求处理），导致 Stream.tick 心跳延迟
  const HEARTBEAT_TIMEOUT_MS = 90_000
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  let heartbeatGen = 0
  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    const gen = ++heartbeatGen
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      if (gen !== heartbeatGen) return
      attempt?.abort()
    }, HEARTBEAT_TIMEOUT_MS)
  }
  const clearHeartbeat = () => {
    if (!heartbeat) return
    heartbeatGen++
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  // 260705 Red: 指数退避重连，256ms→512ms→1s→2s(cap)，减少断连环的刷新风暴
  const RECONNECT_BASE_MS = 256
  const RECONNECT_MAX_MS = 2000
  let reconnectDelay = RECONNECT_BASE_MS

  // 260901 cc 连接活性对外可见。重连逻辑本身早就齐全（心跳 + 退避 + abort），缺的只是
  // 它从不把状态吐给界面——断连信号全进了 console.warn。哥哥 08-31 在家遇到的那次
  // 「她还在跑但我发不出消息、面板全空」，界面上没有任何地方会变，就是缺这一格。
  // 三态而不是布尔：断开的瞬间就重连，"reconnecting" 才是用户实际看到的那个状态。
  const [connection, setConnection] = createSignal<"connecting" | "live" | "reconnecting">("connecting")

  const start = () => {
    if (started) return run
    started = true
    run = (async () => {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started) {
        attempt = new AbortController()
        lastEventAt = Date.now()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const events = await eventSdk.global.event({
            signal: attempt.signal,
            sseMaxRetryAttempts: SSE_MAX_RETRY_ATTEMPTS,
            onSseError: (error) => {
              if (aborted(error)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              // 260901 cc 标签原本写的是 [global-sdk]，是从 global-sdk.tsx 抄过来时漏改的。
              // 两个文件各有一份几乎相同的重连循环，日志串台正好在排查断连时误导人。
              console.error(
                sseLogLine("[server-sdk]", "event stream error", {
                  url: server.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                }),
              )
            },
          })
          setConnection("live")
          let yielded = Date.now()
          resetHeartbeat()
          for await (const event of events.stream) {
            resetHeartbeat()
            streamErrorLogged = false
            // 260902 cc 退避在收到第一条事件后才归零，理由见 global-sdk.tsx 同处注释。
            reconnectDelay = RECONNECT_BASE_MS
            const directory = event.directory ?? "global"
            if (event.payload.type === "sync") {
              continue
            }

            const payload = event.payload as Event

            const k = key(directory, payload)
            if (k) {
              const i = coalesced.get(k)
              if (i !== undefined) {
                queue[i] = { directory, payload }
                if (payload.type === "message.part.updated") {
                  const part = payload.properties.part
                  staleDeltas.add(deltaKey(directory, part.messageID, part.id))
                }
                continue
              }
              coalesced.set(k, queue.length)
            }
            queue.push({ directory, payload })
            schedule()

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!aborted(error) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error(
              sseLogLine("[server-sdk]", "event stream failed", {
                url: server.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              }),
            )
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
          clearHeartbeat()
        }

        if (abort.signal.aborted || !started) return

        setConnection("reconnecting")

        // 260706 Red: 记录断连原因
        const sinceLastEvent = Date.now() - lastEventAt
        console.warn(
          sseLogLine("[server-sdk]", "stream ended, reconnecting", {
            url: server.http.url,
            sinceLastEventMs: sinceLastEvent,
            exceededHeartbeat: sinceLastEvent > HEARTBEAT_TIMEOUT_MS,
          }),
        )

        await wait(Math.min(reconnectDelay, RECONNECT_MAX_MS))
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
      }
    })().finally(() => {
      run = undefined
      flush()
    })
    return run
  }

  const stop = () => {
    started = false
    attempt?.abort()
    clearHeartbeat()
  }

  onMount(() => {
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      if (!started) return
      if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
      attempt?.abort()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })

  return {
    url: server.http.url,
    client: sdk,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
      /** 事件流活性。界面据此显示断连提示，见 260901 那条注释。 */
      connection,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()

    if (!server.current) throw new Error(language.t("error.serverSDK.noServerAvailable"))
    const sdk = createServerSdkContext(server.current)
    return {
      ...sdk,
      createDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
    }
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ReturnType<typeof createServerSdkContext>) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    directory,
    client,
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
