import { describe, expect, test } from "bun:test"
import type { ModelMessage, streamText } from "ai"
import { LLM } from "../src/session/llm"
import type { Provider } from "../src/provider/provider"

type StreamResult = Awaited<ReturnType<typeof streamText>>
type StreamPart = StreamResult["fullStream"] extends AsyncIterable<infer T> ? T : never

const textDelta = (text: string): StreamPart =>
  ({ type: "text-delta", id: "t", text }) as StreamPart
const reasoningDelta = (text: string): StreamPart =>
  ({ type: "reasoning-delta", id: "r", text }) as StreamPart

function fakeResult(parts: StreamPart[], finishReason: string): StreamResult {
  const fullStream = (async function* () {
    yield* parts
    yield {
      type: "finish",
      finishReason,
      rawFinishReason: finishReason,
      usage: undefined,
      totalUsage: undefined,
    } as unknown as StreamPart
  })()
  return { fullStream: fullStream as unknown as StreamResult["fullStream"] } as unknown as StreamResult
}

const deepseekModel = { id: "deepseek-v4-flash", api: { id: "deepseek-v4-flash" } } as unknown as Provider.Model
const otherModel = { id: "gpt-5.4", api: { id: "gpt-5.4" } } as unknown as Provider.Model

describe("LLM.withContinuation", () => {
  test("非 DeepSeek 模型不续写，只发一次请求", async () => {
    let calls = 0
    const result = LLM.withContinuation(
      () => {
        calls++
        return fakeResult([textDelta("a")], "stop")
      },
      [],
      otherModel,
    )
    const texts: string[] = []
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") texts.push(event.text)
    }
    expect(calls).toBe(1)
    expect(texts.join("")).toBe("a")
  })

  test("finish_reason=length 自动续写，两轮输出拼接", async () => {
    let calls = 0
    const build = () => {
      calls++
      return calls === 1
        ? fakeResult([reasoningDelta("思考1"), textDelta("前半")], "length")
        : fakeResult([textDelta("后半")], "stop")
    }
    const result = LLM.withContinuation(build, [], deepseekModel)
    const texts: string[] = []
    for await (const event of result.fullStream) {
      if (event.type === "text-delta") texts.push(event.text)
    }
    expect(calls).toBe(2)
    expect(texts.join("")).toBe("前半后半")
  })

  test("续写时把已生成内容作为 assistant 前缀回传", async () => {
    const seen: ModelMessage[][] = []
    const build = (msgs: ModelMessage[]) => {
      seen.push(msgs)
      return seen.length === 1 ? fakeResult([reasoningDelta("r1"), textDelta("x1")], "length") : fakeResult([], "stop")
    }
    const result = LLM.withContinuation(build, [{ role: "user", content: "hi" }], deepseekModel)
    for await (const _ of result.fullStream) {
      // drain
    }
    expect(seen.length).toBe(2)
    const assistant = seen[1][seen[1].length - 1]
    expect(assistant.role).toBe("assistant")
    const parts = (assistant as { content: Array<{ type: string; text: string }> }).content
    expect(parts[0]).toEqual({ type: "reasoning", text: "r1" })
    expect(parts[1]).toEqual({ type: "text", text: "x1" })
  })

  test("工具调用轮不续写（截断交给 XML 打捞）", async () => {
    let calls = 0
    const build = () => {
      calls++
      return fakeResult([{ type: "tool-call", toolCallId: "1", toolName: "bash", input: {} } as StreamPart], "length")
    }
    const result = LLM.withContinuation(build, [], deepseekModel)
    for await (const _ of result.fullStream) {
      // drain
    }
    expect(calls).toBe(1)
  })

  test("达到续写次数上限停止（1 次原始 + 2 次续写）", async () => {
    let calls = 0
    const build = () => {
      calls++
      return fakeResult([textDelta("x")], "length")
    }
    const result = LLM.withContinuation(build, [], deepseekModel)
    for await (const _ of result.fullStream) {
      // drain
    }
    expect(calls).toBe(3)
  })

  test("截断但无任何输出时不续写", async () => {
    let calls = 0
    const build = () => {
      calls++
      return fakeResult([], "length")
    }
    const result = LLM.withContinuation(build, [], deepseekModel)
    for await (const _ of result.fullStream) {
      // drain
    }
    expect(calls).toBe(1)
  })
})
