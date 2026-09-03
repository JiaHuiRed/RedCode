import type { Event } from "@redcode-ai/sdk/v2/client"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { SSE_MAX_RETRY_ATTEMPTS, sseLogLine } from "@/utils/sse-log"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8

    // 260706 Red: 指数退避重连，与 server-sdk 保持一致，防止断连环刷新风暴
    const RECONNECT_BASE_MS = 256
    const RECONNECT_MAX_MS = 2000
    let reconnectDelay = RECONNECT_BASE_MS

    // 260901 cc 连接活性对外可见，与 server-sdk 同构。理由见那边的注释。
    const [connection, setConnection] = createSignal<"connecting" | "live" | "reconnecting">("connecting")

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
    // 260706 Red: 90s — 实测 sidecar 在处理重请求时 event loop 可能阻塞 >30s，导致 Stream.tick 心跳无法按时发送
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
                console.error(
                  sseLogLine("[global-sdk]", "event stream error", {
                    url: currentServer.http.url,
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
              // 260902 cc 退避在**收到第一条事件**后才归零，不是连上就归零。
              // SDK 那圈重试收掉之后（sseMaxRetryAttempts=1），3 秒的起始退避没了；
              // 若仍在"请求成功即归零"，服务端接了连接又立刻断的情况会退化成 256ms 紧循环。
              // 以"真的流出过数据"为准，连上但立刻断的场景才会继续按指数退避。
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
                sseLogLine("[global-sdk]", "event stream failed", {
                  url: currentServer.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                }),
              )
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            // 260903 cc 这条路径此前只把引用置空、不 abort —— 同文件其余五处都 abort，
            // 唯独"流正常结束"这条不。AbortController 是保证底层 fetch 被拆掉的唯一把手，
            // 置 undefined 只是让 GC 有机会回收，不保证 socket 立刻关。
            // 为什么要紧：本地场景下 eventFetch 是 undefined（见文件开头，只有非 loopback
            // 才走 platform.fetch），两条 SSE 流都占着 renderer 里 Chromium 的连接池，
            // 而 sidecar 是 node:http 的 HTTP/1.1 —— 同 host 只有 6 个槽。旧连接不释放 +
            // 256ms 起步的重连，槽位会被吃光，之后**所有**到该 origin 的请求无限排队：
            // 文件树空、上下文面板空、消息发得出但不落库、Esc 无效，而服务端毫发无伤，
            // 任务照常推进 —— 正是 09-01 那次的症状组合。
            // abort() 幂等，流已正常结束时是 no-op，只有还挂着才真正生效。
            attempt?.abort()
            attempt = undefined
            clearHeartbeat()
          }

          // 260706 Red: 记录断连原因，区分正常结束 vs 心跳超时 vs 网络错误
          if (!abort.signal.aborted && started) {
            setConnection("reconnecting")
            const sinceLastEvent = Date.now() - lastEventAt
            console.warn(
              sseLogLine("[global-sdk]", "stream ended, reconnecting", {
                url: currentServer.http.url,
                sinceLastEventMs: sinceLastEvent,
                exceededHeartbeat: sinceLastEvent > HEARTBEAT_TIMEOUT_MS,
              }),
            )
          }

          if (abort.signal.aborted || !started) return
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
      // 260828 Red 通知断链修复：globalSDK.event.start() 之前无任何调用者，
      //   挂在 globalSDK.event.listen 上的通知/声音/权限自动应答全成死监听，
      //   serverSDK 却正常启动（dock 弹窗可见、桌面通知从未出现）。这里自启动。
      void start()
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
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    const dirSyncContexts = new Map<string, ReturnType<typeof createDirSdkContext>>()
    const dirSdkContextRefCounts = new Map<string, number>()

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
        /** 事件流活性，与 server-sdk 同构。 */
        connection,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
      createDirSyncContext: (directory: string) => {
        onCleanup(() => {
          dirSdkContextRefCounts.set(directory, (dirSdkContextRefCounts.get(directory) ?? 0) - 1)
          if (dirSdkContextRefCounts.get(directory) === 0) {
            dirSyncContexts.delete(directory)
            dirSdkContextRefCounts.delete(directory)
          }
        })

        const cached = dirSyncContexts.get(directory)
        if (cached) {
          dirSdkContextRefCounts.set(directory, (dirSdkContextRefCounts.get(directory) ?? 0) + 1)
          return cached
        }
        const ctx = createDirSdkContext(directory)
        dirSyncContexts.set(directory, ctx)
        dirSdkContextRefCounts.set(directory, 1)

        return ctx
      },
    }
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

function createDirSdkContext(directory: string) {
  const globalSDK = useGlobalSDK()

  const client = globalSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = globalSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    directory,
    client,
    event: emitter,
    get url() {
      return globalSDK.url
    },
    createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
      return globalSDK.createClient(opts)
    },
  }
}
