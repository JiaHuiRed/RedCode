import { isUserTurn } from "@redcode-ai/core/util/message-turn"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import PROMPT_PLAN from "./prompt/plan.md" with { type: "text" }
import BUILD_SWITCH from "./prompt/build-switch.md" with { type: "text" }
import PLAN_MODE from "./prompt/plan-mode.md" with { type: "text" }

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* AppFileSystem.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => isUserTurn(msg.info, msg.parts))
  if (!userMessage) return input.messages

  // 261121 Red 方案⑧：切回提醒绑在模式转换上（Codex #62857 把提示绑在模式转换上的同款
  // 思路）。此前桌面分支判「历史里出现过 plan」，普通 → Plan → 普通×3 实测每个普通轮都
  // 重复注入同一段 BUILD_SWITCH。现在按最近一次有效模式判断：最后一次非摘要 assistant
  // 是 plan 才提醒一次；压缩摘要 assistant 恒为 agent "compaction"（compaction.ts 三处
  // 创建点同值），跳过 summary 取保留尾里最近的真实轮次——压缩后首次离开照常提醒一次，
  // 且摘要期不会误判。两条分支（非实验桌面/CLI 实验）同一判据。
  const lastTurnAgent = () =>
    input.messages.findLast(
      (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
        msg.info.role === "assistant" && msg.info.summary !== true,
    )?.info.agent

  // 261108 Red 审计 RC-P3-04：plan_exit 只在 CLI 注册（registry.ts 按 flags.client 过滤），
  // 桌面端却会收到要求调用它的 plan-mode 提示词。客户端不是 CLI 时退回非实验路径，
  // 让引导与真实工具表一致。
  if (!flags.experimentalPlanMode || flags.client !== "cli") {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = lastTurnAgent() === "plan"
    if (wasPlan && input.agent.name !== "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  if (input.agent.name !== "plan" && lastTurnAgent() === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || lastTurnAgent() === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
