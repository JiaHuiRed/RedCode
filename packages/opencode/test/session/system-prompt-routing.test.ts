import { describe, expect, test } from "bun:test"
import { provider, wantsFlashAnchor, wantsStepAnchor } from "../../src/session/system"
import PROMPT_GLM from "../../src/session/prompt/glm.md" with { type: "text" }
import PROMPT_DEEPSEEK from "../../src/session/prompt/deepseek.md" with { type: "text" }
import PROMPT_GPT from "../../src/session/prompt/gpt.md" with { type: "text" }
import PROMPT_STEP from "../../src/session/prompt/step.md" with { type: "text" }
import PROMPT_HY from "../../src/session/prompt/hy.md" with { type: "text" }
import PROMPT_QWEN from "../../src/session/prompt/qwen.md" with { type: "text" }
import PROMPT_DEFAULT from "../../src/session/prompt/default.md" with { type: "text" }

// 260827 cc 这一组钉的是同一类 bug：**模型换个名字接入，就被静默换掉一套待遇**。
// GLM-5.3-Flash 先前以 ox-alpha / x-preview 名义在跑（走 default.md、不吃推理锚），
// 换成智谱官方名字后 api.id 里出现 "glm"、model.id 里出现 "flash"，于是提示词和锚
// 两处同时被换掉，而两处都没有针对它的证据。
const model = (apiID: string, providerID = "zhipuai-coding-plan") =>
  ({ api: { id: apiID }, providerID, id: apiID }) as unknown as Parameters<typeof provider>[0]

describe("system prompt routing", () => {
  test("GLM 系走 default.md + glm.md", () => {
    for (const id of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "GLM-5.3-Flash"])
      expect(provider(model(id))).toEqual([PROMPT_DEFAULT, PROMPT_GLM])
  })

  test("GPT 系走 default.md + gpt.md", () => {
    expect(provider(model("gpt-5.6-luna", "openai"))).toEqual([PROMPT_DEFAULT, PROMPT_GPT])
  })

  test("已删除专属提示词的 Claude 系走默认提示词", () => {
    expect(provider(model("claude-sonnet-4-5", "anthropic"))).toEqual([PROMPT_DEFAULT])
  })

  // 261013 Red 当前 GPT Delta 继承公共提示词与 Soul，不再单独重复声线规则。
  test("GPT Delta 继承公共交付契约与 soul", () => {
    expect(PROMPT_DEFAULT).toContain("First sentence responds to the user's actual intent.")
    expect(PROMPT_DEFAULT).toContain("语气、称呼、详略由 soul（人格文件）决定")
    expect(PROMPT_GPT).toContain("Use the common RedCode prompt, repository instructions, tool contracts, and soul.")
    expect(PROMPT_GPT).not.toContain("## Final answer")
  })

 test("GPT Delta defaults to action without relaxing non-trivial verification", () => {
   expect(PROMPT_GPT).toContain("Default to action")
   expect(PROMPT_GPT).toContain("Add only what the result needs")
   expect(PROMPT_GPT).toContain("Fix the defect on your path")
   expect(PROMPT_GPT).toContain("Prefer the smallest complete change")
 })

  // 260829 cc hy 的判据是 `hy` + 数字并带边界。写成 includes("hy") 会命中任何名字里
  // 带 hy 的模型，这一组就是钉住那条边界。
  test("Hy 系走 hy.md，两家 provider 的 id 形态都要命中", () => {
    for (const id of ["hy4-preview", "hy3", "tencent/hy4-preview", "Hy4-Preview"])
      expect(provider(model(id, "opencode-go"))).toEqual([PROMPT_HY])
  })

  test("名字里带 hy 但不是混元的，不许被 hy.md 捞走", () => {
    // 没有数字紧跟、或 hy 不在边界上的，一律落兜底
    for (const id of ["hyper-model", "why3-turbo", "physics-2"])
      expect(provider(model(id, "opencode-go"))).toEqual([PROMPT_DEFAULT])
  })

  // 261013 Red minimax.md / ollama.md 已删（不再用这两家）。删一条分支属于同一类改动——
  // 「模型换个名字接入就被静默换掉一套待遇」的反向版本，所以这里把新落点钉住：
  // minimax 与 ollama 上的非 qwen 模型落兜底，本地 qwen 仍走 qwen.md（该分支被保留）。
  test("已删专属档的 minimax / ollama 落兜底，本地 qwen 不受影响", () => {
    expect(provider(model("minimax-m2.5", "minimax"))).toEqual([PROMPT_DEFAULT])
    expect(provider(model("llama3.2", "ollama"))).toEqual([PROMPT_DEFAULT])
    expect(provider(model("qwen3.8", "ollama"))).toEqual([PROMPT_QWEN])
  })

  test("deepseek / Step 路由使用公共基线与专属 Delta", () => {
    expect(provider(model("deepseek-v4-flash-vision-exp", "deepseek"))).toEqual([PROMPT_DEFAULT, PROMPT_DEEPSEEK])
    for (const id of ["step-3.7-flash", "step-5-preview"])
      expect(provider(model(id, "stepfun-step-plan"))).toEqual([PROMPT_DEFAULT, PROMPT_STEP])
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

// 261001 Red Shared state transitions must not remain GPT-only after the contract migration.
describe("shared agent contract", () => {
  test("intent, completion, context and continuity belong to the common prompt", () => {
    for (const section of [
      "# Intent and scope",
      "# Autonomy and completion",
      "# Context efficiency",
      "# Steering and continuity",
    ])
      expect(PROMPT_DEFAULT).toContain(section)
    expect(PROMPT_DEFAULT).toContain("For inquiries, investigate and answer")
    expect(PROMPT_DEFAULT).toContain("Delegation transfers ownership")
    expect(PROMPT_DEFAULT).toContain("Do not ask again for authorization already granted")
    expect(PROMPT_DEFAULT).toContain("Compaction is context maintenance, not a task boundary")
    expect(PROMPT_GPT).not.toContain("## Mid-turn user messages")
    expect(PROMPT_GPT).not.toContain("When the conversation is summarized")
  })
})
