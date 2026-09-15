import * as nodeModule from "node:module"
import * as PluginSdk from "@redcode-ai/plugin"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "plugin.sdk-shim" })

const SDK_SPECIFIER = "@redcode-ai/plugin"

/**
 * Node 侧（desktop sidecar = Electron utilityProcess，跑 Node 24 而非 Bun）拿不到二进制内
 * 打包的模块对象，只能以自包含源码落地一个最小 shim。语义对齐 packages/plugin/src/tool.ts
 * 的 `tool`（透传）；`tool.schema`（zod 转发）不提供——seed 工具只用 `tool()`，这样 shim
 * 零依赖，data: URL 即可加载，不用操心 zod 的解析起点。tool.ts 若增加运行时导出，这里要跟。
 */
const NODE_SHIM_SOURCE = ["function tool(input) { return input }", "export { tool };", "export default { tool };"].join(
  "\n",
)
const NODE_SHIM_URL = `data:text/javascript;base64,${Buffer.from(NODE_SHIM_SOURCE).toString("base64")}`

type ResolveResult = { url: string; shortCircuit?: boolean }
type NodeModuleWithHooks = {
  registerHooks?: (hooks: {
    resolve(
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context?: { parentURL?: string }) => ResolveResult,
    ): ResolveResult
  }) => unknown
}

let installed = false

/**
 * 260915 Red 把 `@redcode-ai/plugin` 注册成进程内虚拟模块，映射到随二进制打包的同一份 SDK。
 *
 * seed 进 home 的用户代码（seed/tool/sqlite.ts）`import "@redcode-ai/plugin"`，但该包只存在
 * 于 repo workspace、未发布 npm；home 的 node_modules 里只有旧名 @opencode-ai/plugin，
 * Bun 从用户文件位置向上找 node_modules 必然失败 → ResolveMessage。260914 ses_fr8o… 的
 * "等待模型响应"卡死即由此起（当时还连累整张工具表，见 tool/registry.ts 的单文件隔离）。
 *
 * 两个运行时各走一套：TUI（Bun）用 Bun.plugin 的 build.module；desktop sidecar 是 Node，
 * 用 node:module 的 registerHooks 把 specifier 短路到自包含 data: 模块。首版只有 Bun 分支
 * 且没加守卫——Node 里 `Bun is not defined` 在工具表构建时同步抛出，prompt 整个 Die
 * （260915 GUI 复测卡死，日志只有 defect:{} 的 prompt_async failed）。
 *
 * 只注册新名：旧名 @opencode-ai/plugin 可能装着真实的 npm 包，遮蔽它有 API 漂移风险。
 */
export function installSdkModule() {
  if (installed) return
  installed = true

  if (typeof Bun !== "undefined") {
    Bun.plugin({
      name: "redcode-plugin-sdk",
      setup(build) {
        build.module(SDK_SPECIFIER, () => ({ exports: { ...PluginSdk }, loader: "object" }))
      },
    })
    return
  }

  const registerHooks = (nodeModule as NodeModuleWithHooks).registerHooks
  if (typeof registerHooks !== "function") {
    // 不致命：registry 对单个工具文件加载失败已有隔离，sqlite 工具缺席但会话可用。
    log.error("cannot register @redcode-ai/plugin shim on this runtime, seeded tools importing it will fail to load")
    return
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === SDK_SPECIFIER) return { url: NODE_SHIM_URL, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}
