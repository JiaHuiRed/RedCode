// 260716 Red TEMP diag: evloop 漂移归因 — 工具执行期间登记自己，prompt.ts 的
// drift 探针触发时打印"当时谁在跑、跑了多久"，坐实/排除 DCP compress 等进程内
// 工具的同步阻塞嫌疑。定位完与 prompt.ts / message-v2.ts 的探针一起删。
const active = new Map<string, { tool: string; start: number }>()

export function toolStart(callID: string, tool: string) {
  active.set(callID, { tool, start: performance.now() })
}

export function toolEnd(callID: string) {
  active.delete(callID)
}

/** 逗号分隔的 "tool:已运行ms" 列表；无活动工具时返回 undefined 以免日志多余字段 */
export function activeTools(): string | undefined {
  if (active.size === 0) return undefined
  const now = performance.now()
  return [...active.values()].map((t) => `${t.tool}:${Math.round(now - t.start)}ms`).join(",")
}
