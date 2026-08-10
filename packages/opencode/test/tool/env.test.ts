import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Layer } from "effect"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { EnvTool } from "../../src/tool/env"
import { SessionID, MessageID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

// 260810 cc audit R3: env 工具补了权限门（此前是全仓唯一无 ctx.ask 的取值通道，
// vars 可直接回显 API key）。这里钉住：两个分支都必须先过 ask，且 pattern 可辨析。

const ctx = {
  sessionID: SessionID.make("ses_test-env"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const run = Effect.fn("EnvToolTest.run")(function* (
  args: Tool.InferParameters<typeof EnvTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* EnvTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

describe("tool.env", () => {
  // 单实例内串行三段断言：同文件多 it.instance 会撞上已知的实例创建/销毁 5s 超时薄纱
  it.instance("gates all branches behind env permission ask", () =>
    Effect.gen(function* () {
      yield* TestInstance

      // vars 分支：pattern = 请求的变量名，逐个可辨析
      const varsRecorder = asks()
      yield* run({ vars: ["PATH", "SOME_SECRET_KEY"] }, varsRecorder.next)
      expect(varsRecorder.items).toHaveLength(1)
      expect(varsRecorder.items[0].permission).toBe("env")
      expect(varsRecorder.items[0].patterns).toEqual(["PATH", "SOME_SECRET_KEY"])

      // category 分支同样要过闸门（paths 档也会回显 PATH/HOME 等值）
      const categoryRecorder = asks()
      const result = yield* run({ category: "cpu" }, categoryRecorder.next)
      expect(categoryRecorder.items).toHaveLength(1)
      expect(categoryRecorder.items[0].permission).toBe("env")
      expect(categoryRecorder.items[0].patterns).toEqual(["cpu"])
      expect(result.output).toContain("cores")

      // ask 拒绝时不吐任何值
      const denied = {
        ...ctx,
        ask: () => Effect.die(new Error("denied by test")),
      } satisfies Tool.Context
      const exit = yield* run({ vars: ["PATH"] }, denied).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
