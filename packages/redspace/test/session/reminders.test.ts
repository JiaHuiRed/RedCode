import { expect, test } from "bun:test"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Context, Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import * as SessionReminders from "../../src/session/reminders"
import * as SessionNs from "../../src/session/session"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.md" with { type: "text" }
import PROMPT_PLAN from "../../src/session/prompt/plan.md" with { type: "text" }

/**
 * 261121 Red 方案⑧：退出 Plan 的切回提醒只出现一次。重放「普通 → Plan → 普通×N」，
 * 断言每次离开 Plan 只在第一个普通轮注入 BUILD_SWITCH，之后的连续普通轮不再注入；
 * 压缩摘要（agent 恒为 "compaction"、summary: true）不参与最近有效模式的判定。
 */

const assistant = (agent: string, summary?: true): MessageV2.WithParts =>
  ({
    info: { id: "msg_a_" + Math.random().toString(36).slice(2), role: "assistant", agent, summary },
    parts: [{ id: "prt", messageID: "msg", sessionID: "ses_test", type: "text", text: "ok" }],
  }) as unknown as MessageV2.WithParts

const user = (text: string): MessageV2.WithParts =>
  ({
    info: { id: "msg_u_" + Math.random().toString(36).slice(2), role: "user", sessionID: "ses_test" },
    parts: [{ id: "prt", messageID: "msg", sessionID: "ses_test", type: "text", text }],
  }) as unknown as MessageV2.WithParts

// 非实验分支不碰 Session.Service：任何字段访问都直接炸，证明判据抽干净后接线没变宽。
const sessionGuard = Layer.succeed(
  SessionNs.Service,
  new Proxy({} as Context.Service.Shape<typeof SessionNs.Service>, {
    get: () => {
      throw new Error("non-experimental reminders branch must not touch Session.Service")
    },
  }),
)

const runApply = (messages: MessageV2.WithParts[], agentName: string) =>
  SessionReminders.apply({
    messages,
    agent: { name: agentName } as Agent.Info,
    session: { id: "ses_test" } as SessionNs.Info,
  }).pipe(
    Effect.provide(RuntimeFlags.layer({ client: "desktop", experimentalPlanMode: false })),
    Effect.provide(AppFileSystem.defaultLayer),
    Effect.provide(sessionGuard),
  )

const switches = (messages: MessageV2.WithParts[]) =>
  messages.flatMap((msg) => msg.parts.filter((part) => part.type === "text" && part.text === BUILD_SWITCH)).length

const plans = (messages: MessageV2.WithParts[]) =>
  messages.flatMap((msg) => msg.parts.filter((part) => part.type === "text" && part.text === PROMPT_PLAN)).length

test("initial normal turns never inject the switch reminder", async () => {
  const out = await Effect.runPromise(runApply([user("start"), assistant("build"), user("continue")], "build"))
  expect(switches(out)).toBe(0)
  expect(plans(out)).toBe(0)
})

test("leaving plan reminds exactly once; later normal turns stay quiet", async () => {
  // 普通 → Plan → 第一个普通轮：提醒一次
  const out = await Effect.runPromise(runApply([user("start"), assistant("plan"), user("back to work")], "build"))
  expect(switches(out)).toBe(1)
  // 切回后的连续普通轮：不再提醒
  const later = await Effect.runPromise(
    runApply([user("start"), assistant("plan"), user("back"), assistant("build"), user("more")], "build"),
  )
  expect(switches(later)).toBe(0)
})

test("re-entering plan keeps its constraints and reminds again on the next exit", async () => {
  // Plan 轮内维持其约束（PROMPT_PLAN），不注入切回提醒
  const inside = await Effect.runPromise(
    runApply([user("start"), assistant("build"), user("plan this")], "plan"),
  )
  expect(plans(inside)).toBe(1)
  expect(switches(inside)).toBe(0)
  // 再次进入 Plan 后再离开：第二次离开同样只提醒一次
  // （完整重放：build → plan → build → plan → build；最后一轮是第二次离开）
  const out = await Effect.runPromise(
    runApply(
      [
        user("start"),
        assistant("build"),
        user("plan 1"),
        assistant("plan"),
        user("back"),
        assistant("build"),
        user("plan 2"),
        assistant("plan"),
        user("go"),
      ],
      "build",
    ),
  )
  expect(switches(out)).toBe(1)
  // 第二次离开之后的普通轮同样安静
  const later = await Effect.runPromise(
    runApply(
      [
        user("start"),
        assistant("build"),
        user("plan 1"),
        assistant("plan"),
        user("back"),
        assistant("build"),
        user("plan 2"),
        assistant("plan"),
        user("go"),
        assistant("build"),
        user("more"),
      ],
      "build",
    ),
  )
  expect(switches(later)).toBe(0)
})

test("compaction summaries never count as the effective mode", async () => {
  // 历史只有压缩摘要（agent 恒为 compaction）：不算 plan，也不算任何有效模式
  const only = await Effect.runPromise(runApply([assistant("compaction", true), user("continue")], "build"))
  expect(switches(only)).toBe(0)
  // 摘要不遮蔽保留尾里最近的真实轮次：压缩后首次离开照常提醒一次
  const tail = await Effect.runPromise(
    runApply([assistant("compaction", true), assistant("plan"), user("back to work")], "build"),
  )
  expect(switches(tail)).toBe(1)
})
