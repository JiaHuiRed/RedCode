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
