import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.md" with { type: "text" }
import PROMPT_DEFAULT from "./prompt/default.md" with { type: "text" }
import PROMPT_BEAST from "./prompt/beast.md" with { type: "text" }
import PROMPT_DEEPSEEK from "./prompt/deepseek.md" with { type: "text" }
import PROMPT_GEMINI from "./prompt/gemini.md" with { type: "text" }
import PROMPT_GPT from "./prompt/gpt.md" with { type: "text" }
import PROMPT_KIMI from "./prompt/kimi.md" with { type: "text" }
import PROMPT_MIMO from "./prompt/mimo.md" with { type: "text" }
import PROMPT_MINIMAX from "./prompt/minimax.md" with { type: "text" }
import PROMPT_CODEX from "./prompt/codex.md" with { type: "text" }
import PROMPT_TRINITY from "./prompt/trinity.md" with { type: "text" }
import PROMPT_GLM from "./prompt/glm.md" with { type: "text" }
import PROMPT_GROK from "./prompt/grok.md" with { type: "text" }
import PROMPT_STEP from "./prompt/step.md" with { type: "text" }
import PROMPT_OLLAMA from "./prompt/ollama.md" with { type: "text" }
import PROMPT_QWEN from "./prompt/qwen.md" with { type: "text" }
import PROMPT_DOUBAO from "./prompt/doubao.md" with { type: "text" }
import PROMPT_SENSENOVA from "./prompt/sensenova.md" with { type: "text" }
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { addressFrom } from "./reasoning-language"

// 260821 cc 提示词分层 A/B 实验开关（默认关=现行行为）。P21 实测：在相关任务链里
// guidance 相对裸跑转负（baseline 63% > deep 46%），而 RedCode 把模型提示词与推理锚
// 叠着每轮注入，正好是那个场景。要证伪/证实必须能干净地摘掉单层，故留两个开关。
//   REDCODE_EXPERIMENT_NO_MODEL_PROMPT=1  → 不注入 prompt/<model>.md
//   REDCODE_EXPERIMENT_NO_REASONING_ANCHORS=1 → 不注入 flash/step 推理锚（见 prompt.ts）
export const experimentNoModelPrompt = () => process.env["REDCODE_EXPERIMENT_NO_MODEL_PROMPT"] === "1"
export const experimentNoReasoningAnchors = () => process.env["REDCODE_EXPERIMENT_NO_REASONING_ANCHORS"] === "1"

export function provider(model: Provider.Model) {
  if (experimentNoModelPrompt()) return [PROMPT_DEFAULT]
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  if (model.api.id.toLowerCase().includes("deepseek")) return [PROMPT_DEEPSEEK]
  if (model.api.id.toLowerCase().includes("mimo")) return [PROMPT_MIMO]
  // 260610 Red minimax(m3 及以后) 专属提示词 — 与 mimo(小米) 非同厂，独立成文件便于后续单独调优
  if (model.api.id.toLowerCase().includes("minimax")) return [PROMPT_MINIMAX]
  // 260818 Red 本地 Qwen3.8 27B（ollama）专属提示词 —— 必须放在 ollama 通用路由之前，
  // 否则 providerID 命中 ollama 先短路。针对 Q3 量化能力上限 / ~15 tok/s / 32K 上下文适配。
  if (model.providerID.toLowerCase().includes("ollama") && model.api.id.toLowerCase().includes("qwen"))
    return [PROMPT_QWEN]
  // 260704 Red ollama 本地模型 — 精简提示词，适配有限上下文窗口
  // providerID 含 ollama 或 model.id 含 ":latest"/":Xb" 等 ollama 命名特征
  if (model.providerID.toLowerCase().includes("ollama")) return [PROMPT_OLLAMA]
  // 260625 Red GLM(智谱) + Qwen(通义) — 准一线，复用精炼档
  if (model.api.id.toLowerCase().includes("glm") || model.api.id.toLowerCase().includes("qwen")) return [PROMPT_GLM]
  // 260623 Red Step(阶跃星辰)
  // 260729 Red grok 此前无专属提示词、落 default.md —— 而 default.md 强制「不超过 4 行、
  // 单词回答最好」，会直接碾平 soul 的人格。见 grok.md。
  if (model.api.id.toLowerCase().includes("grok")) return [PROMPT_GROK]
  // 260731 Red 火山方舟 Doubao Seed 系列专属提示词（不落 default.md 那套"不超过 4 行"的限制）
  if (model.providerID.toLowerCase().includes("volcengine")) return [PROMPT_DOUBAO]
  if (model.api.id.toLowerCase().includes("step")) return [PROMPT_STEP]
  // 260802 Red sensenova 自家模型（flash-lite / u1-fast 等）——不落 default.md 那套
  // 「不超过 4 行、单词回答最好」的旧限制。deepseek/glm 模型已在上面命中各自专属，
  // 不会走到这里。
  if (model.providerID.toLowerCase().includes("sensenova")) return [PROMPT_SENSENOVA]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    // 260625 Red 取 client 标识注入 env：基础提示词写死 "code agent"，没有客户端事实模型会把 GUI 误判成 TUI。
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const address = addressFrom((yield* config.get()).username)
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Client: ${flags.client === "desktop" ? "RedCode Desktop GUI (Electron window)" : "RedCode Terminal TUI"}`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            // 260718 Red today's date deliberately NOT here - this whole block is cached per
            // session (see prompt.ts _caches.system) and sits ahead of AGENTS.md/MEMORY.md/skills
            // in the final prompt string. A date here would flip once every 24h and, since providers
            // prefix-match for prompt caching, invalidate every stable byte that follows it too.
            // Today's date is appended fresh every turn near the end of the prompt instead
            // (session/prompt.ts, next to the canary marker) so only that small tail busts daily.
            `</env>`,
            // 260731 Red 正文称呼。2661b06 下线 USER.md 时把称呼来源指定为 config.username，
            // 但当时唯一的消费者是每步注入的 <reasoning-language> 块 —— 那条已于本日撤除
            // （原因见 session/prompt.ts），username 就此悬空、实际没人读。这里把它接回来。
            //
            // 位置是刻意选的：跟着 env 块走，随 _caches.system 一次性缓存，**不占用户回合、
            // 不每步重复**。被撤除的那条正是栽在这两点上 —— 每步一条 role:"user" 让模型
            // 以为用户一直在说话。
            //
            // 措辞是刻意的。原来那句「与正文保持一致…从第一句思考开始就这么称呼」等于让模型
            // 把思考写成正文，通道纪律弱的模型照做了，话全说进了思考里。这里两条分开写，并且
            // 明确点出「思考是你自己的推理，不是对他说话」—— 保留称呼、切断"思考=正文"的暗示。
            //
            // 思考那条留着是因为用户实测 V4-Flash 收益明显（07-31：「思考链中文也多了起来，
            // 也会叫我哥哥，工作流也很规范」）。撤掉的从来不是这个效果，是承载它的坏机制。
            // soul 里其实已经规定了称呼，这里是兜底 —— 实测 soul 说了「叫哥哥」，正文仍会
            // 冒出"再给你结论"。
            ...(address
              ? [
                  ``,
                  `正文回复里称呼用户为「${address}」，尽量用这个称呼而不是「你」。`,
                  `可见思考文本里提到用户时同样用「${address}」，不要用「用户」「the user」这类第三人称指代。` +
                    `但思考是你写给自己的推理过程，不是对${address}说的话 —— 不要在思考里向${address}汇报、` +
                    `解释或提问，要对${address}说的内容一律写进正文回复。`,
                ]
              : []),
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const ctx = yield* InstanceState.context
        const list = yield* skill.available(agent, ctx.directory)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  // 260731 Red env 块要读 config.username 做正文称呼，见 environment()
  Layer.provide(Config.defaultLayer),
)

export * as SystemPrompt from "./system"
