import * as nodeModule from "node:module"
import * as PluginSdk from "@redcode-ai/plugin"
import * as Log from "@redcode-ai/core/util/log"
import { z } from "zod"

const log = Log.create({ service: "plugin.sdk-shim" })

const SDK_SPECIFIER = "@redcode-ai/plugin"

/**
 * Node 侧（desktop sidecar = Electron utilityProcess，跑 Node 24 而非 Bun）拿不到二进制内
 * 打包的模块对象，只能以自包含源码落地一个最小 shim。语义对齐 packages/plugin/src/tool.ts
 * 的 `tool`（透传）与 `tool.schema`（zod 转发）；data: 模块没有 node_modules 起点，
 * schema 只能由宿主经 globalThis 桥接注入——必须是同一个 zod 实例，否则 registry 的
 * `z.object(args)` 认不出 shim 造的 schema。tool.ts 若增加运行时导出，这里要跟。
 */
const SDK_BRIDGE = Symbol.for("redcode.plugin.sdk")
const NODE_SHIM_SOURCE = [
  `const schema = globalThis[Symbol.for("redcode.plugin.sdk")].schema`,
  "function tool(input) { return input }",
  "tool.schema = schema",
  "export { tool };",
  "export default { tool };",
].join("\n")
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
  // 261106 Red data: 模块解析不到裸 specifier，schema 只能通过 globalThis 交给它。
  // 用 z 的本体而不是自己包一层：registry 的 z.object() 要求同一实例。
  ;(globalThis as unknown as Record<symbol, unknown>)[SDK_BRIDGE] = { schema: z }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === SDK_SPECIFIER) return { url: NODE_SHIM_URL, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}
