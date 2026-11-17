import { expect, test } from "bun:test"
import { createQuestionRecovery } from "../../../src/cli/cmd/tui/context/question-recovery"

const one = { id: "q1", sessionID: "s1" }
const two = { id: "q2", sessionID: "s2" }

function fixture() {
  let requests: (typeof one)[] = []
  let workspace: string | undefined
  let server: (typeof one)[] = []
  let fetch = async () => server
  let calls = 0
  const recovery = createQuestionRecovery({
    workspace: () => workspace,
    fetch: () => {
      calls++
      return fetch()
    },
    read: () => requests,
    apply: (next) => (requests = next),
  })
  return {
    recovery,
    requests: () => requests,
    calls: () => calls,
    server: (next: typeof server) => (server = next),
    fetch: (next: typeof fetch) => (fetch = next),
    workspace: (next: typeof workspace) => (workspace = next),
    asked(request: typeof one) {
      requests = [...requests.filter((item) => item.id !== request.id), request]
      recovery.changed(request.id)
    },
    closed(id: string) {
      requests = requests.filter((item) => item.id !== id)
      recovery.changed(id)
    },
  }
}

test("startup and reconnect recover questions from all sessions", async () => {
  const f = fixture()
  f.server([one])
  await f.recovery.recover()
  expect(f.requests()).toEqual([one])
  f.server([one, two])
  await f.recovery.recover()
  expect(f.requests()).toEqual([one, two])
})

test("reconnect removes questions closed while disconnected", async () => {
  const f = fixture()
  f.asked(one)
  f.server([])
  await f.recovery.recover()
  expect(f.requests()).toEqual([])
})

test("a live question survives an older snapshot", async () => {
  const f = fixture()
  const response = Promise.withResolvers<(typeof one)[]>()
  f.fetch(() => response.promise)
  const pending = f.recovery.recover()
  f.asked(two)
  response.resolve([one])
  await pending
  expect(f.requests()).toEqual([one, two])
})

test("reply and rejection received during fetch cannot be resurrected", async () => {
  const f = fixture()
  f.asked(one)
  f.asked(two)
  const response = Promise.withResolvers<(typeof one)[]>()
  f.fetch(() => response.promise)
  const pending = f.recovery.recover()
  f.closed(one.id)
  f.closed(two.id)
  response.resolve([one, two])
  await pending
  expect(f.requests()).toEqual([])
})

test("failed recovery preserves state and does not retry by itself", async () => {
  const f = fixture()
  f.asked(one)
  f.fetch(() => Promise.reject(new Error("offline")))
  await expect(f.recovery.recover()).rejects.toThrow("offline")
  expect(f.requests()).toEqual([one])
  expect(f.calls()).toBe(1)
  f.server([two])
  f.fetch(async () => [two])
  await f.recovery.recover()
  expect(f.requests()).toEqual([two])
})

test("only the latest recovery may apply its snapshot", async () => {
  const f = fixture()
  const old = Promise.withResolvers<(typeof one)[]>()
  f.fetch(() => old.promise)
  const pending = f.recovery.recover()
  f.fetch(async () => [two])
  await f.recovery.recover()
  old.resolve([one])
  await pending
  expect(f.requests()).toEqual([two])
})

test("workspace changes and disposal invalidate late responses", async () => {
  const f = fixture()
  const response = Promise.withResolvers<(typeof one)[]>()
  f.fetch(() => response.promise)
  const pending = f.recovery.recover()
  f.workspace("other")
  response.resolve([one])
  await pending
  expect(f.requests()).toEqual([])

  const disposed = Promise.withResolvers<(typeof one)[]>()
  f.fetch(() => disposed.promise)
  const late = f.recovery.recover()
  f.recovery.dispose()
  disposed.resolve([two])
  await late
  expect(f.requests()).toEqual([])
})
