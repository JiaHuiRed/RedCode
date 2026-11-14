import { describe, expect, test } from "bun:test"
import { createSessionEntries } from "./dialog-select-file"

// 261114 Red UX-09 评审要求：把空查询/搜索交错的 Promise 完成顺序用自动化测试
// 钉住。二轮评审抓到的竞态（被作废的在途请求挡住新一轮加载）由此回归测试守卫。

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type ListResponse = { data: { id: string; title?: string; time?: { updated?: number; archived?: number } }[] }

function harness() {
  const pending: ReturnType<typeof deferred<ListResponse>>[] = []
  const started: string[] = []
  const created = createSessionEntries({
    workspaces: () => ["/repo"],
    label: (directory) => directory,
    language: { t: (key: string) => key } as ReturnType<typeof import("@/context/language")["useLanguage"]>,
    globalSDK: {
      client: {
        session: {
          list: (input: { directory?: string }) => {
            started.push(input?.directory ?? "")
            const gate = deferred<ListResponse>()
            pending.push(gate)
            return gate.promise
          },
        },
      },
    } as Parameters<typeof createSessionEntries>[0]["globalSDK"],
  })
  const resolveAt = (index: number, sessionsData: ListResponse["data"]) => {
    pending[index]!.resolve({ data: sessionsData })
  }
  return { ...created, started, resolveAt, pending }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("createSessionEntries request lifecycle", () => {
  test("empty → search → empty: C starts despite A inflight; stale responses are dropped in completion order", async () => {
    const { sessions, entries, started, resolveAt, pending } = harness()

    sessions("") // A：最近会话加载
    sessions("kw") // B：搜索（作废 A）
    sessions("") // C：再回空查询（评审竞态场景——C 不得被 A 挡住）

    expect(started.length).toBe(3)
    expect(pending.length).toBe(3)

    resolveAt(1, [{ id: "b1" }]) // B 先完成 → 令牌已过期，不得落地
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual([])

    resolveAt(2, [{ id: "c1" }]) // C 完成 → 最近会话落地
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual(["session:/repo:c1"])

    resolveAt(0, [{ id: "a1" }]) // A 最后完成 → 依旧丢弃
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual(["session:/repo:c1"])
  })

  test("search → empty → search: stale search does not block the next search", async () => {
    const { sessions, entries, started, resolveAt } = harness()

    sessions("a") // 搜索 A
    sessions("") // 清空 → 空查询起跑（作废 A）
    sessions("b") // 再搜索 → 不得被过期 A 的在途槽挡住

    expect(started.length).toBe(3)

    resolveAt(0, [{ id: "stale" }]) // 过期搜索 A 完成 → 丢弃
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual([])

    // 空查询在搜索 B 起跑时已被作废——响应落地被丢弃（搜索在场时空结果不该顶掉它）
    resolveAt(1, [{ id: "recent" }])
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual([])

    resolveAt(2, [{ id: "b1" }]) // 搜索 B 完成 → 覆盖
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual(["session:/repo:b1"])
  })

  test("old request finishing after a newer one cannot clear the newer slot", async () => {
    const { sessions, entries, resolveAt, pending } = harness()

    sessions("") // A
    sessions("kw") // B（作废 A）
    resolveAt(1, [{ id: "b1" }]) // B 完成
    await tick()
    const afterB = entries().map((entry) => entry.id)
    expect(afterB).toEqual(["session:/repo:b1"])

    // B 的 finally 此时已清自己的槽；A 仍在途——它结束时不得清掉新一轮的槽位状态
    resolveAt(0, [{ id: "a1" }])
    await tick()
    expect(entries().map((entry) => entry.id)).toEqual(["session:/repo:b1"])
    expect(pending.length).toBe(2)
  })
})
