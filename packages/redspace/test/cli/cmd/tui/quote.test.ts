import { describe, expect, test } from "bun:test"
import { QUOTE_CHAR_CAP, quoteMessageText, quoteSnippet, quoteSourceLabel } from "../../../../src/cli/cmd/tui/util/quote"

// 261116 Red A04：引用到草稿必须有可追溯来源与明确上限，不能把整段日志默默塞进上下文。
describe("quoteSnippet", () => {
  const source = { kind: "message" as const, sessionID: "ses_parent", messageID: "msg_01" }

  test("keeps the body and writes traceable source ids", () => {
    const text = quoteSnippet("只看 data_sync.py 的同步入口", source)
    expect(text).toContain("只看 data_sync.py 的同步入口")
    expect(text).toContain("会话 ses_parent")
    expect(text).toContain("消息 msg_01")
    expect(text).not.toContain("已截断")
  })

  test("caps long content to the tail and marks truncation", () => {
    const long = `${"a".repeat(QUOTE_CHAR_CAP)}TAIL`
    const text = quoteSnippet(long, source)
    expect(text).toContain("TAIL")
    expect(text).toContain("引用已截断")
    // 正文只保留末尾 QUOTE_CHAR_CAP 字符：'a' 的个数上限就是上限本身。
    expect(text.split("a").length - 1).toBeLessThanOrEqual(QUOTE_CHAR_CAP)
    expect(text).toContain(`仅含末尾 ${QUOTE_CHAR_CAP.toLocaleString()} 字符`)
  })

  test("tool quotes keep the part id and tool label", () => {
    const label = quoteSourceLabel({
      kind: "tool",
      sessionID: "ses_parent",
      messageID: "msg_01",
      partID: "prt_02",
      label: "bash",
    })
    expect(label).toContain("工具 bash 输出")
    expect(label).toContain("part prt_02")
  })

  test("empty content produces no snippet", () => {
    expect(quoteSnippet("  \n ", source)).toBe("")
  })
})

describe("quoteMessageText", () => {
  test("joins visible text and skips synthetic/internal parts", () => {
    expect(
      quoteMessageText([
        { type: "text", text: "第一段" },
        { type: "text", text: "内部提醒", synthetic: true },
        { type: "reasoning", text: "思考" },
        { type: "text", text: "第二段" },
      ]),
    ).toBe("第一段\n\n第二段")
  })
})
