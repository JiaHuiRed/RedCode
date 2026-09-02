import { describe, expect, test } from "bun:test"
import { Freeform } from "@/tool/freeform"

const model = (over: { providerID?: string; id?: string; npm?: string } = {}) => ({
  providerID: over.providerID ?? "openai",
  api: {
    id: over.id ?? "gpt-5.2-codex",
    npm: over.npm ?? "@ai-sdk/openai",
  },
})

describe("Freeform.supported", () => {
  test("官方 openai provider 上的 gpt-5 家族走 freeform", () => {
    expect(Freeform.supported(model())).toBe(true)
    expect(Freeform.supported(model({ id: "gpt-5" }))).toBe(true)
    expect(Freeform.supported(model({ id: "gpt-5-nano" }))).toBe(true)
    expect(Freeform.supported(model({ id: "gpt-5.4" }))).toBe(true)
  })

  test("gpt-5-chat 不吃 custom tool", () => {
    expect(Freeform.supported(model({ id: "gpt-5-chat" }))).toBe(false)
    expect(Freeform.supported(model({ id: "gpt-5.2-chat-latest" }))).toBe(false)
  })

  test("锚在串首或 / 上，不误伤形近 id", () => {
    expect(Freeform.supported(model({ id: "gpt-50" }))).toBe(false)
    expect(Freeform.supported(model({ id: "gpt-5o" }))).toBe(false)
    expect(Freeform.supported(model({ id: "gpt-4.1" }))).toBe(false)
  })

  // custom tool 只存在于 Responses API，而只有 providerID==="openai" 这条路
  // 在 provider.ts 里固定走 sdk.responses()。中转/兼容层没验过，一律不开。
  test("非官方 openai provider 一律不开", () => {
    expect(Freeform.supported(model({ providerID: "opencode-go" }))).toBe(false)
    expect(Freeform.supported(model({ providerID: "azure", npm: "@ai-sdk/azure" }))).toBe(false)
    expect(Freeform.supported(model({ npm: "@ai-sdk/openai-compatible" }))).toBe(false)
  })

  test("REDCODE_DISABLE_FREEFORM_TOOLS=1 是逃生口", () => {
    const prev = process.env["REDCODE_DISABLE_FREEFORM_TOOLS"]
    process.env["REDCODE_DISABLE_FREEFORM_TOOLS"] = "1"
    try {
      expect(Freeform.supported(model())).toBe(false)
    } finally {
      if (prev === undefined) delete process.env["REDCODE_DISABLE_FREEFORM_TOOLS"]
      else process.env["REDCODE_DISABLE_FREEFORM_TOOLS"] = prev
    }
  })
})

describe("Freeform.spec", () => {
  test("只有 apply_patch 有 freeform 形态", () => {
    expect(Freeform.spec(model(), "apply_patch")).toBeDefined()
    expect(Freeform.spec(model(), "edit")).toBeUndefined()
    expect(Freeform.spec(model(), "shell")).toBeUndefined()
  })

  test("模型不支持时连 apply_patch 也不给", () => {
    expect(Freeform.spec(model({ providerID: "anthropic" }), "apply_patch")).toBeUndefined()
  })

  test("文法覆盖 add/delete/update 三种 hunk 与 EOF 标记", () => {
    const grammar = Freeform.spec(model(), "apply_patch")!.grammar
    expect(grammar).toContain("*** Begin Patch")
    expect(grammar).toContain("*** End Patch")
    expect(grammar).toContain("*** Add File: ")
    expect(grammar).toContain("*** Delete File: ")
    expect(grammar).toContain("*** Update File: ")
    expect(grammar).toContain("*** Move to: ")
    expect(grammar).toContain("*** End of File")
  })
})

describe("Freeform.normalizeInput", () => {
  const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n"

  test("裸字符串还原成执行器认识的对象入参", () => {
    expect(Freeform.normalizeInput("apply_patch", patch)).toEqual({ patchText: patch })
  })

  test("已经是对象的入参不碰（走原路径）", () => {
    expect(Freeform.normalizeInput("apply_patch", { patchText: patch })).toBeUndefined()
  })

  test("没有 freeform 形态的工具不碰", () => {
    expect(Freeform.normalizeInput("shell", "ls -la")).toBeUndefined()
  })

  // 这条钉住 processor.toolInput 的兜底分支：normalizeInput 认领不了的，
  // 才允许掉进 { value } —— 认领得了的必须还原成对象，否则 apply_patch 的
  // diff 视图拿不到 patchText，整个渲染不出来。
  test("空补丁字符串仍然认领（不掉进 { value } 兜底）", () => {
    expect(Freeform.normalizeInput("apply_patch", "")).toEqual({ patchText: "" })
  })
})
