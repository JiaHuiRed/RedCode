import { describe, expect, test } from "bun:test"
import { detect } from "../../src/session/instruction-echo"

describe("instruction-echo 快路径", () => {
  test("普通回答原样返回，不做逐行扫描", () => {
    const t = "改完了，`overflow.ts` 加了三档阈值，测试 11 条全过。"
    const r = detect(t)
    expect(r.kinds).toEqual([])
    expect(r.stripped).toBe(t)
  })

  test("空串不炸", () => {
    expect(detect("").kinds).toEqual([])
  })
})

describe("A 类：自己注入的包装块整块剥离", () => {
  test("system-reminder 被复述出来 —— 剥掉，保留真正的回答", () => {
    const t = "先看状态。\n<system-reminder>\nThe user sent the following message:\n继续\n</system-reminder>\n已经提交了。"
    const r = detect(t)
    expect(r.kinds).toContain("system-reminder")
    expect(r.stripped).not.toContain("system-reminder")
    expect(r.stripped).toContain("先看状态")
    expect(r.stripped).toContain("已经提交了")
  })

  test("reasoning-language 块被复述 —— 剥掉", () => {
    const t = "<reasoning-language>\n必须使用简体中文书写全部可见思考\n</reasoning-language>\n好，开始。"
    const r = detect(t)
    expect(r.kinds).toContain("reasoning-language")
    expect(r.stripped).toBe("好，开始。")
  })

  test("[System notice] 被复述 —— 剥掉该段", () => {
    const t = "[System notice] Your previous turn produced reasoning only.\nWrite your answer now.\n\n这是真正的回答。"
    const r = detect(t)
    expect(r.kinds).toContain("system-notice")
    expect(r.stripped).toBe("这是真正的回答。")
  })
})

describe("B 类：工具说明 / JSON schema 成片泄漏", () => {
  // 取自哥哥 0.8.1 家用机截图的真实形态（DCP compress 工具说明）
  const leak = [
    "让我先确认当前状态。",
    "",
    "Rules:",
    "",
    "- Pick startId and endId directly from injected IDs in context.",
    "- IDs must exist in the current visible context.",
    "- Do not invent IDs. Use only IDs that are present in context.",
    "",
    "BATCHING",
    "When multiple independent ranges are ready, include all of them.",
    "",
    "THE FORMAT OF COMPRESS",
    "{",
    '  "startId": string,     // Boundary ID at range start',
    '  "endId": string,       // Boundary ID at range end',
    '  "summary": string      // Complete technical summary',
    "}",
  ].join("\n")

  test("成片 schema 被切掉，开头的真话保留", () => {
    const r = detect(leak)
    expect(r.kinds).toContain("tool-schema")
    expect(r.stripped).toContain("让我先确认当前状态")
    expect(r.stripped).not.toContain("Do not invent IDs")
    expect(r.stripped).not.toContain("BATCHING")
    expect(r.stripped).not.toContain('"startId"')
  })

  test("★不误切：用户正常讨论 JSON 字段时不动", () => {
    const t = [
      "这个接口返回的字段是这样的：",
      "",
      "```ts",
      'type Resp = { id: string; name: string }',
      "```",
      "",
      "所以 `id` 用的是字符串不是数字。",
    ].join("\n")
    const r = detect(t)
    expect(r.kinds).toEqual([])
    expect(r.stripped).toBe(t)
  })

  test("★不误切：只有一两行像 schema 时不动（要求连续 3 行以上 + 强特征）", () => {
    const t = '返回体是 `"startId": string`，改一下就行。'
    expect(detect(t).kinds).toEqual([])
  })

  test("★不误切：有 schema 行但没有强特征标题时不动", () => {
    const t = ['修改后的类型：', '  "a": string,', '  "b": number,', '  "c": boolean,'].join("\n")
    expect(detect(t).kinds).toEqual([])
  })
})

describe("组合与幂等", () => {
  test("A 类与 B 类同时出现，两类都记录", () => {
    const t = "<system-reminder>x</system-reminder>\nRules:\n- Do not invent IDs.\n- IDs must exist in the current visible context.\n- Pick startId and endId directly."
    const r = detect(t)
    expect(r.kinds).toContain("system-reminder")
    expect(r.kinds).toContain("tool-schema")
  })

  test("剥完再跑一次不再变化（幂等）", () => {
    const once = detect("先说结论。\n<system-reminder>x</system-reminder>").stripped
    expect(detect(once).stripped).toBe(once)
  })
})
