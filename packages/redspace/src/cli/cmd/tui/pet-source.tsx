import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import * as Log from "@redcode-ai/core/util/log"
import { createPetHostClient } from "@redcode-ai/ui/pet-host-client"
import { resolvePetBehavior } from "@redcode-ai/ui/pet-lines"
import { feedPetEvent, petState } from "@redcode-ai/ui/pet-store"
import { outfitFor, resolvePet, resolveSessionPet } from "@redcode-ai/ui/pet-state"
import { projectDirectoryKey } from "./context/project-navigation"
import { useRoute } from "./context/route"
import { useSDK } from "./context/sdk"
import { useSync } from "./context/sync"

// 261119 Red TUI 作为桌宠宿主的来源（kind: "tui"）：
//   事件馈送与快照规则复用共享层（@redcode-ai/ui/pet-*），不复制 GUI 的口径；
//   显式激活 = TUI 启动 / 工作区切换（本组件随 scope 重挂）/ 会话切换（route 变化）；
//   客户端随组件实例创建——scope 重挂会换 sourceID 并显式 activate 接管，旧实例随之释放；
//   正常退出靠 SSE 断连由宿主兜底释放（与终端被杀同路径）。桌面版未安装时 push 恒 false、
//   只按快照变化各留一条日志，不阻断 TUI。决策 → docs/notes/proposed/feature/2026-11-18-tui-shared-desktop-pet.md
const log = Log.create({ service: "tui.pet" })

const behavior = resolvePetBehavior()

export function PetSource() {
  if (process.platform !== "win32") return null
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const client = createPetHostClient({
    kind: "tui",
    log: (message, fields) => log.error(message, fields),
  })

  // 与 GUI PetLayer 相同的 1s tick：驱动 flash 过期与 stale 回落
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const off = sdk.event.on("event", (event) => {
    if (event.directory === "global") return
    // 事件联合里部分成员（server.connected 等）没有 properties；pet-state 按 type 过滤，缺字段安全忽略
    const payload = "properties" in event.payload ? event.payload : { type: event.payload.type, properties: undefined }
    feedPetEvent({ type: payload.type, properties: payload.properties }, projectDirectoryKey(event.directory))
  })
  onCleanup(off)

  // 显式激活：挂载即报（TUI 启动/工作区切换），当前会话切换再报
  createEffect(
    on(
      () => (route.data.type === "session" ? route.data.sessionID : ""),
      () => client.activate(),
    ),
  )

  let pushedKey: string | undefined
  // 1s tick + sync 状态/路由变化合并驱动；快照没变不推（键比对），宿主不可用不重试轰炸
  createEffect(() => {
    const t = now()
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const directory = sdk.directory
    const display = sessionID
      ? resolveSessionPet(
          petState(),
          t,
          sessionID,
          {
            status: sync.data.session_status[sessionID],
            statusReady: sync.data.status !== "loading",
            permissions: sync.data.permission[sessionID],
            questions: sync.data.question[sessionID],
          },
          directory ? projectDirectoryKey(directory) : undefined,
        )
      : resolvePet(petState(), t)
    const outfit = outfitFor(petState(), display.sessionID)
    const key = JSON.stringify({ kind: display.kind, outfit })
    if (key === pushedKey) return
    pushedKey = key
    void client.push({ kind: display.kind, outfit, behavior }).then((shown) => {
      if (!shown) log.error("pet host unavailable; desktop app missing?", { kind: display.kind })
    })
  })

  return null
}
