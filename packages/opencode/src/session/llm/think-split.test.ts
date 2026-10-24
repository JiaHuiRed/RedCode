import { describe, expect, test } from "bun:test"
import { ThinkTagScanner } from "./think-split"

// 261024 Red 内联 <think> 拆分器的契约：两路分离、跨增量标签、孤立闭标签丢弃、
// 悬挂尾窗在 flush 放行。见 think-split.ts 头注释。

const joined = (parts: Array<{ text: string; reasoning: string }>) => ({
  text: parts.map((p) => p.text).join(""),
  reasoning: parts.map((p) => p.reasoning).join(""),
})

describe("ThinkTagScanner", () => {
  test("passes plain content through untouched", () => {
    const s = new ThinkTagScanner()
    expect(joined([s.feed("hello world"), s.flush()])).toEqual({ text: "hello world", reasoning: "" })
  })

  test("splits a full inline think block", () => {
    const s = new ThinkTagScanner()
    const out = joined([s.feed("答：<think>先想一下</think>答案是 2"), s.flush()])
    expect(out).toEqual({ text: "答：答案是 2", reasoning: "先想一下" })
  })

  test("handles tags split across deltas", () => {
    const s = new ThinkTagScanner()
    const out = joined([s.feed("a<th"), s.feed("ink>推理</th"), s.feed("ink>b"), s.flush()])
    expect(out).toEqual({ text: "ab", reasoning: "推理" })
  })

  test("drops a stray closing tag but keeps surrounding text", () => {
    const s = new ThinkTagScanner()
    const out = joined([s.feed("正文一</think>正文二"), s.flush()])
    expect(out).toEqual({ text: "正文一正文二", reasoning: "" })
  })

  test("holds a trailing partial tag until it resolves", () => {
    const s = new ThinkTagScanner()
    const first = s.feed("a <")
    expect(first).toEqual({ text: "a ", reasoning: "" })
    const second = s.feed(" b")
    expect(second).toEqual({ text: "< b", reasoning: "" })
  })

  test("flush routes the held tail by think state", () => {
    const open = new ThinkTagScanner()
    open.feed("<think>x</th")
    expect(open.flush()).toEqual({ text: "", reasoning: "</th" })

    const closed = new ThinkTagScanner()
    const out = joined([closed.feed("abc<"), closed.flush()])
    expect(out).toEqual({ text: "abc<", reasoning: "" })
  })

  test("reasoning spans text parts until the closing tag", () => {
    const s = new ThinkTagScanner()
    const out = joined([s.feed("<think>part one"), s.feed("part two</think>done"), s.flush()])
    expect(out).toEqual({ text: "done", reasoning: "part onepart two" })
  })

  test("empty deltas are harmless", () => {
    const s = new ThinkTagScanner()
    expect(s.feed("")).toEqual({ text: "", reasoning: "" })
    expect(s.flush()).toEqual({ text: "", reasoning: "" })
  })
})
