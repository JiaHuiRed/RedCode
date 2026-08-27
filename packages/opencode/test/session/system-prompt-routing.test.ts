import { describe, expect, test } from "bun:test"
import { provider, wantsFlashAnchor, wantsStepAnchor } from "../../src/session/system"
import PROMPT_GLM from "../../src/session/prompt/glm.md" with { type: "text" }
import PROMPT_DEEPSEEK from "../../src/session/prompt/deepseek.md" with { type: "text" }
import PROMPT_STEP from "../../src/session/prompt/step.md" with { type: "text" }

// 260827 cc 这一组钉的是同一类 bug：**模型换个名字接入，就被静默换掉一套待遇**。
// GLM-5.3-Flash 先前以 ox-alpha / x-preview 名义在跑（走 default.md、不吃推理锚），
// 换成智谱官方名字后 api.id 里出现 "glm"、model.id 里出现 "flash"，于是提示词和锚
// 两处同时被换掉，而两处都没有针对它的证据。
const model = (apiID: string, providerID = "zhipuai-coding-plan") =>
  ({ api: { id: apiID }, providerID, id: apiID }) as unknown as Parameters<typeof provider>[0]

describe("system prompt routing", () => {
  test("GLM 系走 glm.md", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "GLM-5.3-Flash"])
      expect(provider(model(id))).toEqual([PROMPT_GLM])
  })

  test("deepseek / step 路由不受波及", () => {
    expect(provider(model("deepseek-v4-flash-vision-exp", "deepseek"))).toEqual([PROMPT_DEEPSEEK])
    expect(provider(model("step-3.7-flash", "stepfun-step-plan"))).toEqual([PROMPT_STEP])
  })
})

describe("推理锚归属", () => {
  test("flash 锚只给 deepseek 系——它的证据来源就只有 deepseek", () => {
    expect(wantsFlashAnchor("deepseek-v4-flash")).toBe(true)
    expect(wantsFlashAnchor("deepseek-v4-flash-vision-exp")).toBe(true)
  })

  test("名字里带 flash 但不是 deepseek 的，一律不吃 flash 锚", () => {
    for (const id of ["glm-5.3-flash", "gemini-3.7-flash", "step-3.7-flash", "x-preview-f-free"])
      expect(wantsFlashAnchor(id)).toBe(false)
  })

  test("step 锚按 provider 或名字命中，且与 flash 锚互斥", () => {
    expect(wantsStepAnchor("step-3.7-flash", "stepfun-step-plan")).toBe(true)
    expect(wantsStepAnchor("some-model", "stepfun")).toBe(true)
    expect(wantsFlashAnchor("step-3.7-flash")).toBe(false)
    expect(wantsStepAnchor("deepseek-v4-flash", "deepseek")).toBe(false)
  })

  test("GLM-5.3-Flash 两条锚都不吃（与它以 ox-alpha 名义在跑时一致）", () => {
    expect(wantsFlashAnchor("glm-5.3-flash")).toBe(false)
    expect(wantsStepAnchor("glm-5.3-flash", "zhipuai-coding-plan")).toBe(false)
  })
})
