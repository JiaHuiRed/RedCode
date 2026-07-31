// 260731 Red bun test 的 electron 替身。
//
// `bun test` 跑在 Bun 里而不是 Electron 里，`electron` 包的 index.js 只是一个指向二进制
// 的 stub，`import { crashReporter } from "electron"` 会直接抛
// `SyntaxError: Export named 'crashReporter' not found`，整条 import 链塌掉。
//
// 受影响的是 src/main/shell-env.test.ts：被测的 parseShellEnv/mergeShellEnv 全是纯逻辑，
// 但 shell-env.ts 顺手 import 了 logging.ts，logging.ts 才是碰 electron 的那个。
// logging.ts 在模块顶层不调用任何 electron API，所以这里只需要让具名导出存在即可 ——
// 真要在测试里驱动 Electron 行为，得单独设计，不是这个替身该干的事。
import { mock } from "bun:test"

const unavailable = (api: string) => () => {
  throw new Error(`bun test 里没有 Electron 运行时，无法调用 ${api}`)
}

mock.module("electron", () => ({
  app: {
    getPath: unavailable("app.getPath"),
    getVersion: unavailable("app.getVersion"),
    isPackaged: false,
  },
  crashReporter: { start: unavailable("crashReporter.start") },
  netLog: {
    startLogging: unavailable("netLog.startLogging"),
    stopLogging: unavailable("netLog.stopLogging"),
  },
  shell: { openPath: unavailable("shell.openPath") },
}))
