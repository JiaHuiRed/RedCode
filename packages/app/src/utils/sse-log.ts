/**
 * 事件流断连日志的取证格式化。
 *
 * 起因：`console.error("[global-sdk] event stream error", { url, fetch, error })` 这种写法
 * 在 Electron 渲染进程里转发进 `renderer.log` 时会被拍平成
 * `[global-sdk] event stream error [object Object]` —— url / fetch / error 三个字段全丢。
 * 47 个历史会话里断连记录几十条，没有一条能看出**为什么**断，取证链就断在这里。
 *
 * 所以断连相关的日志一律把字段拍进**消息字符串本身**，不依赖控制台对对象的序列化。
 */

/**
 * 交给生成的 SDK（`sdk/js/src/gen/core/serverSentEvents.gen.ts`）的重试上限。
 *
 * **1 = 失败立刻交回上层，SDK 自己不重试。**
 *
 * 那个生成器内部自带一圈重试：不传 `sseMaxRetryAttempts` 就是**无上限**，退避
 * `3000 * 2 ** (attempt-1)`、上限 30 秒。而生成器只要还在重试就**永不返回**，于是
 * `global-sdk` / `server-sdk` 各自那套 256ms→2s 的重连循环一行都执行不到 —— 实测 47 个
 * 会话里断连几十次，应用层的 "stream ended, reconnecting" 只打出过 2 行。
 *
 * 三个后果都指向同一个症状（界面像死了但服务端还在跑）：
 * 1. `connection` 状态卡在 "live"，三态断连指示器不会亮；
 * 2. 真实重连间隔涨到 30 秒，不是应用层以为的 2 秒；
 * 3. 唯一的自救是 90 秒心跳 abort。
 *
 * 所以把重试权收回上层：SDK 失败即返回，应用层负责退避、置 "reconnecting"、写日志。
 * **两套重连策略只能留一套**，留能把状态吐给界面的那套。
 */
export const SSE_MAX_RETRY_ATTEMPTS = 1

/** 把任意 throw 出来的东西压成一行可读文本（保留 name/message，丢掉栈）。 */
export function sseErrorText(error: unknown): string {
  if (error === undefined) return "undefined"
  if (error === null) return "null"
  if (error instanceof Error) {
    // DOMException（AbortError 等）与普通 Error 都走这里；cause 常常才是真因
    const cause = (error as { cause?: unknown }).cause
    const head = `${error.name}: ${error.message}`
    return cause === undefined ? head : `${head} <- ${sseErrorText(cause)}`
  }
  if (typeof error === "object") {
    // Response、事件对象等：挑几个能定位问题的常见字段，没有就退回 JSON
    const o = error as Record<string, unknown>
    const picked = (["name", "message", "type", "status", "statusText", "code", "reason"] as const)
      .filter((k) => o[k] !== undefined)
      .map((k) => `${k}=${String(o[k])}`)
    if (picked.length > 0) return picked.join(" ")
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

/** `key=value` 拼成一行，`undefined` 的键略过。 */
export function sseLogLine(tag: string, message: string, fields: Record<string, unknown>): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) => `${k}=${v instanceof Error || (typeof v === "object" && v !== null) ? sseErrorText(v) : String(v)}`,
    )
    .join(" ")
  return body ? `${tag} ${message} ${body}` : `${tag} ${message}`
}
