// 260903 cc 出站代理策略必须在**任何请求发生之前**装好，所以这里是副作用导入而不是
// 一个等人来调的导出函数：node.ts 是 Node bundle 的唯一入口（sidecar 走
// `await import("./node.js")`），装在这里就不需要任何调用点纪律——新增的 fetch
// 调用点自动被覆盖。Bun 那条路不导入本文件，其 fetch 原生认代理环境变量。
// 因由与踩过的坑见 util/proxy-dispatcher.ts 的文件头。
import { installGlobalProxy } from "@/util/proxy-dispatcher"
installGlobalProxy()

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@redcode-ai/core/util/log"
export { Database } from "@/storage/db"
export { JsonMigration } from "@/storage/json-migration"
