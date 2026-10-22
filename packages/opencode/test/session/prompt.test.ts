import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/http"
import { expect } from "bun:test"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import * as TestConsole from "effect/testing/TestConsole"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@redcode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { Goal } from "../../src/session/goal"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@redcode-ai/core/util/log"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Storage } from "@/storage/storage"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snippet } from "@/session/snippet"
import { Soul } from "@/soul"
import { NativeCompaction } from "@/config/native-compaction"
import * as ContextCompaction from "@/session/context-compaction"
import { runSteerableTask, steerTask, TaskTool, type TaskPromptOps } from "@/tool/task"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { TaskStatusTool } from "@/tool/task_status"
import { InstanceRef } from "@/effect/instance-ref"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function userDelivery(message: MessageV2.WithParts) {
  if (message.info.role !== "user") throw new Error("expected a user message")
  return message.info.delivery
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    rename: () => Effect.succeed(undefined),
    codeAction: () => Effect.succeed([]),
    completion: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

function makePrompt(input?: {
  processor?: "blocking"
  image?: Layer.Layer<Image.Service>
  filesystem?: Layer.Layer<AppFileSystem.Service>
}) {
  const filesystem = input?.filesystem ?? AppFileSystem.defaultLayer
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Storage.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    filesystem,
    BackgroundJob.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const goal = Goal.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provideMerge(todo),
    Layer.provideMerge(goal),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const imageLayer = input?.image ?? Image.defaultLayer
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(imageLayer),
          Layer.provide(RuntimeFlags.layer({})),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(imageLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(Snippet.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: {
  processor?: "blocking"
  image?: Layer.Layer<Image.Service>
  filesystem?: Layer.Layer<AppFileSystem.Service>
}) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: {
  processor?: "blocking"
  image?: Layer.Layer<Image.Service>
  filesystem?: Layer.Layer<AppFileSystem.Service>
}) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const noResizerServer = testEffect(
  makeHttpNoLLMServer({
    image: Layer.mock(Image.Service, {
      normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
    }),
  }),
)
const overBudgetNormalizerServer = testEffect(
  makeHttpNoLLMServer({
    image: Layer.mock(Image.Service, {
      normalize: (part) =>
        Effect.succeed({
          part: {
            ...part,
            url: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024 + 1)}`,
          },
        }),
    }),
  }),
)
const imageReadProbe = {
  path: "",
  failFirstStat: false,
  reportedSize: undefined as number | undefined,
  statCalls: 0,
  readBytes: 0,
  readRequests: [] as number[],
  normalized: [] as string[],
}
const boundedImageServer = testEffect(
  makeHttpNoLLMServer({
    filesystem: instrumentPromptFile(imageReadProbe),
    image: Layer.mock(Image.Service, {
      normalize: (part) =>
        Effect.sync(() => {
          imageReadProbe.normalized.push(part.filename ?? "unnamed")
          return { part }
        }),
    }),
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function instrumentPromptFile(input: {
  path: string
  failFirstStat?: boolean
  reportedSize?: number
  statCalls: number
  readBytes: number
  readRequests: number[]
}) {
  return Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return AppFileSystem.Service.of({
        ...fs,
        stat: (filepath) => {
          if (filepath !== input.path) return fs.stat(filepath)
          input.statCalls++
          if (input.failFirstStat && input.statCalls === 1)
            // stat 的签名错误面是 PlatformError，测试只需要「这次 stat 没拿到尺寸」；
            // 用 defect 表达同样会走 Exit 失败分支，且不必伪造 PlatformError 结构。
            return Effect.die(new Error("stat failed"))
          return fs
            .stat(filepath)
            .pipe(
              Effect.map((info) =>
                input.reportedSize === undefined
                  ? info
                  : { ...info, size: input.reportedSize as unknown as typeof info.size },
              ),
            )
        },
        readFile: (filepath) =>
          fs.readFile(filepath).pipe(
            Effect.tap((bytes) =>
              Effect.sync(() => {
                if (filepath === input.path) input.readBytes += bytes.byteLength
              }),
            ),
          ),
        open: (filepath, options) =>
          fs.open(filepath, options).pipe(
            Effect.map(
              (file) =>
                new Proxy(file, {
                  get(target, property, receiver) {
                    if (property === "readAlloc") {
                      return (bytes: number) => {
                        if (filepath === input.path) input.readRequests.push(bytes)
                        return target.readAlloc(bytes).pipe(
                          Effect.tap((chunk) =>
                            Effect.sync(() => {
                              if (filepath === input.path && Option.isSome(chunk))
                                input.readBytes += chunk.value.byteLength
                            }),
                          ),
                        )
                      }
                    }
                    return Reflect.get(target, property, receiver)
                  },
                }) as typeof file,
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
}

// 260828 cc 老名字 general 经别名解析到 execute，而 execute 自带 model: opencode-go/glm-5.3-flash
//（general 从前不带 model、跟随会话模型）。这是真实的行为变化，不是测试环境瑕疵 —— 测试里只有
// test provider，所以凡是要让子会话真跑起来的用例，都得先把 execute 钉回测试模型。
function subtaskCfg(url: string) {
  return {
    ...providerCfg(url),
    agent: { execute: { model: `${ref.providerID}/${ref.modelID}` } },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<Config.Info>) {
  yield* writeText(
    path.join(dir, "redcode.json"),
    JSON.stringify({ $schema: "https://redcode.dev/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<Config.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped to
// "busy" inside Runner.startShell's modifyEffect at the same moment the runner
// is registered, so this is a deterministic readiness signal — cancel can't
// no-op once we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

it.instance("sends the pinned Soul body and attribution in an actual provider request", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const soulsDirectory = path.join(dir, "souls")
    const sourceFile = process.env.REDCODE_SOUL_ACCEPTANCE_FILE
    const source = sourceFile
      ? yield* Effect.promise(() => Bun.file(sourceFile).text())
      : "---\nid: third\nname: Third\ndisplay_name: Partner\ncommit_prefix: ThirdOwner\n---\n\n# Third persona\n\nwire soul sentinel\n"
    yield* writeText(path.join(soulsDirectory, "third.md"), source)
    yield* Effect.gen(function* () {
      const registry = yield* Effect.gen(function* () {
        return yield* Soul.Service
      }).pipe(Effect.provide(Soul.defaultLayer))
      const info = (yield* registry.list())[0]
      if (!info) return yield* Effect.die("acceptance Soul did not load")
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned", soul: info.id })
      yield* Effect.addFinalizer(() => sessions.remove(chat.id).pipe(Effect.orDie))
      yield* llm.text("wire checked")
      yield* (yield* SessionPrompt.Service).prompt({
        sessionID: chat.id,
        model: ref,
        parts: [{ type: "text", text: "check the pinned identity" }],
      })
      const wire = JSON.stringify((yield* llm.inputs)[0])
      expect(wire).toContain(info.displayName)
      expect(wire).toContain(`Commit attribution owner: [${info.commitPrefix}]`)
      expect(wire).toContain(source.split("---")[2]?.trim().split("\n")[0] ?? "wire soul sentinel")
      expect(wire).not.toContain("Instructions from: " + path.join(soulsDirectory, "Tsoul.md"))
    }).pipe(Effect.provideService(Soul.directory, soulsDirectory))
  }),
)

it.instance(
  "generates an automatic session title",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, sessions, chat } = yield* boot({})
      yield* llm.text("world")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* prompt.loop({ sessionID: chat.id })

      const title = yield* pollWithTimeout(
        sessions
          .get(chat.id)
          .pipe(Effect.map((session) => (Session.isDefaultTitle(session.title) ? undefined : session.title))),
        "automatic title was not persisted",
      )
      expect(title).toContain("E2E Title")
    }),
  { config: cfg },
)

it.instance(
  "reports automatic title responses without text",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, sessions, chat } = yield* boot({})
      yield* llm.title("")
      yield* llm.text("world")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* prompt.loop({ sessionID: chat.id })

      yield* pollWithTimeout(
        TestConsole.logLines.pipe(
          Effect.map((lines) =>
            lines.some((line) => typeof line === "string" && line.includes("title response empty"))
              ? (true as const)
              : undefined,
          ),
        ),
        "empty title response was not logged",
      )
      expect(Session.isDefaultTitle((yield* sessions.get(chat.id)).title)).toBe(true)
    }),
  { config: cfg },
)

it.instance(
  "reports automatic title stream failures",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, sessions, chat } = yield* boot({})
      yield* llm.titleError("title boom")
      yield* llm.text("world")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* prompt.loop({ sessionID: chat.id })

      yield* pollWithTimeout(
        TestConsole.logLines.pipe(
          Effect.map((lines) =>
            lines.some((line) => typeof line === "string" && line.includes("failed to generate title"))
              ? (true as const)
              : undefined,
          ),
        ),
        "title stream failure was not logged",
      )
      expect(Session.isDefaultTitle((yield* sessions.get(chat.id)).title)).toBe(true)
    }),
  { config: cfg },
)

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

// 260819 cc 原本这里有一条「prompt emits v2 prompted and synthetic events」用例，断言引擎
// prompt 入口把 prompted/synthetic 事件写进 session_message 表。那是 experimentalEventSystem
// 双写路径的产物，双写已摘（见 docs/notes/implemented/simplification/2026-08-19-event-dualwrite-removal.md），
// 用例随之退役。

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("claims explicit queued messages one turn at a time in FIFO order", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue turns" })
    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "first" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "second" }],
    })
    const third = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "third" }],
    })
    expect(second.info.role === "user" && second.info.delivery).toBe("queued")
    yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: second.info.id, text: "second edited" })
    yield* llm.text("reply one")
    yield* llm.text("reply two")
    yield* llm.text("reply three")
    yield* prompt.loop({ sessionID: chat.id })
    const hits = yield* llm.hits
    expect(hits.length).toBe(3)
    const sent = hits.map((hit) => JSON.stringify(hit.body))
    expect(sent[0]).toContain("first")
    expect(sent[0]).not.toContain("second edited")
    expect(sent[1]).toContain("second edited")
    expect(sent[1]).not.toContain("third")
    expect(sent[2]).toContain("third")
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: second.info.id })).info).toMatchObject({
      delivery: "delivered",
    })
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: third.info.id })).info).toMatchObject({
      delivery: "delivered",
    })
    expect(first.info.role).toBe("user")
    const error = yield* sessions
      .cancelQueuedMessage({ sessionID: chat.id, messageID: second.info.id })
      .pipe(Effect.flip)
    expect(error).toBeInstanceOf(Session.QueuedMessageConflict)
  }),
)

it.instance("reserved queued messages stay editable only after release", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue reservation" })
    const queued = yield* user(chat.id, "reserved")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    const later = yield* user(chat.id, "later queued")
    yield* sessions.updateMessage({ ...later, delivery: "queued" })

    const claimed = yield* sessions.claimQueuedMessage(chat.id)
    expect(claimed?.id).toBe(queued.id)
    expect(yield* sessions.claimQueuedMessage(chat.id)).toBeUndefined()
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")

    const edit = yield* sessions
      .editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "too soon" })
      .pipe(Effect.flip)
    expect(edit).toBeInstanceOf(Session.QueuedMessageConflict)
    const cancel = yield* sessions.cancelQueuedMessage({ sessionID: chat.id, messageID: queued.id }).pipe(Effect.flip)
    expect(cancel).toBeInstanceOf(Session.QueuedMessageConflict)
    const promote = yield* sessions.deliverQueuedMessage({ sessionID: chat.id, messageID: queued.id }).pipe(Effect.flip)
    expect(promote).toBeInstanceOf(Session.QueuedMessageConflict)

    yield* sessions.releaseQueuedMessage({ sessionID: chat.id, messageID: queued.id })
    yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "released" })
  }),
)

it.instance("cancelled claimed queue item stays queued until an explicit later loop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Cancelled queued turn" })
    yield* seed(chat.id, { finish: "stop" })
    const queued = yield* user(chat.id, "queued before cancel")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    yield* llm.hang

    const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(running)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")
    yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "queued after cancel" })
    expect(yield* llm.calls).toBe(1)

    yield* llm.text("explicit retry reply")
    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "explicit retry reply")).toBe(true)
    expect(yield* llm.calls).toBe(2)
    expect(
      (yield* llm.inputs)
        .map((input) => JSON.stringify(input))
        .filter((input) => input.includes("queued after cancel")),
    ).toHaveLength(1)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

raceNoLLMServer.instance(
  "cancellation before processor creation releases a claimed queued message",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Claim cancellation" })
      yield* seed(chat.id, { finish: "stop" })
      const queued = yield* user(chat.id, "claimed before processor create")
      yield* sessions.updateMessage({ ...queued, delivery: "queued" })

      const started = defer<void>()
      processorCreateStarted.push(started.resolve)
      const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(running)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")
      yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "still pending" })
    }),
  { config: cfg },
  3_000,
)

it.instance("acknowledges a queued message only after response content arrives", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue receipt boundary" })
    yield* seed(chat.id, { finish: "stop" })
    const queued = yield* user(chat.id, "wait for response")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    const response = defer<void>()
    yield* llm.hold("receipt response", response.promise)

    const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")

    response.resolve()
    yield* Fiber.await(running)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

it.instance("promotes a message arriving during finish into one subsequent model turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue promoted at finish" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "original turn" }],
    })
    const response = defer<void>()
    yield* llm.hold("original reply", response.promise)
    yield* llm.text("promoted reply")

    const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    const late = yield* user(chat.id, "late promoted message")
    yield* sessions.updateMessage({ ...late, delivery: "queued" })
    yield* sessions.deliverQueuedMessage({ sessionID: chat.id, messageID: late.id })
    response.resolve()
    yield* Fiber.await(running)

    const inputs = (yield* llm.inputs).map((input) => JSON.stringify(input))
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).not.toContain("late promoted message")
    expect(inputs[1]).toContain("late promoted message")
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: late.id }))).toBe("delivered")
  }),
)

it.instance("keeps a queued message after provider failure before response content", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue provider failure" })
    yield* seed(chat.id, { finish: "stop" })
    const queued = yield* user(chat.id, "retry after provider failure")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    yield* llm.error(400, { error: { message: "provider rejected request" } })

    yield* prompt.loop({ sessionID: chat.id })
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")
    yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "still editable" })

    yield* llm.text("explicit retry after provider failure")
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(2)
    expect(JSON.stringify((yield* llm.inputs)[1])).toContain("still editable")
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

it.instance("promotes an older queued message without mistaking the active reply for its response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Older queued promotion" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "active original turn" }],
    })
    const queued = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "older queued promotion" }],
    })
    const response = defer<void>()
    yield* llm.hold("original response", response.promise)
    yield* llm.text("promoted response")

    const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* sessions.deliverQueuedMessage({ sessionID: chat.id, messageID: queued.info.id })
    response.resolve()
    yield* Fiber.await(running)

    const inputs = (yield* llm.inputs).map((input) => JSON.stringify(input))
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).not.toContain("older queued promotion")
    expect(inputs[1]).toContain("older queued promotion")
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.info.id }))).toBe("delivered")
  }),
)

it.instance("keeps an acknowledged queued message delivered after stream interruption", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue mid-stream interruption" })
    yield* seed(chat.id, { finish: "stop" })
    const queued = yield* user(chat.id, "response starts before cancel")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    const deltas = yield* (yield* Bus.Service).subscribe(MessageV2.Event.PartDelta)
    yield* llm.push(reply().text("partial response").hang())

    const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    // 261007 Red 流式正文先发布 delta，结束时才写回完整 part；中断前等真实 delta。
    yield* awaitWithTimeout(
      deltas.pipe(
        Stream.filter(
          (event) => event.properties.sessionID === chat.id && event.properties.delta === "partial response",
        ),
        Stream.runHead,
      ),
      "queued response text did not arrive before cancellation",
    )
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(running)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

it.instance("delivers a queued message retained behind a completed compaction boundary", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue across compaction" })
    const queued = yield* user(chat.id, "queued before compaction")
    yield* sessions.updateMessage({ ...queued, delivery: "queued" })
    const compacted = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: compacted.user.id,
      type: "compaction",
      auto: true,
    })
    yield* sessions.updateMessage({ ...compacted.assistant, summary: true })
    expect((yield* MessageV2.filterCompactedEffect(chat.id)).some((msg) => msg.info.id === queued.id)).toBe(false)
    const { directory } = yield* TestInstance
    const file = path.join(directory, "queue-compaction.txt")
    yield* writeText(file, "retained queue tool result")
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("reply to retained queue")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.calls).toBe(2)
    expect((yield* llm.inputs).every((input) => JSON.stringify(input).includes("queued before compaction"))).toBe(true)
    expect(result.info.role === "assistant" && result.info.parentID).toBe(queued.id)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

// 261010 Red native 投影会隐藏失败摘要；失败守卫必须在投影前读取，跨新 user 仍有效。
it.instance("does not retry failed native compaction on each new user message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { native: { enabled: true, trigger_tokens: 1, target_tokens: 1, reminder_tokens: 1 } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Failed native compaction recovery" })
    const failed = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: failed.user.id,
      type: "compaction",
      auto: true,
      native: true,
    })
    yield* sessions.updateMessage({
      ...failed.assistant,
      summary: true,
      agent: "compaction",
      mode: "compaction",
      error: new MessageV2.ContextOverflowError({
        message: "Native compaction was not committed: Cannot compress queued input or pending tools",
      }).toObject(),
    })
    for (const text of ["continue after failure", "continue without retrying compaction"]) {
      yield* llm.text(`Response to ${text}`, { usage: { input: 10, output: 5 } })
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text }],
      })
      expect(result.parts.some((part) => part.type === "text" && part.text === `Response to ${text}`)).toBe(true)
    }
    expect(yield* llm.calls).toBe(2)
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
    expect((yield* llm.inputs).every((input) => !JSON.stringify(input).includes("Summarize the supplied"))).toBe(true)
    expect(
      messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.native_context_nudge),
      ),
    ).toBe(false)
  }),
)

// 261013 Red 现场超时/取消摘要没有 finish；不能让旧 marker 抢走每条新消息。
for (const name of ["UnknownError", "MessageAbortedError"] as const) {
  it.instance(`replies after a native ${name} summary without a finish`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        compaction: { native: { enabled: true, trigger_tokens: 1, target_tokens: 1, reminder_tokens: 1 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Interrupted native compaction recovery" })
      const failed = yield* seed(chat.id)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: failed.user.id,
        type: "compaction",
        auto: true,
        native: true,
      })
      yield* sessions.updateMessage({
        ...failed.assistant,
        summary: true,
        agent: "compaction",
        mode: "compaction",
        time: { ...failed.assistant.time, completed: Date.now() },
        error: { name, data: { message: "Interrupted summary" } },
      })
      for (const text of ["continue after interruption", "continue after switching models"]) {
        yield* llm.text(`Response to ${text}`, { usage: { input: 10, output: 5 } })
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text }],
        })
        expect(result.info.role === "assistant" && result.info.summary).not.toBe(true)
        expect(result.parts.some((part) => part.type === "text" && part.text === `Response to ${text}`)).toBe(true)
      }
      expect(yield* llm.calls).toBe(2)
      expect((yield* llm.inputs).every((input) => !JSON.stringify(input).includes("Summarize the supplied"))).toBe(true)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(messages.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
    }),
  )
}

for (const cancelled of [false, true]) {
  it.instance(`recovers after native compaction ${cancelled ? "cancellation" : "provider failure"}`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        compaction: { native: { enabled: true, trigger_tokens: 400000, target_tokens: 1000 } },
      }))
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Real interrupted compaction recovery" })
      const history = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: chat.id,
        messageID: history.assistant.id,
        type: "text",
        text: "Historical unprotected output. ".repeat(4000),
      })
      yield* user(chat.id, "Current uncompressed work")
      yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      if (cancelled) yield* llm.push(reply().text("Partial uncommitted summary").hang())
      if (!cancelled) yield* llm.error(400, { error: { message: "summary provider failure" } })
      if (cancelled) {
        const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(1), "native summary request did not start", "3 seconds")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(running)
      }
      if (!cancelled) yield* prompt.loop({ sessionID: chat.id })
      const before = yield* sessions.messages({ sessionID: chat.id })
      const summary = before.find((message) => message.info.role === "assistant" && message.info.summary)
      if (!cancelled)
        expect(
          summary?.info.role === "assistant" &&
            summary.info.error?.name === "APIError" &&
            summary.info.error.data.message,
        ).toContain("summary provider failure")
      expect(summary?.info.role === "assistant" && summary.info.error?.name).toBe(
        cancelled ? "MessageAbortedError" : "APIError",
      )
      expect(summary?.info.role === "assistant" && summary.info.finish).toBeUndefined()
      expect(MessageV2.latest(before).tasks).toEqual([])
      expect((yield* sessions.get(chat.id)).time.compacting).toBeUndefined()
      yield* llm.text("Normal response after interrupted compaction")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "continue actual work" }],
      })
      expect(result.info.role === "assistant" && result.info.summary).not.toBe(true)
      expect(
        result.parts.some(
          (part) => part.type === "text" && part.text === "Normal response after interrupted compaction",
        ),
      ).toBe(true)
      expect(yield* llm.calls).toBe(2)
    }),
  )
}

for (const sameModel of [true, false]) {
  it.instance(
    `native preflight ${sameModel ? "finds same-model usage behind its placeholder" : "does not reuse another model's usage"}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          compaction: { native: { enabled: true, trigger_tokens: 10000, target_tokens: 1000, reminder_tokens: 10000 } },
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Measured native preflight anchor" })
        if (!sameModel) {
          const earlier = yield* seed(chat.id, { finish: "tool-calls" })
          yield* sessions.updateMessage({
            ...earlier.assistant,
            tokens: { ...earlier.assistant.tokens, context: 100, input: 100 },
          })
        }
        const history = yield* seed(chat.id, { finish: "tool-calls" })
        yield* sessions.updateMessage({
          ...history.assistant,
          tokens: { ...history.assistant.tokens, context: 100, input: 100 },
          ...(sameModel
            ? {}
            : { modelID: ModelID.make("another-model"), providerID: ProviderID.make("another-provider") }),
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: history.assistant.id,
          type: "text",
          text: "Historical unprotected result. ".repeat(4000),
        })
        yield* llm.text("Response using measured usage", { usage: { input: 100, output: 5 } })
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "new request" }],
        })
        const requests = (yield* llm.inputs).map((input) => JSON.stringify(input))
        expect(requests.some((input) => input.includes("Summarize the supplied"))).toBe(!sameModel)
        if (sameModel) {
          expect(result.info.role === "assistant" && result.info.summary).not.toBe(true)
          expect(
            result.parts.some((part) => part.type === "text" && part.text === "Response using measured usage"),
          ).toBe(true)
          expect(yield* llm.calls).toBe(1)
        }
      }),
  )
}

it.instance("native preflight does not reuse usage measured before a committed block", () =>
  Effect.gen(function* () {
    const native = { enabled: true, trigger_tokens: 10000, target_tokens: 1000, reminder_tokens: 10000 }
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), compaction: { native } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Native usage generation boundary" })
    const history = yield* seed(chat.id, { finish: "tool-calls" })
    yield* sessions.updateMessage({
      ...history.assistant,
      tokens: { ...history.assistant.tokens, context: 1000000, input: 1000000 },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: history.assistant.id,
      type: "text",
      text: "Completed historical work. ".repeat(4000),
    })
    yield* user(chat.id, "Current work remains outside the block")
    const messages = yield* sessions.messages({ sessionID: chat.id })
    const blocks = yield* Effect.sync(() =>
      ContextCompaction.commit({
        sessionID: chat.id,
        messages,
        limits: NativeCompaction.resolve(native),
        mode: "auto",
        requestID: "generation-boundary",
        ranges: [{ startId: history.user.id, endId: history.assistant.id, summary: "Completed historical work." }],
      }),
    )
    expect(blocks[0]!.committedAt).toBeGreaterThan(history.assistant.time.created)
    yield* llm.text("Response after committed compaction", { usage: { input: 100, output: 5 } })
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "continue current work" }],
    })
    expect(
      result.parts.some((part) => part.type === "text" && part.text === "Response after committed compaction"),
    ).toBe(true)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("preparation failure releases a queued reservation for later delivery", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue preparation failure" })
    yield* seed(chat.id, { finish: "stop" })
    const queued = yield* user(chat.id, "invalid agent")
    yield* sessions.updateMessage({ ...queued, agent: "missing-agent", delivery: "queued" })

    const failed = yield* Effect.exit(prompt.loop({ sessionID: chat.id }))
    expect(Exit.isFailure(failed)).toBe(true)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("queued")
    yield* sessions.editQueuedMessage({ sessionID: chat.id, messageID: queued.id, text: "ready to retry" })
    const edited = yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id })
    if (edited.info.role !== "user") throw new Error("queued message changed role")
    yield* sessions.updateMessage({ ...edited.info, agent: "build" })

    yield* llm.text("retried after preparation failure")
    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.parts.some((part) => part.type === "text" && part.text === "retried after preparation failure")).toBe(
      true,
    )
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id }))).toBe("delivered")
  }),
)

it.instance("starts queued turns with a fresh step budget in FIFO order", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { build: { steps: 1 } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Queue step budget" })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "QUEUE_BUDGET_FIRST" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "QUEUE_BUDGET_SECOND" }],
    })
    const third = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "QUEUE_BUDGET_THIRD" }],
    })

    yield* llm.text("reply first")
    yield* llm.text("reply second")
    yield* llm.text("reply third")
    yield* prompt.loop({ sessionID: chat.id })

    const hits = yield* llm.hits
    expect(hits).toHaveLength(3)
    const sent = hits.map((hit) => JSON.stringify(hit.body))
    expect(sent[0]).toContain("QUEUE_BUDGET_FIRST")
    expect(sent[0]).not.toContain("QUEUE_BUDGET_SECOND")
    expect(sent[1]).toContain("QUEUE_BUDGET_SECOND")
    expect(sent[1]).not.toContain("QUEUE_BUDGET_THIRD")
    expect(sent[2]).toContain("QUEUE_BUDGET_THIRD")
    expect(first.info.role).toBe("user")
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: second.info.id })).info).toMatchObject({
      delivery: "delivered",
    })
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: third.info.id })).info).toMatchObject({
      delivery: "delivered",
    })
  }),
)

it.instance("hands off a capped tool turn to the next queued message with a fresh budget", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { build: { steps: 1 } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const file = path.join(directory, "queue-capped-tool.txt")
    yield* writeText(file, "tool step consumes its budget")
    const chat = yield* sessions.create({ title: "Capped queue handoff" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "original tool turn" }],
    })
    const queued = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      delivery: "queue",
      parts: [{ type: "text", text: "queued after capped tool turn" }],
    })
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("queued reply has a fresh budget")

    const result = yield* prompt.loop({ sessionID: chat.id })
    const inputs = (yield* llm.inputs).map((input) => JSON.stringify(input))
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).not.toContain("queued after capped tool turn")
    expect(inputs[1]).toContain("queued after capped tool turn")
    expect(result.info.role === "assistant" && result.info.parentID).toBe(queued.info.id)
    expect(userDelivery(yield* MessageV2.get({ sessionID: chat.id, messageID: queued.info.id }))).toBe("delivered")
  }),
)

it.instance("queued messages can be canceled before claim and promoted for the next step", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pending actions" })
    const one = yield* user(chat.id, "normal")
    const queued = yield* sessions.updateMessage({
      ...one,
      id: MessageID.ascending(),
      delivery: "queued" as const,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: queued.id,
      type: "text",
      text: "queued",
    })
    yield* sessions.deliverQueuedMessage({ sessionID: chat.id, messageID: queued.id })
    expect((yield* MessageV2.get({ sessionID: chat.id, messageID: queued.id })).info).toMatchObject({
      delivery: "steer",
    })
    const removed = yield* sessions.updateMessage({
      ...queued,
      id: MessageID.ascending(),
      delivery: "queued" as const,
    })
    yield* sessions.cancelQueuedMessage({ sessionID: chat.id, messageID: removed.id })
    const error = yield* sessions
      .editQueuedMessage({
        sessionID: chat.id,
        messageID: removed.id,
        text: "late",
      })
      .pipe(Effect.flip)
    expect(error._tag).toBe("NotFoundError")
  }),
)

it.instance("marks explicitly steered messages delivered after the provider response", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Steer delivery" })
    const messageID = MessageID.ascending()
    yield* llm.text("steer response")
    yield* prompt.prompt({
      sessionID: chat.id,
      messageID,
      agent: "build",
      delivery: "steer",
      parts: [{ type: "text", text: "steer now" }],
    })

    expect((yield* MessageV2.get({ sessionID: chat.id, messageID })).info).toMatchObject({
      delivery: "delivered",
    })
    const hits = yield* llm.hits
    expect(hits).toHaveLength(1)
    expect(JSON.stringify(hits[0].body)).toContain("steer now")
  }),
)

for (const native of [false, true]) {
  it.instance(`${native ? "native" : "legacy"} manual compaction continues the running tool turn`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        compaction: {
          native: {
            enabled: native,
            trigger_tokens: 60000,
            target_tokens: 40000,
            reminder_tokens: 54000,
            summary_max_tokens: 1000,
          },
        },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      const chat = yield* sessions.create({ title: "Manual compaction during a tool turn" })
      const history = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: history.assistant.id,
        sessionID: chat.id,
        type: "text",
        text: "Completed historical work retained for reference. ".repeat(500),
      })
      const file = path.join(dir, "manual-compaction-read.txt")
      yield* writeText(file, "current task evidence")
      const held = defer<void>()
      yield* llm.push(reply().wait(held.promise).tool("read", { filePath: file }).item())
      yield* llm.text("Earlier work summarized; continue the current implementation.")
      yield* llm.text("Current implementation continues.")
      const run = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Read the evidence and finish the implementation." }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      held.resolve()
      const result = yield* Fiber.join(run).pipe(Effect.timeout("10 seconds"))
      expect(result.info.role === "assistant" && result.info.summary).not.toBe(true)
      expect(
        result.parts.some((part) => part.type === "text" && part.text === "Current implementation continues."),
      ).toBe(true)
      expect(yield* llm.hits).toHaveLength(3)
    }),
  )
}

for (const isolated of [false, true]) {
  for (const cancelled of [false, true]) {
    it.instance(
      `task steering ${cancelled ? "cancels its delivery worker" : "survives a final-step race"}${isolated ? " in the child directory" : ""}`,
      () =>
        Effect.gen(function* () {
          const { dir, llm } = yield* useServerConfig(providerCfg)
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const jobs = yield* BackgroundJob.Service
          const parent = yield* sessions.create({})
          const child = yield* sessions.create({ parentID: parent.id })
          const instance = yield* InstanceRef
          if (!instance) return yield* Effect.die("InstanceRef missing")
          const directory = isolated ? path.join(dir, "child-directory") : dir
          if (isolated) yield* writeConfig(directory, providerCfg(llm.url))
          const ops: TaskPromptOps = {
            cancel: prompt.cancel,
            prompt: (input) => prompt.prompt(input).pipe(Effect.catch(Effect.die)),
            loop: prompt.loop,
            resolvePromptParts: prompt.resolvePromptParts,
            runIsolated: () => Effect.die("unexpected isolation setup"),
          }
          const held = defer<void>()
          yield* llm.hold("original answer", held.promise)
          yield* llm.text("corrected answer")
          yield* jobs.start({
            id: child.id,
            type: "task",
            metadata: { parentSessionId: parent.id },
            run: runSteerableTask(
              { sessionID: child.id, parentSessionID: parent.id, ops, sessions },
              ops.prompt({
                sessionID: child.id,
                agent: "build",
                model: ref,
                variant: "high",
                parts: [{ type: "text", text: "initial task" }],
              }),
            ).pipe(
              Effect.map((result) => result.parts.findLast((part) => part.type === "text")?.text ?? ""),
              Effect.provideService(InstanceRef, { ...instance, directory, worktree: directory }),
            ),
          })
          yield* llm.wait(1)
          const original = yield* sessions.findMessage(child.id, (item) => item.info.role === "user")
          if (Option.isNone(original) || original.value.info.role !== "user")
            return yield* Effect.die("Missing original task input")
          const originalUser = original.value.info
          const def = yield* TaskStatusTool.pipe(
            Effect.flatMap((tool) => tool.init()),
            Effect.provide(RuntimeFlags.layer({ experimentalBackgroundSubagents: true })),
          )
          const receipt = yield* def.execute(
            { task_id: child.id, message: "focus on the corrected task" },
            {
              sessionID: parent.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          expect(receipt.metadata.delivery).toBe("queued")
          const messageID = receipt.metadata.message_id
          if (!messageID) return yield* Effect.die("Missing steering receipt")
          const persisted = yield* MessageV2.get({ sessionID: child.id, messageID })
          expect(persisted.info).toMatchObject({
            role: "user",
            agent: originalUser.agent,
            model: originalUser.model,
            delivery: "steer",
          })
          expect(persisted.parts).toHaveLength(1)
          if (cancelled) {
            yield* jobs.cancel(child.id)
            expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
            expect(yield* llm.hits).toHaveLength(1)
            expect(() => steerTask(child.id, parent.id, "must not restart")).toThrow("not accepting")
            held.resolve()
            return
          }
          held.resolve()
          const completed = yield* jobs.wait({ id: child.id, timeout: 5_000 })
          expect(completed.info?.status).toBe("completed")
          expect(completed.info?.output).toBe("corrected answer")
          expect(userDelivery(yield* MessageV2.get({ sessionID: child.id, messageID }))).toBe("delivered")
          const hits = yield* llm.hits
          expect(hits).toHaveLength(2)
          expect(JSON.stringify(hits[1].body)).toContain("focus on the corrected task")
          const answer = yield* sessions.findMessage(child.id, (item) => item.info.role === "assistant")
          expect(Option.isSome(answer) && answer.value.info.role === "assistant" && answer.value.info.path.cwd).toBe(
            directory,
          )
        }),
    )
  }
}

it.instance("user permission rejection does not restart the queued turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const permissions = yield* Permission.Service
    const bus = yield* Bus.Service
    const { directory } = yield* TestInstance
    const file = path.join(directory, "permission-denied.txt")
    yield* writeText(file, "permission test")
    const asked = yield* bus.subscribe(Permission.Event.Asked)
    let rejections = 0
    yield* Stream.runForEach(asked, (event) =>
      Effect.gen(function* () {
        rejections++
        yield* permissions.reply({ requestID: event.properties.id, reply: "reject" })
      }),
    ).pipe(Effect.forkScoped)
    const chat = yield* sessions.create({
      title: "Permission rejection",
      permission: [{ permission: "read", pattern: "*", action: "ask" }],
    })
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("must not be sent after user rejection")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      delivery: "queue",
      parts: [{ type: "text", text: "read the protected file" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(rejections).toBe(1)
    expect(yield* llm.calls).toBe(1)
    expect(yield* llm.pending).toBe(1)
  }),
)

for (const { configuredLimit, interleave } of [undefined, 1, 3].flatMap((configuredLimit) =>
  [false, true].map((interleave) => ({ configuredLimit, interleave })),
)) {
  const limit = configuredLimit ?? 2
  it.instance(
    `repeated tool failures cap model requests (limit=${configuredLimit ?? "default"}, bookkeeping=${interleave})`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          agent: { redmind: { permission: { doom_loop: "allow" } } },
          ...(configuredLimit === undefined ? {} : { experimental: { repeated_tool_failure_limit: configuredLimit } }),
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const registry = yield* ToolRegistry.Service
        const jobs = yield* BackgroundJob.Service
        const { directory } = yield* TestInstance
        const chat = yield* sessions.create({
          title: "Repeated failure budget",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const child = yield* sessions.create({ parentID: chat.id, title: "Independent background task" })
        yield* jobs.start({
          id: child.id,
          type: "task",
          metadata: { parentSessionId: chat.id },
          run: Effect.never,
        })
        yield* Effect.addFinalizer(() => jobs.cancel(child.id))
        const { read } = yield* registry.named()
        const original = read.execute
        let executions = 0
        read.execute = (args, context) =>
          Effect.gen(function* () {
            executions++
            return yield* original(args, context)
          })
        yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))
        for (let i = 0; i <= limit; i++) {
          yield* llm.tool("read", { filePath: path.join(directory, "missing.txt") })
          if (interleave && i < limit) yield* llm.tool("todoread", {})
        }
        yield* llm.text("must not consume another model request")
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "read the file" }],
        })
        expect(yield* llm.calls).toBe(interleave ? 2 * limit + 1 : limit + 1)
        expect(yield* llm.pending).toBe(1)
        expect(executions).toBe(limit)
        expect((yield* jobs.get(child.id))?.status).toBe("running")
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("重复失败"))).toBe(true)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[interleave ? 2 * limit - 1 : limit])).toContain("Repeated tool failure")
      }),
  )
}

it.instance("repeated tool failures in one parallel batch do not trigger another model request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const chat = yield* sessions.create({
      title: "Parallel failure budget",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const missing = { filePath: path.join(directory, "missing.txt") }
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      id: "parallel-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason }],
    })
    yield* llm.push(
      raw({
        chunks: [
          chunk({ role: "assistant" }),
          chunk({
            tool_calls: Array.from({ length: 3 }, (_, index) => ({
              index,
              id: `parallel_${index}`,
              type: "function",
              function: { name: "read", arguments: JSON.stringify(missing) },
            })),
          }),
          chunk({}, "tool_calls"),
        ],
      }),
    )
    yield* llm.text("must not consume a follow-up request")
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "read the file" }],
    })
    expect(yield* llm.calls).toBe(1)
    expect(yield* llm.pending).toBe(1)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("重复失败"))).toBe(true)
  }),
)

it.instance("repeated tool failure budget permits corrected arguments and a new user turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const chat = yield* sessions.create({
      title: "Corrected tool arguments",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const missing = { filePath: path.join(directory, "missing.txt") }
    const file = path.join(directory, "exists.txt")
    yield* writeText(file, "successful correction")
    yield* llm.tool("read", missing)
    yield* llm.tool("read", missing)
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("corrected")
    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "read a file" }],
    })
    expect(yield* llm.calls).toBe(4)
    expect(first.parts.some((part) => part.type === "text" && part.text === "corrected")).toBe(true)
    yield* llm.tool("read", missing)
    yield* llm.text("new turn has its own budget")
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "retry the missing file once" }],
    })
    expect(yield* llm.calls).toBe(6)
    expect(second.parts.some((part) => part.type === "text" && part.text === "new turn has its own budget")).toBe(true)
  }),
)

it.instance("refreshes session permissions at the start of each step", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    const { directory } = yield* TestInstance
    const chat = yield* sessions.create({
      title: "Step settings",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(directory, "step-settings.txt")
    yield* writeText(file, "step settings")

    const { read } = yield* registry.named()
    const original = read.execute
    let executions = 0
    read.execute = (args, context) =>
      Effect.gen(function* () {
        executions++
        if (executions === 1) {
          yield* sessions.setPermission({
            sessionID: chat.id,
            permission: [{ permission: "read", pattern: "*", action: "deny" }],
          })
        }
        return yield* original(args, context)
      })
    yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

    yield* llm.tool("read", { filePath: file })
    yield* llm.tool("read", { filePath: file })
    yield* llm.text("done")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "read the file twice" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(executions).toBe(1)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

for (const childFails of [false, true]) {
  it.instance(
    `background child ${childFails ? "failure" : "success"} is saved once before the busy parent resumes`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          agent: { explore: { model: `${ref.providerID}/${ref.modelID}` } },
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const jobs = yield* BackgroundJob.Service
        const chat = yield* sessions.create({ title: "Background result delivery" })
        const { assistant } = yield* seed(chat.id, { finish: "stop" })
        yield* status.set(chat.id, { type: "busy" })
        const resumed = yield* Deferred.make<MessageV2.WithParts>()
        let resumes = 0
        const ops: TaskPromptOps = {
          cancel: prompt.cancel,
          resolvePromptParts: prompt.resolvePromptParts,
          prompt: (input) =>
            childFails && !input.noReply
              ? Effect.die(new Error("injected child failure"))
              : prompt.prompt(input).pipe(Effect.orDie),
          loop: (input) =>
            Effect.gen(function* () {
              resumes++
              const result = yield* prompt.loop(input)
              yield* Deferred.succeed(resumed, result)
              return result
            }),
          runIsolated: () => Effect.die("unexpected isolation in delivery test"),
        }
        if (!childFails) yield* llm.text("saved child evidence")
        yield* llm.text("parent consumed background result")
        const def = yield* (yield* TaskTool).init()
        const result = yield* def.execute(
          {
            description: "inspect background delivery",
            prompt: "Return evidence for the parent.",
            subagent_type: "explore",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: ops },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const waited = yield* jobs.wait({ id: result.metadata.sessionId })
        expect(waited.info?.status).toBe(childFails ? "error" : "completed")
        const deliveries = Effect.gen(function* () {
          return (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((message) =>
            message.parts.filter(
              (part) => part.type === "text" && part.synthetic && part.text.includes(result.metadata.sessionId),
            ),
          )
        })
        expect(yield* deliveries).toHaveLength(1)
        expect(JSON.stringify(yield* deliveries)).toContain(childFails ? "task_error" : "saved child evidence")
        expect(resumes).toBe(0)
        yield* status.set(chat.id, { type: "idle" })
        yield* TestClock.adjust("300 millis")
        yield* Deferred.await(resumed)
        expect(resumes).toBe(1)
        expect(yield* deliveries).toHaveLength(1)
        expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain(
          childFails ? "injected child failure" : "saved child evidence",
        )
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ experimentalBackgroundSubagents: true })),
        Effect.provide(TestClock.layer()),
      ),
  )
}

it.instance("background result survives the busy-parent resume deadline and can be continued manually", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: { explore: { model: `${ref.providerID}/${ref.modelID}` } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const jobs = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const toasts = yield* bus.subscribe(TuiEvent.ToastShow)
    const chat = yield* sessions.create({ title: "Busy parent delivery deadline" })
    const { assistant } = yield* seed(chat.id, { finish: "stop" })
    yield* status.set(chat.id, { type: "busy" })
    const clock = yield* Clock.Clock
    let elapsed = 0
    let resumes = 0
    const ops: TaskPromptOps = {
      cancel: prompt.cancel,
      resolvePromptParts: prompt.resolvePromptParts,
      prompt: (input) => prompt.prompt(input).pipe(Effect.orDie),
      loop: (input) =>
        Effect.gen(function* () {
          resumes++
          return yield* prompt.loop(input)
        }),
      runIsolated: () => Effect.die("unexpected isolation in delivery deadline test"),
    }
    yield* llm.text("deadline child evidence")
    const def = yield* (yield* TaskTool).init()
    const result = yield* def
      .execute(
        {
          description: "inspect busy parent delivery",
          prompt: "Return evidence for the busy parent.",
          subagent_type: "explore",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: ops },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      .pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + elapsed,
          currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + elapsed),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(elapsed) * 1_000_000n,
          currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(elapsed) * 1_000_000n),
        }),
      )
    expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.status).toBe("completed")
    // 261017 Red 墙钟跳过期限后只唤醒一个 tick，避免为测试循环执行六千次数据库轮询。
    elapsed = 31 * 60_000
    yield* TestClock.adjust("300 millis")
    const notice = yield* Stream.runHead(
      toasts.pipe(Stream.filter((event) => event.properties.title === "Background task result waiting")),
    )
    expect(Option.isSome(notice)).toBe(true)
    expect(resumes).toBe(0)
    const deliveries = (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((message) =>
      message.parts.filter(
        (part) => part.type === "text" && part.synthetic && part.text.includes(result.metadata.sessionId),
      ),
    )
    expect(deliveries).toHaveLength(1)
    expect(JSON.stringify(deliveries)).toContain("deadline child evidence")
    yield* status.set(chat.id, { type: "idle" })
    yield* llm.text("manually recovered background evidence")
    const continued = yield* prompt.loop({ sessionID: chat.id })
    expect(continued.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "manually recovered background evidence" }),
    )
    expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain("deadline child evidence")
    expect(resumes).toBe(0)
  }).pipe(
    Effect.provide(RuntimeFlags.layer({ experimentalBackgroundSubagents: true })),
    Effect.provide(TestClock.layer()),
  ),
)

it.instance(
  "Explore child executes scoped Git and returns its result without acquiring shell writes",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: { explore: { model: `${ref.providerID}/${ref.modelID}` } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Explore Git smoke",
        permission: [{ permission: "task", pattern: "explore", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect Git count",
        prompt: "Inspect the repository commit count and return evidence.",
        subagent_type: "explore",
      })
      yield* llm.tool("bash", {
        command: `git -C "${dir.replaceAll("\\", "/")}" rev-list --count HEAD`,
        shell: "bash",
        description: "Count repository commits",
      })
      yield* llm.tool("bash", {
        command: "git log --output=forbidden.txt",
        shell: "bash",
        description: "Reject output file creation",
      })
      yield* llm.text("child Git evidence returned")
      yield* llm.text("parent reviewed child Git evidence")
      yield* user(chat.id, "Inspect Git using an Explore child.")
      const result = yield* prompt.loop({ sessionID: chat.id })
      const parentMessages = yield* MessageV2.filterCompactedEffect(chat.id)
      const task = parentMessages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "task")
      expect(task).toMatchObject({
        state: { status: "completed", output: expect.stringContaining("child Git evidence returned") },
      })
      const child = (yield* sessions.children(chat.id))[0]
      if (!child) throw new Error("Explore child was not created")
      const childMessages = yield* MessageV2.filterCompactedEffect(child.id)
      const tools = childMessages.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
      expect(tools).toHaveLength(2)
      expect(tools[0]).toMatchObject({ tool: "bash", state: { status: "completed", metadata: { exit: 0 } } })
      expect(tools[1]).toMatchObject({ tool: "bash", state: { status: "error" } })
      expect(yield* (yield* AppFileSystem.Service).existsSafe(path.join(dir, "forbidden.txt"))).toBe(false)
      expect(result.parts).toContainEqual(
        expect.objectContaining({ type: "text", text: "parent reviewed child Git evidence" }),
      )
      expect(yield* llm.calls).toBe(5)
    }),
  { git: true },
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("missing-model"),
    })
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(subtaskCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          // 260828 cc 别名自愈存储：入参写 "build"，落库的是解析后的 "redmind"
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "redmind")
          const tool = assistant?.parts.find(
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  3_000,
)

it.instance(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  3_000,
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(subtaskCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  3_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  3_000,
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  3_000,
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const parent = path.dirname(dir)
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "cd .. && pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain(parent)
      expect(tool.state.metadata.output).toContain(parent)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

it.instance(
  "command ! expansion marks non-zero exit",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: {
          probe: {
            template: "Probe: !`node -e \"process.stdout.write('ok'); process.exit(7)\"`",
          },
        },
      }))

      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "probe",
        arguments: "",
      })

      expect(result.info.role).toBe("assistant")
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs.at(-1)?.messages)).toMatch(/Command failed with exit code \d+\./)
    }),
  { config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* AppFileSystem.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* Effect.sleep(150)
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "rejects an oversized binary attachment before reading its file bytes",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const binaryPath = path.join(dir, "large.bin")
      const bytes = Buffer.alloc(4 * 1024 * 1024)
      yield* Effect.promise(() => Bun.write(binaryPath, bytes))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "application/octet-stream", url: `file://${binaryPath}`, filename: "large.bin" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      expect(msg.parts.some((part) => part.type === "file" && part.filename === "large.bin")).toBe(false)
      expect(
        msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("over the inline budget"),
        ),
      ).toBe(true)
      expect(Bun.file(binaryPath).size).toBe(bytes.byteLength)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

boundedImageServer.instance(
  "fails closed when the initial image preflight stat fails",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const imagePath = path.join(dir, "stat-failed.png")
      const bytes = Buffer.alloc(10 * 1024 * 1024 + 1)
      yield* Effect.promise(() => Bun.write(imagePath, bytes))
      Object.assign(imageReadProbe, {
        path: imagePath,
        failFirstStat: true,
        reportedSize: undefined,
        statCalls: 0,
        readBytes: 0,
        readRequests: [],
        normalized: [],
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: `file://${imagePath}`, filename: "stat-failed.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      expect(imageReadProbe.statCalls).toBe(1)
      expect(imageReadProbe.readBytes).toBe(0)
      expect(imageReadProbe.normalized).toEqual([])
      expect(msg.parts.some((part) => part.type === "file" && part.filename === "stat-failed.png")).toBe(false)
      expect(
        msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("could not be checked")),
      ).toBe(true)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

boundedImageServer.instance(
  "bounds image reads to preflight size plus one when the file grows",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const imagePath = path.join(dir, "grown.png")
      yield* Effect.promise(() => Bun.write(imagePath, Buffer.alloc(4 * 1024 * 1024)))
      Object.assign(imageReadProbe, {
        path: imagePath,
        failFirstStat: false,
        reportedSize: 16,
        statCalls: 0,
        readBytes: 0,
        readRequests: [],
        normalized: [],
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: `file://${imagePath}`, filename: "grown.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      expect(imageReadProbe.readBytes).toBe(17)
      expect(imageReadProbe.readRequests).toEqual([17])
      expect(imageReadProbe.normalized).toEqual([])
      expect(msg.parts.some((part) => part.type === "file" && part.filename === "grown.png")).toBe(false)
      expect(
        msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("changed size during reading"),
        ),
      ).toBe(true)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// 261018 Red 压缩包只落盘不内联：即使是 4 MiB（超过旧的非图片 3.75 MiB 读盘闸门）也必须保留
// file:// part，交给 provider/transform 换成路径占位；任何 base64 内联都是设计外的内存放大。
noLLMServer.instance(
  "keeps an archive attachment on disk without reading or inlining it",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const archivePath = path.join(dir, "debug.zip")
      const bytes = Buffer.alloc(4 * 1024 * 1024)
      yield* Effect.promise(() => Bun.write(archivePath, bytes))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "application/zip", url: `file://${archivePath}`, filename: "debug.zip" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      const saved = stored.parts.find((part) => part.type === "file" && part.filename === "debug.zip")
      expect(saved?.type).toBe("file")
      if (saved?.type !== "file") throw new Error("expected persisted archive part")
      expect(saved.url.startsWith("file://")).toBe(true)
      expect(Buffer.byteLength(saved.url)).toBeLessThan(bytes.byteLength / 4)
      expect(
        stored.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.toLowerCase().includes("not inlined"),
        ),
      ).toBe(false)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "normalizes a bounded oversized image attachment before persisting it",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const side = 1_200
      const pixels = new Uint8Array(side * side * 4)
      let seed = 0x2545f491
      for (let i = 0; i < pixels.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        pixels[i] = seed & 0xff
        pixels[i + 1] = (seed >>> 8) & 0xff
        pixels[i + 2] = (seed >>> 16) & 0xff
        pixels[i + 3] = 255
      }
      const source = new photon.PhotonImage(pixels, side, side)
      const imagePath = path.join(dir, "large.png")
      const bytes = Buffer.from(source.get_bytes())
      source.free()
      yield* Effect.promise(() => Bun.write(imagePath, bytes))
      expect(bytes.byteLength).toBeGreaterThan(3.75 * 1024 * 1024)
      expect(bytes.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: `file://${imagePath}`, filename: "large.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      const saved = stored.parts.find((part) => part.type === "file" && part.filename === "large.png")
      expect(saved?.type).toBe("file")
      if (saved?.type !== "file") throw new Error("expected persisted image part")
      expect(saved.url.startsWith("data:image/")).toBe(true)
      expect(Buffer.byteLength(saved.url.slice(saved.url.indexOf(";base64,") + 8))).toBeLessThanOrEqual(5 * 1024 * 1024)
      expect(
        stored.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("downscaled for transport"),
        ),
      ).toBe(true)
      expect(Bun.file(imagePath).size).toBe(bytes.byteLength)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "rejects an image over the source limit without persisting its bytes",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const imagePath = path.join(dir, "over-limit.png")
      const bytes = Buffer.alloc(10 * 1024 * 1024 + 1)
      yield* Effect.promise(() => Bun.write(imagePath, bytes))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: `file://${imagePath}`, filename: "over-limit.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      expect(msg.parts.some((part) => part.type === "file" && part.filename === "over-limit.png")).toBe(false)
      expect(msg.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("10 MiB"))).toBe(
        true,
      )
      expect(Bun.file(imagePath).size).toBe(bytes.byteLength)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noResizerServer.instance(
  "keeps a small image on the original path when normalization is unavailable",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(64 * 64 * 4).fill(255), 64, 64)
      const bytes = Buffer.from(source.get_bytes())
      source.free()
      const imagePath = path.join(dir, "small.png")
      yield* Effect.promise(() => Bun.write(imagePath, bytes))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: `file://${imagePath}`, filename: "small.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      const saved = stored.parts.find((part) => part.type === "file" && part.filename === "small.png")
      expect(saved?.type).toBe("file")
      if (saved?.type !== "file") throw new Error("expected the original small image to persist")
      expect(saved.url).toBe(`data:image/png;base64,${bytes.toString("base64")}`)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noResizerServer.instance(
  "does not fall back to the over-budget original when image normalization is unavailable",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const source = Buffer.alloc(4 * 1024 * 1024).toString("base64")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${source}`,
            filename: "unavailable.png",
          },
        ],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      expect(stored.parts.some((part) => part.type === "file" && part.filename === "unavailable.png")).toBe(false)
      expect(
        stored.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("could not be safely normalized"),
        ),
      ).toBe(true)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

overBudgetNormalizerServer.instance(
  "rejects normalized image output above the fixed attachment budget",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==", filename: "output.png" }],
      })
      if (msg.info.role !== "user") throw new Error("expected user message")
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      expect(stored.parts.some((part) => part.type === "file" && part.filename === "output.png")).toBe(false)
      expect(
        stored.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("exceeds the transport budget"),
        ),
      ).toBe(true)
      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions before workspace paths and agents",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const references = parts.filter(
        (part): part is MessageV2.TextPartInput =>
          part.type === "text" && part.synthetic === true && part.text.startsWith("Referenced configured reference "),
      )
      const files = parts.filter((part): part is MessageV2.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is MessageV2.AgentPartInput => part.type === "agent")
      const bare = references.find((part) => part.text.includes("@docs."))
      const missing = references.find((part) => part.text.includes("@docs/missing.md"))
      const guide = files.find((part) => part.filename === "docs/guide")

      expect(references.length).toBe(2)
      expect(bare?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
      })
      expect(missing?.text).toContain("Path does not exist inside configured reference @docs")
      expect(missing?.metadata?.reference).toMatchObject({
        target: "missing.md",
        targetPath: path.join(docs, "missing.md"),
      })

      expect(files.length).toBe(2)
      expect(files.map((file) => fileURLToPath(file.url)).sort()).toEqual(
        [path.join(docs, "README.md"), path.join(docs, "guide")].sort(),
      )
      expect(guide?.mime).toBe("application/x-directory")
      expect(agents.map((agent) => agent.name)).toEqual(["redmind"])
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "reports missing local path mentions",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts("Read @missing-redcode-test.md")
      const problem = parts.find(
        (part): part is MessageV2.TextPartInput => part.type === "text" && part.synthetic === true,
      )

      expect(problem).toBeDefined()
      if (!problem) throw new Error("missing local path should produce a synthetic diagnostic")
      expect(problem.text).toContain("Path does not exist")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "injects metadata for bare configured reference mentions",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: yield* prompt.resolvePromptParts("Use @docs for context"),
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) => part.text.startsWith("Referenced configured reference @docs."))

      expect(reference?.metadata?.reference).toMatchObject({ name: "docs", kind: "local", path: docs })
      expect(synthetic.some((part) => part.text.includes(`Reference root: ${docs}`))).toBe(true)
      expect(synthetic.some((part) => part.text.includes("subagent explore"))).toBe(true)

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "injects metadata for configured reference file attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      const readme = path.join(docs, "README.md")
      yield* ensureDir(docs)
      yield* writeText(readme, "reference readme")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "Read @docs/README.md" },
          {
            type: "file",
            mime: "text/plain",
            filename: "docs/README.md",
            url: pathToFileURL(readme).href,
            source: {
              type: "file",
              path: "docs/README.md",
              text: { value: "@docs/README.md", start: 5, end: 20 },
            },
          },
        ],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) =>
        part.text.startsWith("Referenced configured reference @docs/README.md."),
      )

      expect(reference?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
        target: "README.md",
        targetPath: readme,
        source: { value: "@docs/README.md", start: 5, end: 20 },
      })
      expect(synthetic.findIndex((part) => part === reference)).toBeLessThan(
        synthetic.findIndex((part) => part.text.startsWith("Called the Read tool with the following input:")),
      )

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/redcode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("redcode"), modelID: ModelID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("redmind")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
