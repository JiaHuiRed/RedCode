import { describe, expect, test } from "bun:test"
import { provider } from "../../src/session/system"
import PROMPT_GLM from "../../src/session/prompt/glm.md" with { type: "text" }
import PROMPT_DEFAULT from "../../src/session/prompt/default.md" with { type: "text" }
import PROMPT_DEEPSEEK from "../../src/session/prompt/deepseek.md" with { type: "text" }

// 260827 cc GLM-5.3 起改走 default.md。glm.md 是给 5.1/5.2 那代写的管教式稿子，而 5.3-Flash
// 就是先前以 ox-alpha / x-preview 名义在跑、一直落 default.md 的那个模型——换成官方名字接入后
// api.id 里多了 "glm"，就被换了提示词。这几条钉住版本分界，避免以后有人把规则改回按名字匹配。
const model = (apiID: string, providerID = "zhipuai-coding-plan") =>
  ({ api: { id: apiID }, providerID }) as unknown as Parameters<typeof provider>[0]

describe("system prompt routing", () => {
  test("GLM-5.3 及以后走 default.md", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3", "glm-5.4", "glm-6.0-flash", "GLM-5.3-Flash"])
      expect(provider(model(id))).toEqual([PROMPT_DEFAULT])
  })

  test("GLM-5.2 及以下维持 glm.md", () => {
    for (const id of ["glm-5.2", "glm-5.1", "glm-4.6"]) expect(provider(model(id))).toEqual([PROMPT_GLM])
  })

  test("qwen 不受影响", () => {
    expect(provider(model("qwen3.7-plus", "opencode-go"))).toEqual([PROMPT_GLM])
  })

  test("ox-alpha / x-preview 这些别名本来就走 default.md，改动前后一致", () => {
    for (const id of ["ox-alpha-free", "x-preview-f-free"]) expect(provider(model(id, "opencode"))).toEqual([PROMPT_DEFAULT])
  })

  test("deepseek 路由未被波及", () => {
    expect(provider(model("deepseek-v4-flash-vision-exp", "deepseek"))).toEqual([PROMPT_DEEPSEEK])
  })
})
