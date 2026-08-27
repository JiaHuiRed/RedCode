import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"

// 260729 Red 依据智谱官方「核心参数说明」：
//   reasoning_effort 仅 GLM-5.2 及以上支持；GLM-4.5~5.1 只有 thinking.type 二值开关。
const glm = (id: string, npm = "@ai-sdk/openai-compatible", providerID = "opencode-go") =>
  ({
    id,
    providerID,
    api: { id, npm },
    capabilities: { reasoning: true, temperature: true },
    limit: { context: 200_000, output: 16_000 },
  }) as unknown as Provider.Model

const variantsOf = (id: string, npm?: string) => Object.keys(ProviderTransform.variants(glm(id, npm)))

describe("GLM 推理强度变体", () => {
  test("GLM-5.2 暴露三档真实行为，不暴露别名", () => {
    expect(variantsOf("glm-5.2")).toEqual(["none", "high", "max"])
  })

  test("别名不出现在档位里（low/medium 会被官方映射成 high，xhigh 映射成 max）", () => {
    const v = variantsOf("glm-5.2")
    for (const alias of ["low", "medium", "xhigh", "minimal"]) expect(v).not.toContain(alias)
  })

  test("档位发的是 reasoningEffort，值与档位名一致", () => {
    const v = ProviderTransform.variants(glm("glm-5.2"))
    expect(v["max"]).toEqual({ reasoningEffort: "max" })
    expect(v["none"]).toEqual({ reasoningEffort: "none" })
  })

  test("GLM-5.1 及以下不给档位 —— 它们只有 thinking 二值开关", () => {
    for (const id of ["glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5"]) {
      expect(variantsOf(id)).toEqual([])
    }
  })

  test("glm-5-turbo / glm-5v-turbo 是 5.0 不是 5.2，不给档位", () => {
    expect(variantsOf("glm-5-turbo")).toEqual([])
    expect(variantsOf("glm-5v-turbo")).toEqual([])
  })

  test("更高版本自动跟上，不需要再改代码", () => {
    expect(variantsOf("glm-5.3")).toEqual(["none", "high", "max"])
    expect(variantsOf("glm-6")).toEqual(["none", "high", "max"])
  })

  test("其余仍在排除表里的模型不受影响", () => {
    for (const id of ["qwen3-coder", "minimax-m2"]) {
      expect(variantsOf(id)).toEqual([])
    }
  })
})

// xAI 官方文档：grok-4.5 支持 reasoning_effort，取值 low/medium/high，默认 high，无法禁用推理
describe("grok 推理强度变体", () => {
  test("grok-4.5 给出 low/medium/high", () => {
    expect(variantsOf("grok-4.5")).toEqual(["low", "medium", "high"])
  })

  test("不给 none —— 官方明确无法禁用推理", () => {
    expect(variantsOf("grok-4.5")).not.toContain("none")
  })

  test("4.5 以下不给档位（除 grok-3-mini 走它自己的分支）", () => {
    for (const id of ["grok-4", "grok-4.2", "grok-4.3", "grok-3"]) {
      expect(variantsOf(id)).toEqual([])
    }
  })

  test("grok-3-mini 保持原有 low/high 两档，未被波及", () => {
    expect(variantsOf("grok-3-mini")).toEqual(["low", "high"])
  })

  test("更高版本自动跟上", () => {
    expect(variantsOf("grok-5")).toEqual(["low", "medium", "high"])
  })
})

// Moonshot 官方文档：K3 始终开启思考，reasoning_effort 取值 low/high/max，默认 max
describe("kimi 推理强度变体", () => {
  test("kimi-k3 给出 low/high/max —— 有 max 无 medium，与 grok 那套不同", () => {
    expect(variantsOf("kimi-k3")).toEqual(["low", "high", "max"])
  })

  test("k2 系列只有思考开关、无强度维度，仍不给档位", () => {
    for (const id of ["kimi-k2", "kimi-k2.5", "kimi-k2-thinking"]) {
      expect(variantsOf(id)).toEqual([])
    }
  })

  test("更高版本自动跟上", () => {
    expect(variantsOf("kimi-k4")).toEqual(["low", "high", "max"])
  })
})

describe("GLM thinking 参数注入", () => {
  const options = (model: Provider.Model) =>
    ProviderTransform.options({ model, sessionID: "ses_test" as any, providerOptions: {} } as any)

  test("opencode-go 上的 GLM 也拿得到 thinking —— 判据已从 provider 名改为模型本身", () => {
    const result = options(glm("glm-5.2", "@ai-sdk/openai-compatible", "opencode-go"))
    expect(result["thinking"]).toEqual({ type: "enabled", clear_thinking: false })
  })

  test("zhipuai / zai 原有路径不受影响", () => {
    for (const p of ["zhipuai", "zai"]) {
      expect(options(glm("glm-4.6", "@ai-sdk/openai-compatible", p))["thinking"]).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    }
  })

  test("非 GLM 且非 zai/zhipuai 的模型不注入 thinking", () => {
    const other = glm("deepseek-v4-flash", "@ai-sdk/openai-compatible", "opencode-go")
    expect(options(other)["thinking"]).toBeUndefined()
  })
})


  // 260802 Red: deepseek-v4 系列最强档按 provider 区分——官方 DeepSeek API 与
  // opencode-go 聚合供应商支持 max；sensenova 只认 low/medium/high/xhigh/none，
  // 用 xhigh 代替 max 作最强档。
  describe("deepseek-v4 走 openai-compatible 的档位", () => {
    const ds = (id: string, providerID: string) =>
      ({
        id,
        providerID,
        api: { id, npm: "@ai-sdk/openai-compatible" },
        capabilities: { reasoning: true, temperature: true },
        limit: { context: 1_000_000, output: 64_000 },
      }) as Provider.Model

    test("官方 deepseek 的 deepseek-v4-pro 保留 max 档", () => {
      const v = ProviderTransform.variants(ds("deepseek-v4-pro", "deepseek"))
      expect(v["max"]).toEqual({ reasoningEffort: "max" })
    })

    test("opencode-go 聚合供应商的 deepseek-v4 也保留 max 档", () => {
      const v = ProviderTransform.variants(ds("deepseek-v4-flash", "opencode-go"))
      expect(v["max"]).toEqual({ reasoningEffort: "max" })
    })

    test("sensenova 的 deepseek-v4-flash 用 xhigh 代替 max（API 只认 low/medium/high/xhigh/none）", () => {
      const v = ProviderTransform.variants(ds("deepseek-v4-flash", "sensenova"))
      expect(Object.keys(v)).toEqual(["low", "medium", "high", "xhigh"])
      expect(v["xhigh"]).toEqual({ reasoningEffort: "xhigh" })
      expect(v["max"]).toBeUndefined()
    })
})

// 260814 Red 推理档位数据驱动（models.dev reasoning_options）——决策：数据打底、硬编码表覆盖。
// 数据只在"通用猜测"兜底路径生效；实测校准的特判（GLM/KIMI/DeepSeek 等）必须压住数据。
describe("reasoning_options 数据驱动档位", () => {
  const make = (id: string, reasoningOptions: unknown, npm = "@ai-sdk/openai-compatible", providerID = "opencode-go") =>
    ({
      id,
      providerID,
      api: { id, npm },
      capabilities: { reasoning: true, temperature: true },
      limit: { context: 200_000, output: 16_000 },
      reasoningOptions,
    }) as unknown as Provider.Model

  test("无特判家族 + effort 数据：数据压过 WIDELY 通用猜测", () => {
    const v = ProviderTransform.variants(make("future-model-9", [{ type: "effort", values: ["low", "ultra"] }]))
    expect(Object.keys(v)).toEqual(["low", "ultra"])
    expect(v["ultra"]).toEqual({ reasoningEffort: "ultra" })
  })

  test("values 里的 null 映射为 none 档", () => {
    const v = ProviderTransform.variants(make("future-model-9", [{ type: "effort", values: [null, "high"] }]))
    expect(Object.keys(v)).toEqual(["none", "high"])
  })

  test("无数据：通用猜测照旧（low/medium/high）", () => {
    const v = ProviderTransform.variants(make("future-model-9", undefined))
    expect(Object.keys(v)).toEqual(["low", "medium", "high"])
  })

  test("deepseek-v4 校准表压住错误数据", () => {
    const v = ProviderTransform.variants(
      make("deepseek-v4-pro", [{ type: "effort", values: ["wrong-a", "wrong-b"] }], "@ai-sdk/openai-compatible", "deepseek"),
    )
    expect(Object.keys(v)).toEqual(["low", "high", "max"])
  })

  test("GLM-5.2 校准表压住错误数据", () => {
    const v = ProviderTransform.variants(make("glm-5.2", [{ type: "effort", values: ["wrong"] }]))
    expect(Object.keys(v)).toEqual(["none", "high", "max"])
  })

  test("budget_tokens/toggle 型不消化，退回通用猜测", () => {
    const v = ProviderTransform.variants(
      make("future-model-9", [{ type: "budget_tokens", min: 1024, max: 32768 }, { type: "toggle" }]),
    )
    expect(Object.keys(v)).toEqual(["low", "medium", "high"])
  })

  test("未知 npm + effort 数据：数据是唯一线索，生效", () => {
    const v = ProviderTransform.variants(make("novel-model", [{ type: "effort", values: ["low", "high"] }], "@ai-sdk/brand-new"))
    expect(Object.keys(v)).toEqual(["low", "high"])
  })

  test("未知 npm 无数据：维持空表", () => {
    expect(ProviderTransform.variants(make("novel-model", undefined, "@ai-sdk/brand-new"))).toEqual({})
  })

  test("垃圾数据不炸：非数组 / 空 values / 非字符串值 / 空字符串 全部退回硬编码", () => {
    for (const junk of ["effort", { type: "effort" }, [{ type: "effort", values: [] }], [{ type: "effort", values: [42, ""] }], [null]]) {
      const v = ProviderTransform.variants(make("future-model-9", junk))
      expect(Object.keys(v)).toEqual(["low", "medium", "high"])
    }
  })

  test("重复档位值去重", () => {
    const v = ProviderTransform.variants(make("future-model-9", [{ type: "effort", values: ["high", "high", null, null] }]))
    expect(Object.keys(v)).toEqual(["high", "none"])
  })
})

// 260827 cc claude 经 openai-compatible 中转接入：Anthropic 没有 reasoning_effort 这个维度，
// 中转站把思考做成独立模型 id（本机 justwoker 的目录是 claude-opus-5 / claude-opus-5-thinking
// 两张卡、两个价），所以这条路径一个档位都不该给——否则页脚摆的是上游不认的 low/medium/high。
describe("claude 走 openai-compatible 中转", () => {
  test("不给任何档位（含 -thinking 变体）", () => {
    for (const id of ["claude-opus-5", "claude-opus-5-thinking", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(variantsOf(id)).toEqual([])
    }
  })

  test("走原生 anthropic npm 时不受这条影响，档位照给", () => {
    expect(variantsOf("claude-opus-4-7", "@ai-sdk/anthropic")).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("不误伤同一 npm 下的其他家族", () => {
    expect(variantsOf("glm-5.2")).toEqual(["none", "high", "max"])
  })
})
