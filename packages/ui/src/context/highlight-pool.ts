// 260907 Red markdown 高亮 worker 池。决策与备选与否决理由见：
// docs/notes/implemented/bug-fix/2026-09-07-markdown-highlight-worker.md
//
// 形态对齐 ui/pierre/worker.ts 那套（2 worker 常驻，8 个对桌面是浪费）；与
// WorkerPoolManager 不同——那个是 diff/file 渲染专用协议（AST + 实例缓存），
// 没有裸 codeToHtml 入口，硬蹭会把 diff 的缓存语义拖进来。
//
// 失败自愈：单次调用超时/报错由调用方（marked.tsx）落回主线程兜底；连续 3 次
// 失败直接熔断本池（terminate + 本会话内不再重建），全部走主线程——最坏退化
// 等于改动前，不会更糟。

type HighlightResponse = { id: number; html?: string; error?: string }

const POOL_SIZE = 2
const CALL_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_FAILURES = 3

let workers: Worker[] | undefined
let disabled = false
let nextId = 1
let cursor = 0
let consecutiveFailures = 0
const pending = new Map<number, { resolve: (html: string) => void; reject: (error: Error) => void }>()

function failPool(reason: string) {
  disabled = true
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
  for (const worker of workers ?? []) worker.terminate()
  workers = undefined
}

function ensurePool(): Worker[] | undefined {
  if (disabled || typeof window === "undefined" || typeof Worker === "undefined") return undefined
  if (workers) return workers
  try {
    workers = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), { type: "module" })
      worker.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
        const entry = pending.get(event.data.id)
        if (!entry) return
        pending.delete(event.data.id)
        if (event.data.error) {
          noteFailure()
          entry.reject(new Error(event.data.error))
        } else {
          consecutiveFailures = 0
          entry.resolve(event.data.html ?? "")
        }
      })
      // 脚本加载失败/worker 内未捕获错误：整池不可信，熔断
      worker.addEventListener("error", () => failPool("highlight worker crashed"))
      return worker
    })
  } catch {
    failPool("highlight worker unavailable")
  }
  return workers
}

function noteFailure() {
  if (++consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return
  failPool("highlight worker failed repeatedly")
}

/** worker 可用性探针；不可用（无 window/已熔断）时调用方直接走主线程。 */
export function highlightPoolAvailable(): boolean {
  return ensurePool() !== undefined
}

/** 单块高亮。拒绝（超时/错误/不可用）时调用方负责主线程兜底。 */
export function highlightViaWorker(code: string, lang: string): Promise<string> {
  const pool = ensurePool()
  const worker = pool?.[cursor++ % pool.length]
  if (!worker) return Promise.reject(new Error("highlight pool unavailable"))
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      noteFailure()
      reject(new Error("highlight worker timed out"))
    }, CALL_TIMEOUT_MS)
    pending.set(id, {
      resolve: (html) => {
        clearTimeout(timer)
        resolve(html)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    worker.postMessage({ id, code, lang })
  })
}
