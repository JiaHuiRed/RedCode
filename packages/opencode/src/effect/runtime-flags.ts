import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const boolDefaultTrue = (name: string) => Config.boolean(name).pipe(Config.withDefault(true))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("REDCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: bool(name) }).pipe(Config.map((flags) => flags.experimental || flags.enabled))

export class Service extends ConfigService.Service<Service>()("@redcode/RuntimeFlags", {
  autoShare: bool("REDCODE_AUTO_SHARE"),
  pure: bool("REDCODE_PURE"),
  disableDefaultPlugins: bool("REDCODE_DISABLE_DEFAULT_PLUGINS"),
  diffViewer: bool("REDCODE_DIFF_VIEWER"),
  disableEmbeddedWebUi: bool("REDCODE_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("REDCODE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("REDCODE_DISABLE_LSP_DOWNLOAD"),
  skipMigrations: bool("REDCODE_SKIP_MIGRATIONS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("REDCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("REDCODE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("REDCODE_DISABLE_CLAUDE_CODE"),
    direct: bool("REDCODE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("REDCODE_ENABLE_EXA"),
    legacy: bool("REDCODE_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("REDCODE_ENABLE_PARALLEL"),
    legacy: bool("REDCODE_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("REDCODE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("REDCODE_ENABLE_QUESTION_TOOL"),
  // 260827 cc 默认关闭：goal 表 0 行、goal_set/done/clear 90 天零调用，三个定义却每请求付 214 token。
  // 引擎侧的目标注入（prompt.ts / goal-continuation.ts）只在有 active goal 时才发，功能从没被启用过。
  // 设 REDCODE_ENABLE_GOAL_TOOLS=true 可恢复。
  enableGoalTools: bool("REDCODE_ENABLE_GOAL_TOOLS"),
  // 260828 cc 从 experimentalScout 改名而来。scout agent 已并入 explore，但这个 flag 还门控着
  // @reference 的 git 物化（reference/reference.ts:128/208/218/224）与 repo_clone / repo_overview
  // 的注册（tool/registry.ts:313）—— 名字跟它管的东西彻底对不上了。
  // 保留 legacy 键：REDCODE_EXPERIMENTAL_SCOUT 可能已经写在 live 环境里，静默失效等于悄悄关掉
  // @reference 的物化。三键写法与 enableExa / enableParallel 一致。
  experimentalReference: Config.all({
    experimental,
    enabled: bool("REDCODE_EXPERIMENTAL_REFERENCE"),
    legacy: bool("REDCODE_EXPERIMENTAL_SCOUT"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  // 260717 Red 默认开启：非后台模式下派发子代理会一直占着 session busy 直到子代理跑完，
  // 主界面全程没法交互，等于白设计了后台任务这条路。设 REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false 可退回旧行为。
  experimentalBackgroundSubagents: boolDefaultTrue("REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("REDCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("REDCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("REDCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("REDCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalWorkspaces: enabledByExperimental("REDCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("REDCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("REDCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("REDCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  // 260811 cc audit Y3：shell timeout 此前只拒负数没有上限，模型幻觉 timeout:86400000
  // 就真等一天。默认钳到 10 分钟，特殊场景用该变量放宽。
  bashMaxTimeoutMs: positiveInteger("REDCODE_EXPERIMENTAL_BASH_MAX_TIMEOUT_MS"),
  experimentalNativeLlm: enabledByExperimental("REDCODE_EXPERIMENTAL_NATIVE_LLM"),
  client: Config.string("REDCODE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
