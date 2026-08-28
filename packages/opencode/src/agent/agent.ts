import { Config } from "@/config/config"
import { serviceUse } from "@/effect/service-use"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.md" with { type: "text" }
import PROMPT_COMPACTION from "./prompt/compaction.md" with { type: "text" }
import DEFINITION_EXPLORE from "./definition/explore.md" with { type: "text" }
import DEFINITION_ADVISE from "./definition/advise.md" with { type: "text" }
import DEFINITION_EXECUTE from "./definition/execute.md" with { type: "text" }
import PROMPT_SUMMARY from "./prompt/summary.md" with { type: "text" }
import PROMPT_TITLE from "./prompt/title.md" with { type: "text" }
import matter from "gray-matter"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@redcode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { type DeepMutable } from "@redcode-ai/core/schema"

// 260828 cc 三个子代理工种的**唯一定义来源**是 src/agent/definition/*.md：frontmatter 给
// mode / description / model / variant / timeout_ms / permission，正文给提示词。这里用
// with { type: "text" } 在**构建期**把整份文件内联进二进制。
//
// 不能改成运行时读盘：src/ 不进发布包，而且 Info.prompt 在 llm/request.ts:60 是**替换**模型家族
// 提示词而非追加 —— 文件缺失不会报错，只会静默回落。
//
// 这三份也**不进 sync-home**（script/sync-home.bat 的 agent 块已删）：~/.redcode/agent/ 里一旦躺着
// 同名副本，ConfigAgent.load 会把同一段扁平白名单再 concat 到 `user` 之后，findLast 之下把下面补的
// external_directory 和用户全局 permission 一起作废。详见 docs/agent-roles-plan.md 修正八 / 修正九。
//
// ⚠ gray-matter 按内容缓存：同一份字符串两次 matter() 返回**同一个对象**，解出来的 data 绝不能就地改。
type Definition = { data: Record<string, any>; prompt: string }
const parseDefinition = (md: string): Definition => {
  const parsed = matter(md)
  return { data: parsed.data, prompt: parsed.content.trim() }
}
const DEFINITIONS = {
  explore: parseDefinition(DEFINITION_EXPLORE),
  advise: parseDefinition(DEFINITION_ADVISE),
  execute: parseDefinition(DEFINITION_EXECUTE),
}

// 260828 cc 老角色名 -> 合并后的目标。**按长期存在设计，不是「一轮过渡」**：
// session/compaction.ts 有四处直接 session.updateMessage 铸 role:"user" 消息，绕开 createUserMessage
// 与 Agent.get，把历史 agent 名原样重铸 —— 跑到自动压缩的老会话每压一次就再生一条 agent:"build"。
// live 库里 assistant 消息 agent="build" 17607 条、"general" 197 条。
//
// 解析顺序必须是**「直查优先、别名兜底」**：下面的配置循环对任何未知 key 都会凭空造出一个真角色，
// 别名优先就会把用户显式定义的同名角色劫持掉。详见 docs/agent-roles-plan.md 修正十 / 修正十二。
export const ALIAS: Record<string, string> = {
  build: "redmind",
  general: "execute",
  fixer: "execute",
  architect: "advise",
  reviewer: "advise",
  scout: "explore",
}

export const Info = Schema.Struct({
  name: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  // 260818 Red 子代理超时兑底：task 工具层超时后换 fallback 模型重跑一次
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description: "Subagent timeout in ms; on timeout the run is cancelled and retried with fallbackModel",
  }),
  fallbackModel: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ).annotate({
    description: "Fallback model for timed-out subagent runs (providerID/modelID)",
  }),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@redcode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          // 260803 Red workspace temp: keep the global C-drive temp whitelisted
          // for internal files, but also allow the workspace-local temp dir
          path.join(ctx.directory, ".redcode", "temp", "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          destructive: "ask",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          repo_clone: "deny",
          repo_overview: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        // 260828 cc 由 md 定义的工种：frontmatter -> Info 的字段映射只在这里做一次，
        // 不再在下面的 agents 记录里手写第二遍（4a/4b 时 description 与 permission 各有两份、且已经不一致）。
        const subagent = (name: keyof typeof DEFINITIONS): Info => {
          const { data, prompt } = DEFINITIONS[name]
          return {
            name,
            description: data.description,
            mode: data.mode ?? "subagent",
            native: true,
            prompt,
            options: {},
            ...(data.model ? { model: Provider.parseModel(data.model) } : {}),
            ...(data.fallback_model ? { fallbackModel: Provider.parseModel(data.fallback_model) } : {}),
            ...(data.variant !== undefined ? { variant: data.variant } : {}),
            ...(data.timeout_ms !== undefined ? { timeoutMs: data.timeout_ms } : {}),
            ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
            ...(data.top_p !== undefined ? { topP: data.top_p } : {}),
            ...(data.steps !== undefined ? { steps: data.steps } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
            permission: Permission.merge(
              defaults,
              Permission.fromConfig(data.permission ?? {}),
              // md 白名单第一条是 "*": deny（rule 是 permission="*" / pattern="*"），findLast 之下它会把
              // defaults 里**对象型**的 external_directory 整段作废 —— 而这份白名单依赖 ctx.directory 与
              // skill.dirs()，md 里静态表达不了，只能在这里重新宣告一遍。
              // 位置必须是「md 之后、user 之前」：挪到下面 Truncate.GLOB 那个循环后补丁里，会把用户自己在
              // permission.external_directory 配的白名单从 allow 压成 ask（docs/agent-roles-plan.md 修正八）。
              Permission.fromConfig({ external_directory: readonlyExternalDirectory }),
              user,
            ),
          }
        }

        const agents: Record<string, Info> = {
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".redcode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          redmind: {
            name: "redmind",
            displayName: "RedMind",
            description:
              "RedMind — 心有 Red，行前先问。常规操作（读、写、搜索）自动执行，bash 等敏感操作征得同意后再动手。",
            // 260808 Red：显式给红色。没写 color 的 agent 走「按可见顺序取调色板」
            // （tui/context/local.tsx 的 colors()：secondary/accent/success/warning/
            // primary/error/info），索引一撞就同色 —— 实测 redmind 与 build 都落成蓝色，
            // 光看输入框左边线分不出当前是哪个 agent（plan 是青色、能区分）。
            // RedMind 是默认 agent 又是 RedCode 的门面，钉死成红色最省事也最好认。
            color: "error",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                // 260828 cc plan_enter 从合并掉的 build 收回来：defaults 把它 deny 了而 redmind 没补回，
                // 结果默认姿态下模型没法自己提议进计划模式 —— 这是定义时漏的一条，不是有意分工
                // （redmind 的 description 只讲「敏感操作先问」，从没说过不做计划）。
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          explore: subagent("explore"),
          advise: subagent("advise"),
          execute: subagent("execute"),
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [rawKey, value] of Object.entries(cfg.agent ?? {})) {
          // 260828 cc 老名字先规范化到合并后的目标，否则 `agent: { build: {...} }` 这类老配置会在下面
          // 凭空造出一个 native:false / mode:"all" / "*": allow 的幽灵 build：它会通过 registry.ts 的
          // `mode !== "primary"` 过滤同时进 @ 补全与 describeTask，而 question 又被 defaults 的 deny
          // 下架 —— 比它替代的那个 build 还低一档，且直查优先会让别名解析被它劫持。
          const aliased = !agents[rawKey] && ALIAS[rawKey] !== undefined
          const key = aliased ? ALIAS[rawKey] : rawKey
          if (value.disable) {
            // 别名 key 上的 disable 按 no-op：`agent.build.disable` 的原意是「不要 build」，而 build 已经
            // 没了；照字面删掉 redmind 会让 defaultInfo 抛「no primary visible agent found」。
            if (!aliased) delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          // 260818 Red 子代理超时兑底：timeout_ms → timeoutMs（数字毫秒），
          // fallback_model → fallbackModel（同 model 的 providerID/modelID 解析）
          item.timeoutMs = value.timeout_ms ?? item.timeoutMs
          if (value.fallback_model) item.fallbackModel = Provider.parseModel(value.fallback_model)
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        // 260828 cc 别名解析。三个消费者共用一份：get、list 的排序谓词、defaultInfo —— 后两者**不经过
        // get**，只往 get 里加别名的话 `default_agent: "build"` 照样在下面抛「not found」，就算只补
        // defaultInfo，排序谓词也会比不中而退化成 name-asc，客户端按 primary 过滤后 at(0) 变成 plan，
        // TUI 与 GUI 都会静默进只读姿态。
        // 返回类型故意不标 `Info | undefined`：State.get 的声明是 Effect.Effect<Info>（`agents[x]` 在
        // noUncheckedIndexedAccess 关闭下被推成 Info，是个类型谎言），标了下面的 satisfies 会当场红。
        const resolve = (name: string) => agents[name] ?? agents[ALIAS[name] ?? ""]

        const get = Effect.fnUntraced(function* (agent: string) {
          return resolve(agent)
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const preferred = cfg.default_agent ? (resolve(cfg.default_agent)?.name ?? cfg.default_agent) : "redmind"
          return pipe(
            agents,
            values(),
            sortBy([(x) => x.name === preferred, "desc"], [(x) => x.name, "asc"]),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = resolve(c.default_agent)
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const sorted = yield* list()
          const visible = sorted.find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          // 260807 Red v7: tracer 不再是 TelemetryOptions 的属性（拆去 @ai-sdk/otel），同 session/llm.ts
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map((item): ModelMessage => ({
                  role: "system",
                  content: item,
                }))),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Agent from "./agent"
