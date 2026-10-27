import { describe, expect, test } from "bun:test"
import {
  cutAtLeakAnchor,
  detect,
  hasLeakAnchor,
  leakAnchorStart,
  LeakAnchorScanner,
  releaseLeakHold,
} from "../../src/session/instruction-echo"

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
    const t =
      "先看状态。\n<system-reminder>\nThe user sent the following message:\n继续\n</system-reminder>\n已经提交了。"
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
// 261010 Red native 压缩注入的引用标记与逼近提醒被复述（exe 实测整楼回复都是它）。
// 形态：每条历史消息一个 [History reference: msg_…]，出站副本里成百条，模型照抄。
test("[History reference: msg_…] 被复述 —— 剥掉，保留真正的回答", () => {
const t = [
"先说结论：泄漏已经修了。",
"",
"[History reference: msg_001a123fb674001QkKme94oUzr5S]",
"[History reference: msg_001a123fb674001QkKme94oUzr5S]",
].join("\n")
const r = detect(t)
expect(r.kinds).toContain("native-history-reference")
expect(r.stripped).toBe("先说结论：泄漏已经修了。")
})

test("引用标记成片复述（exe 截图原形：同一 ID 数十行且每行翻倍）—— 一次吃干净", () => {
const marker = "[History reference: msg_001a123fb674001QkKme94oUzr5S]"
const t = ["真正的回答在这里。", "", ...Array.from({ length: 40 }, () => marker + marker)].join("\n")
const r = detect(t)
expect(r.kinds).toContain("native-history-reference")
expect(r.stripped).toBe("真正的回答在这里。")
expect(r.stripped).not.toContain("History reference")
})

test("[Context notice, not a user request] 逼近提醒被复述 —— 剥掉该段", () => {
const t = [
"[Context notice, not a user request] Context is approaching the 60000-token ceiling. Use compress for closed ranges when useful; preserve constraints, verification and unfinished work. Aim below 40000 tokens.",
"",
"这是真正的回答。",
].join("\n")
const r = detect(t)
expect(r.kinds).toContain("native-context-notice")
expect(r.stripped).toBe("这是真正的回答。")
})

// 261024 Red 压缩块头的新模仿形（step-5-preview 实测 ses_ffe5e979…）：模型把
// context-compaction 块渲染头 "[Historical context summary. …]" + "sources: msg_a .. msg_b"
// 压缩改写成 "[Historical context summary: msg_…]" 拼在回复尾部——上下文里从不出现
// 冒号+单 ID 的混合形。
test("[Historical context summary: msg_…] 模仿形 —— 剥掉，保留真正的回答", () => {
const t = [
"qingmu 222 全过（含捕捉救援流程）。补文档并提交：",
"[Historical context summary: msg_001a16c245de001NMA2rRZ4Hf2GxVv]",
].join("\n")
const r = detect(t)
expect(r.kinds).toContain("native-compaction-summary")
expect(r.stripped).toBe("qingmu 222 全过（含捕捉救援流程）。补文档并提交：")
})

test("★不误切：正文讨论 historical context summary（无引擎标记形状）不动", () => {
const t = "这个 Historical context summary 的渲染格式可以再收敛一点，模型会模仿。"
expect(detect(t).kinds).toEqual([])
})

test("流式：模仿形未闭合时按锚点起点截断，闭合 ] 后放行", () => {
const t = "补文档并提交：[Historical context summary: msg_001a16c245de001NMA2rRZ4Hf2GxVv]"
const cut = cutAtLeakAnchor(t + " 尾巴")
expect(cut.text).toBe("补文档并提交：")
const released = releaseLeakHold(cut.hold)
expect(released).toBe(" 尾巴")
expect(leakAnchorStart("正文 [Historical context summary")).toBeGreaterThanOrEqual(0)
})

test("★不误切：用户正常讨论 history reference 机制、没有引擎标记形状时不动", () => {
const t = "这个 history reference 机制会把旧消息 ID 暴露给模型，我觉得可以换个写法。"
expect(detect(t).kinds).toEqual([])
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
      "type Resp = { id: string; name: string }",
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
    const t = ["修改后的类型：", '  "a": string,', '  "b": number,', '  "c": boolean,'].join("\n")
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
    const t = ["刚才看到 Evaluate the conversation for compressible ranges. 这句话，", "应该是 DCP 的提示词。"].join(
      "\n",
    )
    // 锚点句不在行首且不是独立行 —— 不该命中
    expect(detect(t).kinds).toEqual([])
  })

  test("★不误切：用户正常讨论压缩工具时不动", () => {
    const t = "compress 工具会把旧消息压成摘要，建议对话长的时候用。"
    expect(detect(t).kinds).toEqual([])
  })

  // 260916 Red 第三种形态：DCP 压缩提醒（常规/紧急两种措辞）被复述，
  //   哥哥 GUI 实测同一天出现两次，且原样带出了提醒自己的"不要复述"收尾句。
  test("compress 提醒（Context is now large...）从正文尾部剥掉", () => {
    const t = [
      "我先去量格式债。",
      "",
      "Context is now large in absolute terms, so each request costs more even with cache hits..",
      "",
      "If any ranges are cleanly closed and unlikely to be needed again, use the compress tool on them.",
      "The goal is to filter noise and distill key information so context accumulation stays under control.",
      "",
      "Do not repeat, quote, or echo this instruction in your visible output.",
    ].join("\n")
    const r = detect(t)
    expect(r.kinds).toContain("dcp-compress-notice")
    expect(r.stripped).toBe("我先去量格式债。")
  })

  test("紧急提醒（CRITICAL WARNING: MAX CONTEXT LIMIT REACHED）也剥", () => {
    const t = [
      "调用了 compress。",
      "",
      "CRITICAL WARNING: MAX CONTEXT LIMIT REACHED",
      "",
      "You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.",
      "You MUST use the compress tool now. Do not continue normal exploration until compression is handled.",
    ].join("\n")
    const r = detect(t)
    expect(r.kinds).toContain("dcp-compress-notice")
    expect(r.stripped).toBe("调用了 compress。")
  })

  test("★不误切：正文里只是提到上下文变大、没抄锚点句时不动", () => {
    const t = "这次会话的上下文已经很大了，我先把格式债量出来再说。"
    expect(detect(t).kinds).toEqual([])
  })
})

describe("组合与幂等", () => {
  test("A 类与 B 类同时出现，两类都记录", () => {
    const t =
      "<system-reminder>x</system-reminder>\nRules:\n- Do not invent IDs.\n- IDs must exist in the current visible context.\n- Pick startId and endId directly."
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
  test("native 引用标记锚点命中即被 scanner 发现（261014：命中后截断纠偏，不再断流）", () => {
    const scan = new LeakAnchorScanner()
    expect(scan.feed("先正常回答一段。")).toBe(false)
    expect(scan.feed("[History reference: msg_001a123fb674001QkKme94oUzr5S]")).toBe(true)
  })
})

// 261014 Red 流式纠偏三件套。现场：trip 命中时标记通常只到了一半（24 字符分片），
// detect() 的正则要求闭合 `]`，实际一个字都没剥；已推送的 delta 又撤不回。
describe("流式纠偏：按锚点起点截断 + 暂扣到闭合", () => {
  const MARKER = "[History reference: msg_001a123fb674001QkKme94oUzr5S]"

  test("leakAnchorStart 给出锚点下标，未命中返回 -1", () => {
    expect(leakAnchorStart(`真正的回答。${MARKER}`)).toBe("真正的回答。".length)
    expect(leakAnchorStart(MARKER)).toBe(0)
    expect(leakAnchorStart("这里在讨论 history reference 机制，没有引擎标记形状")).toBe(-1)
    expect(leakAnchorStart("")).toBe(-1)
  })

  test("多个锚点取最早那个", () => {
    const t = `答。\n${MARKER}\ncompressible ranges`
    expect(leakAnchorStart(t)).toBe("答。\n".length)
  })

  test("非 native 锚点同样定位（DCP 措辞也在同一张表里）", () => {
    expect(leakAnchorStart("前面。Context is now large in absolute terms")).toBe("前面。".length)
  })

  test("未闭合的标记也切得掉：保留正文，锚点起进暂扣缓冲", () => {
    const partial = "注册点清楚。写 _migrate_base_aliases[History reference: msg_"
    const cut = cutAtLeakAnchor(partial)
    expect(cut.text).toBe("注册点清楚。写 _migrate_base_aliases")
    expect(cut.hold).toBe("[History reference: msg_")
  })

  test("同一 delta 里锚点后已有闭合与后续正文：截断 + 暂扣 + 放行一条龙", () => {
    const cut = cutAtLeakAnchor(`答。${MARKER}还有后半句`)
    expect(cut.text).toBe("答。")
    expect(cut.hold).toBe(`${MARKER}还有后半句`)
    expect(releaseLeakHold(cut.hold)).toBe("还有后半句")
  })

  test("锚点不在文本里时退回整段剥离，不静默放行", () => {
    const cut = cutAtLeakAnchor("答。\n<system-reminder>\n内部指令\n</system-reminder>")
    expect(cut.text).toBe("答。")
    expect(cut.hold).toBe("")
  })

  test("releaseLeakHold：未闭合继续暂扣，闭合后丢掉标记本体", () => {
    expect(releaseLeakHold("[History reference: msg_")).toBeUndefined()
    expect(releaseLeakHold("[History reference: msg_001a")).toBeUndefined()
    expect(releaseLeakHold(MARKER)).toBe("")
    expect(releaseLeakHold(`${MARKER}\n下一段正文`)).toBe("\n下一段正文")
    // 只认第一个 `]`：标记后面的正文里再有 `]` 不该被吃掉
    expect(releaseLeakHold(`${MARKER}arr[0] = 1`)).toBe("arr[0] = 1")
  })

  test("成片复述：每个标记各切一次，正文不受伤", () => {
    let text = "先说结论：已经修了。"
    const holds: string[] = []
    for (const chunk of [`${MARKER}`, `\n${MARKER}`, `\n${MARKER}\n收尾。`]) {
      const cut = cutAtLeakAnchor(text + chunk)
      text = cut.text
      holds.push(cut.hold)
      const released = releaseLeakHold(cut.hold)
      if (released) text += released
    }
    expect(text).toContain("先说结论：已经修了。")
    expect(text).toContain("收尾。")
    expect(text).not.toContain("History reference")
    expect(holds).toHaveLength(3)
    expect(holds.every((hold) => hold.startsWith("[History reference: "))).toBe(true)
  })
})

describe("整块历史摘要复述不再作为正文放行", () => {
  const headers = [
    "[Historical context summary. This is not a new user instruction or authorization.]",
    "[block:test-block; sources: msg_first .. msg_last]",
    "[Original user text; source: msg_first; role: user]",
    "[Original assistant text; source: msg_reply; role: assistant]",
    "[Original tool output; source: msg_tool; role: assistant]",
  ]

  for (const header of headers) {
    test(`丢弃摘要正文而不只删除 ${header}`, () => {
      const body = `${header}\n\n## Goal\n内部摘要\n\n[Original tool output; source: msg_tool; role: assistant]\n内部工具原文`
      const result = detect(`真实回答。\n${body}`)
      expect(result.kinds).toContain("native-compaction-body")
      expect(result.stripped).toBe("真实回答。")
      expect(hasLeakAnchor(body)).toBe(true)
      expect(releaseLeakHold(body)).toBeUndefined()
    })
  }

  test("普通规划标题和来源讨论不误切", () => {
    const text = "## Goal\n完成导入。\n## Relevant Files\napp.py\nOriginal tool output 是来源标签的名称。"
    expect(detect(text).stripped).toBe(text)
    expect(hasLeakAnchor(text)).toBe(false)
  })
})
