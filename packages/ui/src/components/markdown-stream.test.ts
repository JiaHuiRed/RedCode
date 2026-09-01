import { describe, expect, test } from "bun:test"
import MarkdownIt from "markdown-it"
import { stream } from "./markdown-stream"

const md = new MarkdownIt()

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "live" },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live" },
    ])
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })
})

// 260901 cc 一般情况下的「定型前缀 + 活跃尾块」切分。
//
// 这组测试里最要紧的不是「切得对不对」，而是**切完渲染结果不能变**。切错的代价是
// 用户看到的正文变形（列表被切成两个 <ul>、松散/紧凑语义翻转），比慢得多严重。
describe("markdown stream —— 定型前缀切分", () => {
  const render = (blocks: ReturnType<typeof stream>) => blocks.map((b) => md.render(b.src)).join("")

  test("多段落：切在最后一段之前", () => {
    expect(stream("para one\n\npara two", true)).toEqual([
      { raw: "para one\n\n", src: "para one\n\n", mode: "live" },
      { raw: "para two", src: "para two", mode: "live" },
    ])
  })

  test("单个块不切——切了就没有「定型前缀」可言", () => {
    expect(stream("just one paragraph", true)).toHaveLength(1)
    expect(stream("# only a heading", true)).toHaveLength(1)
  })

  test("**前缀在尾块生长期间必须恒定**——缓存能不能命中全靠这一条", () => {
    const head = "settled paragraph\n\n"
    const a = stream(head + "growing", true)
    const b = stream(head + "growing longer", true)
    const c = stream(head + "growing longer still", true)
    expect(a[0]!.raw).toBe(head)
    expect(b[0]!.raw).toBe(head)
    expect(c[0]!.raw).toBe(head)
  })

  test("不能切进列表内部——列表是一个顶层 token 序列", () => {
    const text = "intro\n\n- alpha\n- beta\n- gamma"
    const blocks = stream(text, true)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.raw).toBe("intro\n\n")
    expect(blocks[1]!.raw).toBe("- alpha\n- beta\n- gamma")
    expect(render(blocks).match(/<ul>/g)).toHaveLength(1)
  })

  test("渲染等价：切开之后拼起来，跟整篇一次渲染一样", () => {
    const samples = [
      "# 标题\n\n第一段。\n\n第二段带 `code`。\n\n- a\n- b",
      "para\n\n> quote line\n> more quote\n\ntail para",
      "before\n\n```ts\nconst x = 1\n```\n\nafter",
      "| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing",
      "第一段\n\n## 二级标题\n\n正文正文正文",
    ]
    for (const text of samples) {
      expect(render(stream(text, true))).toBe(md.render(text))
    }
  })

  test("引用式定义仍然整篇不切（它能影响前面的链接）", () => {
    const text = "see [docs][1]\n\nmore text\n\n[1]: https://example.com"
    expect(stream(text, true)).toHaveLength(1)
  })
})

// 260901 cc 分段的两条不变量。缓存能不能命中全靠它们，破了就等于白改。
describe("markdown stream —— 分段不变量", () => {
  const build = (sections: number) => {
    const sentence = "这是一段用来撑长度的正文，模拟真实回答里一段完整论述的体量。"
    const parts: string[] = []
    for (let i = 0; i < sections; i++) {
      parts.push(`## 小节 ${i}\n`)
      parts.push(sentence.repeat(4) + `（第 ${i} 段）\n`)
      parts.push(`- 要点 A${i}：${sentence}\n- 要点 B${i}：${sentence}\n`)
    }
    return parts.join("\n")
  }

  test("已经切好的段边界不随文本增长而移动", () => {
    const full = build(120)
    const early = stream(full.slice(0, Math.floor(full.length * 0.5)), true)
    const later = stream(full.slice(0, Math.floor(full.length * 0.8)), true)
    const full_ = stream(full, true)
    // early 里除了最后两块（正在填的段 + 活跃尾块），其余必须在后续快照里原样出现
    const frozen = early.slice(0, -2).map((b) => b.raw)
    expect(frozen.length).toBeGreaterThan(0)
    for (const list of [later, full_]) {
      const raws = list.map((b) => b.raw)
      for (const [i, raw] of frozen.entries()) expect(raws[i]).toBe(raw)
    }
  })

  test("块数按字节分段而不是按块分段——不能把 200 条的 LRU 冲垮", () => {
    const full = build(60)
    const blocks = stream(full, true)
    // 上限：全文/4KB 再加「正在填的段 + 尾块」两块的余量
    expect(blocks.length).toBeLessThanOrEqual(Math.ceil(full.length / 4096) + 2)
    // 也不能退化成一整块
    expect(blocks.length).toBeGreaterThan(1)
  })

  test("分段后渲染仍与整篇一次渲染等价（长文本）", () => {
    const full = build(20)
    const joined = stream(full, true)
      .map((b) => md.render(b.src))
      .join("")
    expect(joined).toBe(md.render(full))
  })
})
