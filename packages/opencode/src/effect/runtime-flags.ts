import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("REDCODE_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: bool(name) }).pipe(Config.map((flags) => flags.experimental || flags.enabled))

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  autoShare: bool("REDCODE_AUTO_SHARE"),
  pure: bool("REDCODE_PURE"),
  disableDefaultPlugins: bool("REDCODE_DISABLE_DEFAULT_PLUGINS"),
  diffViewer: bool("REDCODE_DIFF_VIEWER"),
  disableChannelDb: bool("REDCODE_DISABLE_CHANNEL_DB"),
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
  experimentalScout: enabledByExperimental("REDCODE_EXPERIMENTAL_SCOUT"),
  experimentalBackgroundSubagents: enabledByExperimental("REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("REDCODE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("REDCODE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("REDCODE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("REDCODE_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("REDCODE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("REDCODE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("REDCODE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("REDCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("REDCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
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
