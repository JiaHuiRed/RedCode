import type { PluginModule } from "@redcode-ai/plugin"

// 260803 Red Continuation Enforcement —— 借鉴 oh-my-claudecode 的 continuation-enforcement：
// agent 回合结束（session.idle）时检查 todo，有未完成任务则注入一条 synthetic 提醒消息让它继续。
// 「提醒不硬拦」：只提醒不强制（doom_loop 同款宽松），三道闸门防骚扰：
//   1. 用户主动 stop 后 15s 冷却期不提醒
//   2. 距上次提醒至少 30s
//   3. 每 session 最多提醒 3 次，之后安静
const MIN_INTERVAL_MS = 30_000
const MAX_REMINDERS = 3
const STOP_COOLDOWN_MS = 15_000

export default {
  id: "redcode-continuation-enforcement",
  server: async ({ client }) => {
    const lastRemind = new Map<string, { at: number; count: number }>()
    const lastStop = new Map<string, number>()

    const remind = (items: Array<{ content: string }>) => {
      const list = items
        .slice(0, 3)
        .map((t) => `- ${t.content}`)
        .join("\n")
      const extra = items.length > 3 ? `\n  …还有 ${items.length - 3} 项` : ""
      return `[续跑提醒] 你还有 ${items.length} 个未完成的任务，请继续推进；若确已无需处理，请标记完成或说明原因：\n${list}${extra}`
    }

    return {
      "session.stop": async ({ sessionID }: { sessionID: string }) => {
        lastStop.set(sessionID, Date.now())
      },
      "session.end": async ({ sessionID }: { sessionID: string }) => {
        lastRemind.delete(sessionID)
        lastStop.delete(sessionID)
      },
      event: async ({ event }) => {
        if (event.type !== "session.idle") return
        const sessionID = event.properties.sessionID
        const now = Date.now()

        // 用户主动停止 → 冷却期内不提醒
        if (now - (lastStop.get(sessionID) ?? 0) < STOP_COOLDOWN_MS) return

        // 时间闸 + 次数闸
        const state = lastRemind.get(sessionID)
        if (state && (now - state.at < MIN_INTERVAL_MS || state.count >= MAX_REMINDERS)) return

        // 查未完成任务
        const todo = await client.session.todo({ path: { id: sessionID } }).catch(() => null)
        const open = (todo?.data ?? []).filter((t) => t.status === "pending" || t.status === "in_progress")
        if (open.length === 0) return

        // 注入 synthetic 提醒（不 await，避免阻塞事件回调）
        client.session
          .prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: remind(open), synthetic: true }] },
          })
          .catch(() => null)

        lastRemind.set(sessionID, { at: now, count: (state?.count ?? 0) + 1 })
      },
    }
  },
} satisfies PluginModule
