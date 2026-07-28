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
