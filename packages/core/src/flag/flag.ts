import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const REDCODE_EXPERIMENTAL = truthy("REDCODE_EXPERIMENTAL")
const copy = process.env["REDCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  REDCODE_AUTO_HEAP_SNAPSHOT: truthy("REDCODE_AUTO_HEAP_SNAPSHOT"),
  REDCODE_GIT_BASH_PATH: process.env["REDCODE_GIT_BASH_PATH"],
  REDCODE_CONFIG: process.env["REDCODE_CONFIG"],
  REDCODE_CONFIG_CONTENT: process.env["REDCODE_CONFIG_CONTENT"],
  REDCODE_DISABLE_AUTOUPDATE: truthy("REDCODE_DISABLE_AUTOUPDATE"),
  // 260828 cc 关掉「后台把 @opencode-ai/plugin 装进项目 .redcode/node_modules」这一步。
  //
  // 那个安装是 Effect.forkDetach 的分离 fiber，**比创建它的作用域活得长**。测试里的
  // 后果：临时目录的 finalizer 先跑（此时目录还基本是空的，删得掉、不报错），npm 随后
  // 把 .redcode/node_modules 重新写出来 —— 于是留下一个 38MB 的目录且没有任何告警。
  // 实测一轮会话攒出 177 个这样的目录、6.5GB。
  //
  // 离线/受限网络的部署同样需要这个开关。不影响插件**加载**，只跳过为用户插件预装
  // SDK 包这一步。
  REDCODE_DISABLE_PLUGIN_DEP_INSTALL: truthy("REDCODE_DISABLE_PLUGIN_DEP_INSTALL"),
  REDCODE_ALWAYS_NOTIFY_UPDATE: truthy("REDCODE_ALWAYS_NOTIFY_UPDATE"),
  REDCODE_DISABLE_PRUNE: truthy("REDCODE_DISABLE_PRUNE"),
  // 260819 cc 前缀断裂探针（session/prefix-probe.ts）。默认开——哥哥的前缀缓存排查还在
  // 进行中，它就是数据来源；不需要时置 1 关掉，省下每轮约 2.8ms 的全量指纹开销。
  // 按访问时求值（同下方 REDCODE_DISABLE_PROJECT_CONFIG 的理由）：模块加载时求值的话，
  // 用例与 CLI 在运行期设的环境变量都不生效。
  get REDCODE_DISABLE_PREFIX_PROBE() {
    return truthy("REDCODE_DISABLE_PREFIX_PROBE")
  },
  REDCODE_DISABLE_TERMINAL_TITLE: truthy("REDCODE_DISABLE_TERMINAL_TITLE"),
  REDCODE_SHOW_TTFD: truthy("REDCODE_SHOW_TTFD"),
  REDCODE_DISABLE_AUTOCOMPACT: truthy("REDCODE_DISABLE_AUTOCOMPACT"),
  REDCODE_DISABLE_MODELS_FETCH: truthy("REDCODE_DISABLE_MODELS_FETCH"),
  REDCODE_DISABLE_MOUSE: truthy("REDCODE_DISABLE_MOUSE"),
  REDCODE_FAKE_VCS: process.env["REDCODE_FAKE_VCS"],
  REDCODE_SERVER_PASSWORD: process.env["REDCODE_SERVER_PASSWORD"],
  REDCODE_SERVER_USERNAME: process.env["REDCODE_SERVER_USERNAME"],

  // Experimental
  REDCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("REDCODE_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  REDCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("REDCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  REDCODE_MODELS_URL: process.env["REDCODE_MODELS_URL"],
  REDCODE_MODELS_PATH: process.env["REDCODE_MODELS_PATH"],
  REDCODE_DB: process.env["REDCODE_DB"],

  REDCODE_WORKSPACE_ID: process.env["REDCODE_WORKSPACE_ID"],
  REDCODE_EXPERIMENTAL_WORKSPACES: REDCODE_EXPERIMENTAL || truthy("REDCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get REDCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("REDCODE_DISABLE_PROJECT_CONFIG")
  },
  get REDCODE_TUI_CONFIG() {
    return process.env["REDCODE_TUI_CONFIG"]
  },
  get REDCODE_CONFIG_DIR() {
    return process.env["REDCODE_CONFIG_DIR"]
  },
  get REDCODE_PURE() {
    return truthy("REDCODE_PURE")
  },
  get REDCODE_PERMISSION() {
    return process.env["REDCODE_PERMISSION"]
  },
  get REDCODE_PLUGIN_META_FILE() {
    return process.env["REDCODE_PLUGIN_META_FILE"]
  },
  get REDCODE_CLIENT() {
    return process.env["REDCODE_CLIENT"] ?? "cli"
  },
}
