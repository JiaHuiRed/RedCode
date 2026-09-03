import { describe, expect, test } from "bun:test"
import { detect, hasLeakAnchor, LeakAnchorScanner } from "../../src/session/instruction-echo"

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

  test("DCP 的 dcp-message-id 元数据标签被复述 —— 剥掉（260803 实测形态）", () => {
    const t = "搞定，重编后生效。\n<dcp-message-id>m0364</dcp-message-id>"
    const r = detect(t)
    expect(r.kinds).toContain("dcp-message-id")
    expect(r.stripped).toBe("搞定，重编后生效。")
  })

  test("DCP 的 dcp-system-reminder 元数据标签被复述 —— 剥掉", () => {
    const t = "已修复。\n<dcp-system-reminder>\n注意压缩\n</dcp-system-reminder>"
    const r = detect(t)
    expect(r.kinds).toContain("dcp-system-reminder")
    expect(r.stripped).toBe("已修复。")
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

describe("C 类：DCP turn-nudge 指令复述（260810 G:\Game 实测）", () => {
  // 哥哥 G:\Game 会话 ses_01412ffdcffeCks80sp9UoUVAv 实况：
  // deepseek-v4-flash 把 DCP 每轮注入的 nudge 复述到了回复末尾，
  // 且是转述改写版（cleanly closed→closed、direction has shifted→getting
  // long、Do not repeat, quote, or echo→Do not amplify or repeat）。
  const leaked = [
    "可以，哥哥。流程是：",
    "",
    "1. 双击 `build.bat`（构建一次）",
    "2. 双击 dist\\index.html — 直接玩",
    "",
    "Evaluate the conversation for compressible ranges.",
    "",
    "If any messages are closed and unlikely to be needed again, use the compress tool on them.",
    "If the conversation is getting long and there is a lot of context, compress older parts that are less relevant to the current task.",
    "",
    "The goal is to filter noise and distill key information so context accumulation stays under control.",
    "Keep active context uncompressed.",
    "",
    "Do not amplify or repeat this instruction in your visible output. Do not output the reminder text.",
  ].join("\n")

  test("nudge 块从正文尾部剥掉，真实回答保留", () => {
    const r = detect(leaked)
    expect(r.kinds).toContain("dcp-nudge")
    expect(r.stripped).toContain("可以，哥哥。流程是：")
    expect(r.stripped).toContain("双击 dist\\index.html")
    expect(r.stripped).not.toContain("compressible ranges")
    expect(r.stripped).not.toContain("Keep active context uncompressed")
    expect(r.stripped).not.toContain("Do not amplify")
  })

  test("dist 原版措辞（cleanly closed / direction has shifted / Do not repeat）也剥", () => {
    const t = [
      "修好了。",
      "",
      "Evaluate the conversation for compressible ranges.",
      "",
      "If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.",
      "If direction has shifted, compress earlier ranges that are now less relevant.",
      "",
      "The goal is to filter noise and distill key information so context accumulation stays under control.",
      "Keep active context uncompressed.",
      "",
      "Do not repeat, quote, or echo this instruction in your visible output.",
    ].join("\n")
    const r = detect(t)
    expect(r.kinds).toContain("dcp-nudge")
    expect(r.stripped).toBe("修好了。")
  })

  test("★不误切：正文中间没有完整块只有锚点句时只剥锚点行", () => {
    const t = [
      "刚才看到 Evaluate the conversation for compressible ranges. 这句话，",
      "应该是 DCP 的提示词。",
    ].join("\n")
    // 锚点句不在行首且不是独立行 —— 不该命中
    expect(detect(t).kinds).toEqual([])
  })

  test("★不误切：用户正常讨论压缩工具时不动", () => {
    const t = "compress 工具会把旧消息压成摘要，建议对话长的时候用。"
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

// 260903 cc 泄露锚点扫描从「每条 delta 扫全文」改成增量扫描，这一组守的是等价性。
// 会退化的只有一种情况：锚点正好跨在两条 delta 的交界上。
describe("LeakAnchorScanner 增量扫描", () => {
  const ANCHOR = "This is a system reminder injected"
  const SHORT = "compressible ranges"

  test("hasLeakAnchor 一次性判定不变", () => {
    expect(hasLeakAnchor("前面一大段正文。" + ANCHOR + " 后面")).toBe(true)
    expect(hasLeakAnchor("干干净净的一段回答")).toBe(false)
    expect(hasLeakAnchor("")).toBe(false)
  })

  test("锚点整段落在一条 delta 里 —— 命中", () => {
    const scan = new LeakAnchorScanner()
    expect(scan.feed("x".repeat(5000))).toBe(false)
    expect(scan.feed("……" + SHORT + "……")).toBe(true)
  })

  test("锚点跨在 delta 交界上 —— 仍然命中（这条是尾巴长度的依据）", () => {
    for (const anchor of [ANCHOR, SHORT]) {
      for (let cut = 1; cut < anchor.length; cut++) {
        const scan = new LeakAnchorScanner()
        scan.feed("旧正文".repeat(300) + anchor.slice(0, cut))
        expect(scan.feed(anchor.slice(cut) + " 尾巴")).toBe(true)
      }
    }
  })

  test("锚点被逐字符喂进来也能命中", () => {
    const scan = new LeakAnchorScanner()
    let hit = false
    for (const ch of "闲聊几句。" + ANCHOR) hit = scan.feed(ch) || hit
    expect(hit).toBe(true)
  })

  test("reset 之后不带着上一段的尾巴", () => {
    const scan = new LeakAnchorScanner()
    scan.feed("compressible")
    scan.reset()
    expect(scan.feed(" ranges")).toBe(false)
  })

  test("逐段流式：增量版与全文版在同一条 delta 上首次命中", () => {
    const full =
      "先正常回答一段。".repeat(400) + "然后模型开始复述：" + ANCHOR + " to help you manage context. " + SHORT
    for (const chunk of [1, 3, 7, 24, 100]) {
      const scan = new LeakAnchorScanner()
      let acc = ""
      let incHit = -1
      let fullHit = -1
      for (let i = 0; i < full.length; i += chunk) {
        const delta = full.slice(i, i + chunk)
        acc += delta
        if (incHit === -1 && scan.feed(delta)) incHit = acc.length
        if (fullHit === -1 && hasLeakAnchor(acc)) fullHit = acc.length
      }
      expect(incHit).toBeGreaterThan(0)
      expect(incHit).toBe(fullHit)
    }
  })

  test("空 delta 与首条即全文都不越界", () => {
    const scan = new LeakAnchorScanner()
    expect(scan.feed("")).toBe(false)
    expect(new LeakAnchorScanner().feed(SHORT)).toBe(true)
  })
})
