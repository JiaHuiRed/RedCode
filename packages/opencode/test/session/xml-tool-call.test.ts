import { describe, expect, test } from "bun:test"
import { detect, recoveryPrompt } from "../../src/session/xml-tool-call"

const TOOLS = new Set(["bash", "todowrite", "glob", "edit", "read", "grep", "write"])

describe("xml-tool-call.detect", () => {
  test("正常输出不受影响，且走快路径", () => {
    const text = "改完了，跑一下测试确认。"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([])
    expect(result.stripped).toBe(text)
  })

  test("摘出带外层 <tool_call> 包裹的调用", () => {
    // 取自 redcode.db prt_fa285782a001NfZMc87DJQKJoe（2026-07-27 实际泄漏）
    const text =
      "我现在立刻定位异常值来源，不再盲改。<tool_call>\n<function=bash>\n<parameter=command>\npython scan_tiny_values.py\n</parameter>\n<parameter=description>\nScan for tiny values\n</parameter>\n</function>\n</tool_call>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([
      {
        name: "bash",
        params: { command: "python scan_tiny_values.py", description: "Scan for tiny values" },
      },
    ])
    expect(result.stripped).toBe("我现在立刻定位异常值来源，不再盲改。")
  })

  test("摘出同一段里的多个连续调用", () => {
    // 取自 prt_fa14cbad6001xACLw34zXlXpfW（reasoning 通道泄漏，两个调用背靠背）
    const text =
      "先找到这个文件。<tool_call>\n<function=glob>\n<parameter=pattern>\n*.xlsx\n</parameter>\n</function>\n</tool_call><tool_call>\n<function=bash>\n<parameter=command>\nGet-ChildItem -Filter *.xlsx\n</parameter>\n</function>\n</tool_call>"
    const result = detect(text, TOOLS)
    expect(result.calls.map((call) => call.name)).toEqual(["glob", "bash"])
    expect(result.calls[0].params).toEqual({ pattern: "*.xlsx" })
    expect(result.stripped).toBe("先找到这个文件。")
  })

  test("没有外层包裹也能认出来", () => {
    const text = "读一下。\n<function=read>\n<parameter=filePath>\nE:\\AI\\RedCode\\package.json\n</parameter>\n</function>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([{ name: "read", params: { filePath: "E:\\AI\\RedCode\\package.json" } }])
    expect(result.stripped).toBe("读一下。")
  })

  test("被截断（无 </function>）也能认出来，吃到末尾", () => {
    const text = "写文件。<tool_call>\n<function=write>\n<parameter=filePath>\na.txt\n</parameter>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([{ name: "write", params: { filePath: "a.txt" } }])
    expect(result.stripped).toBe("写文件。")
  })

  test("参数值内部空白与换行原样保留，只吃掉紧贴标签的那一对", () => {
    const text = "<function=write>\n<parameter=content>\nline1\n\n  indented\nline3\n</parameter>\n</function>"
    const result = detect(text, TOOLS)
    expect(result.calls[0].params.content).toBe("line1\n\n  indented\nline3")
  })

  test("未注册的工具名不算命中 —— 讨论这个 bug 本身时的主要防线", () => {
    const text = "泄漏长这样：<tool_call>\n<function=some_unknown_tool>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([])
    expect(result.stripped).toBe(text)
  })

  test("无参数调用", () => {
    const text = "<function=todowrite>\n</function>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([{ name: "todowrite", params: {} }])
    expect(result.stripped).toBe("")
  })

  test("摘除后不留多余空行", () => {
    const text = "前面\n\n<function=glob>\n<parameter=pattern>\n*.ts\n</parameter>\n</function>\n\n后面"
    const result = detect(text, TOOLS)
    expect(result.stripped).toBe("前面\n\n后面")
  })

  test("孤儿结束标签尾巴被摘除（260809 实测 deepseek-v4-flash）", () => {
    // 取自 m0215（TUI 渲染问题排查会话）：正文末尾粘 </parameter></invoke></tool_calls>
    const text = "现在剩下的就是 PTY 功能 commit，哥哥点头我就提交。\n\n\n\n</parameter>\n</invoke>\n</tool_calls>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([])
    expect(result.stripped).toBe("现在剩下的就是 PTY 功能 commit，哥哥点头我就提交。")
  })

  test("正文里讨论孤儿标签不误伤（少一个标签/不在尾部/前面无空行）", () => {
    const text = "就是这三行嘛：\n</parameter>\n</invoke>\n</tool_calls>"
    const result = detect(text, TOOLS)
    expect(result.calls).toEqual([])
    expect(result.stripped).toBe(text)
  })
})

describe("xml-tool-call.recoveryPrompt", () => {
  test("列出解析结果并要求用原生通道重发", () => {
    const prompt = recoveryPrompt([{ name: "bash", params: { command: "ls -la" } }])
    expect(prompt).toContain("- bash")
    expect(prompt).toContain("command: ls -la")
    expect(prompt).toContain("native tool-call")
  })

  test("超长参数值被截断，避免把 60KB 的 write content 原样回灌", () => {
    const prompt = recoveryPrompt([{ name: "write", params: { content: "x".repeat(5000) } }])
    expect(prompt).toContain("…(truncated)")
    expect(prompt.length).toBeLessThan(1000)
  })
})

// 260730 Karina 第二种形状：<工具名><args><参数名>…</参数名></args></工具名>。
// step-3.7-flash 07-30 实测吐的是这种，而旧逻辑快路径只认 <function=，第一行就短路返回，
// 既没打捞也没摘除 —— 原始 XML 留在正文里，本轮零个 tool part 却是 finish:stop，
// 看起来就像"它自己停了"。库里那轮的构成：step-start reasoning(778) text(261) step-finish。
describe("detect —— <args> 形状", () => {
  const KNOWN = new Set(["edit", "read", "bash"])

  test("★线上原样：<edit><args>…，参数值里还带别的标签", () => {
    // 取自 redcode.db 那一轮的正文
    const text = [
      "这样改动最小。",
      "",
      "<edit>",
      "  <args>",
      "    <filePath>C:\\work\\project\\templates\\index.html</filePath>",
      `    <oldString>    + '</tr></thead><tbody id="acct-tbody">';</oldString>`,
      `    <newString>    + '</tr></thead><tbody class="cr-tbody" id="acct-tbody">';</newString>`,
      "  </args>",
      "</edit>",
    ].join("\n")

    const out = detect(text, KNOWN)
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0].name).toBe("edit")
    expect(out.calls[0].params.filePath).toBe("C:\\work\\project\\templates\\index.html")
    // 反向引用切得准：值里的 </tr></thead> 不该把 oldString 提前截断
    expect(out.calls[0].params.oldString).toContain(`</tr></thead><tbody id="acct-tbody">`)
    expect(out.calls[0].params.newString).toContain("cr-tbody")
    // 正文里的 XML 要摘干净，只剩人话
    expect(out.stripped).toBe("这样改动最小。")
  })

  test("工具名对不上不认（主要误判防线）", () => {
    const text = "<article>\n  <args>\n    <x>1</x>\n  </args>\n</article>"
    expect(detect(text, KNOWN).calls).toHaveLength(0)
    expect(detect(text, KNOWN).stripped).toBe(text)
  })

  test("光有工具名、后面不是 <args> 不认", () => {
    const text = "讨论一下 <edit> 这个标签该怎么用。"
    expect(detect(text, KNOWN).calls).toHaveLength(0)
    expect(detect(text, KNOWN).stripped).toBe(text)
  })

  test("被截断没有闭合标签也能捞出来", () => {
    const text = "<edit>\n  <args>\n    <filePath>a.ts</filePath>"
    const out = detect(text, KNOWN)
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0].params.filePath).toBe("a.ts")
  })

  test("同一段正文里两种形状混着出现，都要捞到且摘干净", () => {
    const text = [
      "先读再改：",
      "<function=read>",
      "<parameter=filePath>a.ts</parameter>",
      "</function>",
      "然后",
      "<edit>",
      "  <args>",
      "    <filePath>a.ts</filePath>",
      "  </args>",
      "</edit>",
      "完成。",
    ].join("\n")

    const out = detect(text, KNOWN)
    expect(out.calls.map((c) => c.name)).toEqual(["read", "edit"])
    expect(out.stripped).not.toContain("<function=")
    expect(out.stripped).not.toContain("<args>")
    expect(out.stripped).toContain("先读再改")
    expect(out.stripped).toContain("完成。")
  })

  test("两种标签都没有时走快路径，原样返回同一个字符串", () => {
    const text = "普通回复，没有任何标签。"
    const out = detect(text, KNOWN)
    expect(out.calls).toHaveLength(0)
    expect(out.stripped).toBe(text)
  })
})
