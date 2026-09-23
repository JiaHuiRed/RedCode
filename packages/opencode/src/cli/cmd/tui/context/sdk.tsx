import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Flag } from "@redcode-ai/core/flag/flag"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

// 260923 Red SSE 半死连接 watchdog：TCP 没 close、代理卡住、流不再来数据时，
// for-await 不会退出，客户端会永远以为连接活着。阈值可注入是为了让测试直调
// 真实现（#183：阈值做成参数，别在测试里逐行复刻），生产固定 60s/10s。
export function createSseWatchdog(options: { timeout: number; interval: number; onStale: () => void }) {
  let lastEventAt = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - lastEventAt > options.timeout) options.onStale()
  }, options.interval)
  return {
    touch() {
      lastEventAt = Date.now()
    },
    stop() {
      clearInterval(timer)
    },
  }
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000
    // 260923 Red 服务端心跳 10s 一发；60s 收不到任何事件（含心跳）判定半死连接
    const sseWatchdogTimeout = 60_000
    const sseWatchdogInterval = 10_000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted) break
          // 260923 Red 每连接独立 ctrl：watchdog 只 abort 当前连接，重连仍由下面这个
          // while 继续（不另起第二套状态机）；只有外层 abort（退出/清理）才 break 循环。
          const ctrl = new AbortController()
          sse = ctrl

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.REDCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          const watchdog = createSseWatchdog({
            timeout: sseWatchdogTimeout,
            interval: sseWatchdogInterval,
            onStale: () => ctrl.abort(),
          })

          // 260923 Red 建连成功≠流健康：收到本连接第一条事件才把 attempt 归零，否则
          // 历史断线攒下的指数会让下一次重连白等 4s/8s/30s，中间稳定运行多久都洗不掉。
          // 连上但一个事件都没收到的空流不重置——它没证明自己健康。
          let received = false
          try {
            for await (const event of events.stream) {
              if (abort.signal.aborted || ctrl.signal.aborted) break
              watchdog.touch()
              if (!received) {
                received = true
                attempt = 0
              }
              handleEvent(event)
            }
          } finally {
            watchdog.stop()
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.REDCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
