import type { Event } from "@redcode-ai/sdk/v2/client"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { useGlobalSDK } from "./global-sdk"
import { createRefCountMap } from "@/utils/refcount"

// 260907 ZCode SSE 合流（GUI 性能审计问题 5）：此前本文件与 global-sdk 各开一条
// /global/event 全量 firehose——事件源、eventFetch 判定、queue/合并/退避/心跳逻辑
// 完全同构（两份代码互相抄、注释互相引用），每个事件被双份 parse/排队/派发，还常驻
// 占掉 Chromium 同 host 6 个 HTTP/1.1 连接中的 2 个（sidecar 是 node:http，无多路复用）。
//
// 合流方向：保留**外层** global-sdk 那条连接，本文件的 event 整体代理过去——不需要动
// app.tsx 的 Provider 顺序（GlobalSDKProvider 在外，useGlobalSDK 在这里必然可用）。
// 保留 global 侧的理由：260828 的修复保证它 onMount 自启动（通知/权限不依赖
// server-sync 挂载）；server-sync 的 start() 调用透传过去且幂等，行为不变。
// 断连状态信号 connection 一并透传（唯一 UI 消费方 status-popover 读的是 globalSDK
// 那份，代理兜住其他潜在读取者）。重连日志此后只会有 [global-sdk] 一个来源——
// 只剩一条流，串台问题不复存在。
function createServerSdkContext(server: ServerConnection.Any) {
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })

  const shared = globalSDK.event

  return {
    url: server.http.url,
    client: sdk,
    event: {
      // global-sdk 返回的 on/listen 已 bind 到它的 emitter，直接透传引用即可
      on: shared.on,
      listen: shared.listen,
      start: () => shared.start(),
      /** 事件流活性，透传共享连接的状态。 */
      connection: shared.connection,
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
