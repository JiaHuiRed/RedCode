import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Layer } from "effect"
import { createOpencodeClient, type GlobalEvent } from "@redcode-ai/sdk/v2"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { sanitizedProcessEnv } from "@redcode-ai/core/util/redcode-process"
import { Rpc } from "../../../src/util/rpc"
import type { rpc } from "../../../src/cli/cmd/tui/worker"
import { createWorkerFetch, createEventSource } from "../../../src/cli/cmd/tui/thread"
import { tmpdirScoped } from "../../fixture/fixture"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, CrossSpawnSpawner.defaultLayer))

// 261114 Red Windows CI 全量并发下曾贴 30s 套件上限超时（本地单跑 ~14s）。给这个
// 真 Worker + 双目录 + 三轮 LLM 往返的重集成测试独立时间预算，不动全仓超时；
// 各阶段耗时打进日志，Nightly 再超时可直接对账是哪段卡住。
const STAGE_BUDGET_MS = 120_000
const workerT0 = Date.now()
const stage = (label: string) => console.log(`[project-worker] ${label} +${((Date.now() - workerT0) / 1000).toFixed(1)}s`)

const twoDirectoriesBody = () =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const config = { ...testProviderConfig(llm.url), model: "test/test-model" }
    const a = { path: yield* tmpdirScoped({ git: true, config: { ...config, username: "Project A" } }) }
    const b = { path: yield* tmpdirScoped({ git: true, config: { ...config, username: "Project B" } }) }
    // 261110 Red 使用生产 Worker / RPC / SDK，不复制服务端路由或取消逻辑。
    const worker = new Worker(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url), {
      env: sanitizedProcessEnv(),
    })
    const rpcClient = Rpc.client<typeof rpc>(worker)
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await rpcClient.call("shutdown", undefined)
        worker.terminate()
      }).pipe(Effect.timeout("5 seconds"), Effect.ensuring(Effect.sync(() => worker.terminate())), Effect.ignore),
    )
    const transport = createWorkerFetch(rpcClient)
    const aAbort = new AbortController()
    const client = (directory: string, signal?: AbortSignal) =>
      createOpencodeClient({ baseUrl: "http://redcode.internal", directory, fetch: transport, signal })
    const A = client(a.path, aAbort.signal)
    const B = client(b.path)
    const paths = yield* Effect.promise(() => Promise.all([A.path.get(), B.path.get()]))
    expect(paths.map((result) => result.data?.directory)).toEqual([a.path, b.path])
    const configs = yield* Effect.promise(() => Promise.all([A.config.get(), B.config.get()]))
    expect(configs.map((result) => result.data?.username)).toEqual(["Project A", "Project B"])
    stage("worker boot + two directories ready")
    const sessions = yield* Effect.promise(() =>
      Promise.all([
        A.session.create(
          { title: "A", permission: [{ permission: "*", pattern: "*", action: "ask" }] },
          { throwOnError: true },
        ),
        B.session.create(
          { title: "B", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
          { throwOnError: true },
        ),
      ]),
    )
    const sessionA = sessions[0].data!.id
    const sessionB = sessions[1].data!.id
    stage("sessions created")
    const asked = yield* Deferred.make<GlobalEvent>()
    const unsub = yield* Effect.promise(() =>
      createEventSource(rpcClient).subscribe((event) => {
        if (event.payload.type === "permission.asked" && event.payload.properties.sessionID === sessionA) {
          Deferred.doneUnsafe(asked, Effect.succeed(event))
        }
      }),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unsub))
    yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("workspace-task-A"), "write", {
      filePath: path.join(a.path, "A.txt"),
      content: "written in A",
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("workspace-task-A"), "A finished")
    yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("workspace-task-B"), "write", {
      filePath: path.join(b.path, "B.txt"),
      content: "written in B",
    })
    yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("workspace-task-B"), "B finished")
    yield* Effect.promise(() =>
      A.session.promptAsync(
        {
          sessionID: sessionA,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "workspace-task-A" }],
        },
        { throwOnError: true },
      ),
    )
    const request = yield* awaitWithTimeout(Deferred.await(asked), "A never requested permission", "15 seconds")
    stage("A asked permission")
    // 261110 Red 请求已接受后离开 A；B 完整执行期间，A 的确认仍留在原目录。
    aAbort.abort()
    yield* Effect.promise(() =>
      B.session.prompt(
        {
          sessionID: sessionB,
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "workspace-task-B" }],
        },
        { throwOnError: true },
      ),
    )
    expect(yield* Effect.promise(() => Bun.file(path.join(b.path, "B.txt")).text())).toBe("written in B")
    expect(yield* Effect.promise(() => Bun.file(path.join(a.path, "A.txt")).exists())).toBe(false)
    stage("B finished while A parked")
    if (request.payload.type !== "permission.asked") throw new Error("Expected permission request")
    expect(request.directory).toBe(a.path)
    const returnedA = client(a.path)
    yield* Effect.promise(() =>
      returnedA.permission.reply(
        {
          requestID: request.payload.type === "permission.asked" ? request.payload.properties.id : "",
          reply: "once",
          workspace: request.workspace,
        },
        { throwOnError: true },
      ),
    )
    yield* pollWithTimeout(
      Effect.promise(async () => {
        const messages = await returnedA.session.messages({ sessionID: sessionA }, { throwOnError: true })
        return messages.data?.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text.includes("A finished")),
        )
          ? true
          : undefined
      }),
      "A did not finish after returning",
      "15 seconds",
    )
    expect(yield* Effect.promise(() => Bun.file(path.join(a.path, "A.txt")).text())).toBe("written in A")
    expect(yield* Effect.promise(() => Bun.file(path.join(b.path, "A.txt")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(a.path, "B.txt")).exists())).toBe(false)
    stage("A finished after returning")
    const lists = yield* Effect.promise(() => Promise.all([returnedA.session.list(), B.session.list()]))
    expect(lists[0].data?.some((session) => session.id === sessionB)).toBe(false)
    expect(lists[1].data?.some((session) => session.id === sessionA)).toBe(false)
  })

it.live(
  "one TUI worker isolates two directories and keeps A alive while B runs",
  twoDirectoriesBody,
  STAGE_BUDGET_MS,
)
