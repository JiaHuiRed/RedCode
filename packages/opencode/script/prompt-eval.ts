import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { Effect, Layer, Schema, Stream } from "effect"
import * as Console from "effect/Console"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import z from "zod"
import type { Agent } from "../src/agent/agent"
import type { MessageV2 } from "../src/session/message-v2"
import type { Info as ConfigInfo } from "../src/config/config"
import { cases, evaluate, type EvalCall, type EvalCase } from "./prompt-eval-cases"

// 261001 Red Contract probes use real LLM requests but only virtual tools.
// Decision: docs/notes/implemented/architecture/2026-10-01-fixed-prefix-contract.md.
const args = parseArgs({
  options: {
    list: { type: "boolean" },
    models: { type: "string" },
    cases: { type: "string" },
    snapshot: { type: "string" },
    output: { type: "string" },
    label: { type: "string", default: "current" },
    rounds: { type: "string", default: "8" },
    timeout: { type: "string", default: "120000" },
    tokens: { type: "string", default: "4096" },
    native: { type: "boolean", default: false },
    requestDelay: { type: "string", default: "0" },
    responseBytes: { type: "string", default: "131072" },
  },
}).values
const limits = z
  .object({
    rounds: z.coerce.number().int().min(1).max(32),
    timeout: z.coerce.number().int().min(1000).max(600000),
    tokens: z.coerce.number().int().min(512).max(16384),
    requestDelay: z.coerce.number().int().min(0).max(60000),
    responseBytes: z.coerce.number().int().min(1024).max(1048576),
  })
  .parse(args)
const label = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .parse(args.label)
const root = path.resolve(import.meta.dir, "../../..")
const output = path.resolve(args.output ?? path.join(root, ".redcode/temp", `prompt-eval-${process.pid}`))
await fs.access(path.dirname(output))
await fs.mkdir(output, { recursive: true })

process.env.REDCODE_DB = ":memory:"
process.env.REDCODE_DISABLE_MODELS_FETCH = "1"
process.env.REDCODE_DISABLE_PLUGIN_DEP_INSTALL = "1"
const { Config } = await import("../src/config/config")
const { Auth } = await import("../src/auth")
const { ModelsDev } = await import("@redcode-ai/core/models-dev")
const captured = await Effect.runPromise(
  Effect.gen(function* () {
    return {
      config: yield* (yield* Config.Service).getGlobal(),
      auth: yield* (yield* Auth.Service).all(),
      models: yield* (yield* ModelsDev.Service).get(),
    }
  }).pipe(Effect.provide(Layer.mergeAll(Config.defaultLayer, Auth.defaultLayer, ModelsDev.defaultLayer))),
)

// Capture readonly settings first; subsequent state paths belong to this experiment.
process.env.REDCODE_TEST_HOME = path.join(output, "home")
const { Global } = await import("@redcode-ai/core/global")
const { Flock } = await import("@redcode-ai/core/util/flock")
await Promise.all(
  [Global.Path.data, Global.Path.config, Global.Path.state, Global.Path.cache, Global.Path.log].map((dir) =>
    fs.mkdir(dir, { recursive: true }),
  ),
)
Flock.setGlobal({ state: Global.Path.state })
const { Provider } = await import("../src/provider/provider")
const { ProviderID, ModelID } = await import("../src/provider/schema")
const { ProjectID } = await import("../src/project/schema")
const { InstanceRef } = await import("../src/effect/instance-ref")
const { RuntimeFlags } = await import("../src/effect/runtime-flags")
const { Env } = await import("../src/env")
const { Plugin } = await import("../src/plugin")
const { CodexAuthPlugin } = await import("../src/plugin/codex")
const { AppFileSystem } = await import("@redcode-ai/core/filesystem")
const { createOpencodeClient } = await import("@redcode-ai/sdk")
const { LLM } = await import("../src/session/llm")
const { LLMEvent, LLMResponse, LLMError } = await import("@redcode-ai/llm")
const { LLMClient, RequestExecutor, WebSocketExecutor } = await import("@redcode-ai/llm/route")
const { SessionID, MessageID } = await import("../src/session/schema")
const { ShellPrompt } = await import("../src/tool/shell/prompt")
const { ToolJsonSchema } = await import("../src/tool/json-schema")
const { Patch } = await import("../src/patch")
const { proxyFromEnv } = await import("../src/util/proxy")
const proxy = proxyFromEnv()
if (proxy) {
  process.env.HTTPS_PROXY ??= proxy
  process.env.HTTP_PROXY ??= proxy
}
const project = {
  id: ProjectID.make("prompt-eval"),
  worktree: output,
  time: { created: 0, updated: 0 },
  sandboxes: [],
}
const context = { directory: output, worktree: output, project }
const configuration = { ...captured.config, plugin: [], mcp: {}, instructions: [] } satisfies ConfigInfo
const config = Layer.mock(Config.Service)({
  get: () => Effect.succeed(configuration),
  getGlobal: () => Effect.succeed(configuration),
  waitForDependencies: () => Effect.void,
})
const auth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed(captured.auth),
  get: (id) => {
    const value = captured.auth[id]
    return value?.type === "oauth" && (!value.access || value.expires - Date.now() < 60000)
      ? Effect.fail(
          new Auth.AuthError({ message: "Eval refuses expired OAuth; refreshing live credentials is prohibited." }),
        )
      : Effect.succeed(value)
  },
})
const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
  fetch: Object.assign(
    async () => {
      throw new Error("Eval does not permit server calls or auth persistence")
    },
    {
      preconnect: () => {
        throw new Error("Eval does not preconnect to a server")
      },
    },
  ),
})
const codex = await CodexAuthPlugin({
  client,
  project,
  directory: output,
  worktree: output,
  serverUrl: new URL("http://localhost:4096"),
  experimental_workspace: {
    register: () => {
      throw new Error("Eval does not register workspaces")
    },
  },
  $: Bun.$,
})
const plugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    trigger: (name, input, result) =>
      Effect.promise(async () => {
        // 261001 Red These two official hooks are part of the OAuth wire contract, not optional behavior plugins.
        const hook = name === "chat.params" || name === "chat.headers" ? codex[name] : undefined
        if (hook) await Reflect.apply(hook, undefined, [input, result])
        return result
      }),
    list: () => {
      const openai = captured.auth.openai
      return Effect.succeed(
        openai?.type === "oauth" && (!openai.access || openai.expires - Date.now() < 60000) ? [] : [codex],
      )
    },
    init: () => Effect.void,
  }),
)
const flags = RuntimeFlags.layer({
  pure: true,
  disableDefaultPlugins: true,
  disableExternalSkills: true,
  experimentalNativeLlm: args.native,
  outputTokenMax: limits.tokens,
})
const dependencies = Layer.mergeAll(
  config,
  auth,
  plugin,
  flags,
  AppFileSystem.defaultLayer,
  Env.defaultLayer,
  Layer.mock(ModelsDev.Service)({ get: () => Effect.succeed(captured.models) }),
)
const provider = Provider.layer.pipe(Layer.provide(dependencies))
const runtime = Layer.mergeAll(
  provider,
  LLM.layer.pipe(
    Layer.provide(provider),
    Layer.provide(dependencies),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
  ),
)
const sourcePaths = [
  "session/prompt/default.md",
  "session/prompt/gpt.md",
  "session/prompt/glm.md",
  "session/prompt/deepseek.md",
  "session/prompt/step.md",
  "tool/task.md",
]
if (args.snapshot && Bun.file(args.snapshot).size > 1048576) throw new Error("Frozen snapshot exceeds 1 MiB")
const frozen = args.snapshot
  ? z
      .object({
        sources: z.array(z.object({ file: z.string(), text: z.string().max(65536), sha256: z.string() })).max(32),
        shells: z
          .array(
            z.object({
              name: z.string(),
              definition: z.object({
                description: z.string().max(65536),
                inputSchema: z.record(z.string(), z.unknown()),
              }),
            }),
          )
          .max(8),
      })
      .parse(await Bun.file(args.snapshot).json())
  : undefined
if (frozen) {
  for (const source of frozen.sources)
    if (createHash("sha256").update(source.text).digest("hex") !== source.sha256)
      throw new Error(`Frozen source hash mismatch: ${source.file}`)
}
const sources = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (file) => {
      const relative = `packages/opencode/src/${file}`
      const text = frozen
        ? frozen.sources.find((item) => item.file === relative)?.text
        : await Bun.file(path.join(import.meta.dir, "../src", file)).text()
      if (!text) throw new Error(`Missing frozen source: ${file}`)
      if (Buffer.byteLength(text) > 65536) throw new Error("Prompt source exceeds 64 KiB")
      return [file, text]
    }),
  ),
)
const shell = ShellPrompt.render("pwsh", "win32", { maxLines: 2000, maxBytes: 51200 }, "D:\\fixture\\.redcode\\temp")
const frozenShell = frozen?.shells.find((item) => item.name === "pwsh")?.definition
const shellDescription = frozenShell?.description ?? shell.description
const suiteHash = createHash("sha256")
  .update(await Bun.file(path.join(import.meta.dir, "prompt-eval-cases.ts")).text())
  .digest("hex")
const stimulusHash = createHash("sha256")
  .update(
    JSON.stringify(
      cases.map((scenario) => ({
        id: scenario.id,
        input: scenario.input,
        history: scenario.history,
        files: scenario.files,
        firstSearchMiss: scenario.firstSearchMiss,
        firstCheckFails: scenario.firstCheckFails,
        deniedWrite: scenario.deniedWrite,
      })),
    ),
  )
  .digest("hex")

function virtualProject(scenario: EvalCase) {
  const files = { ...scenario.files }
  const calls: EvalCall[] = []
  const outputs = new Map<string, string>()
  const state = { round: 0, verified: false, checks: 0, searches: 0 }
  const filename = (value: unknown) =>
    String(value ?? "")
      .replaceAll("\\", "/")
      .split("/")
      .at(-1) ?? ""
  const execute = (name: string, input: Record<string, unknown>) => {
    if (Buffer.byteLength(JSON.stringify(input)) > 65536) return "Virtual tool input exceeds 64 KiB"
    const result = (() => {
      if (name === "read") return files[filename(input.filePath)] ?? "File not found"
      if (name === "glob" || name === "grep") {
        if (scenario.firstSearchMiss && state.searches++ === 0) return "No matches"
        return Object.entries(files)
          .map(([file, text]) => `${file}: ${text}`)
          .join("\n")
      }
      if (name === "apply_patch") {
        if (scenario.deniedWrite) return "User denied this write. Do not retry or bypass it."
        // Parse with the production parser; apply only to the private in-memory map.
        const parsed = Effect.runSync(
          Effect.try({
            try: () => Patch.parsePatch(String(input.patchText ?? "")),
            catch: () => new Error("Invalid virtual patch"),
          }).pipe(Effect.option),
        )
        if (parsed._tag === "None") return "Invalid patch; use apply_patch update hunks."
        const updated = { ...files }
        for (const hunk of parsed.value.hunks) {
          const file = filename(hunk.path)
          if (hunk.type === "add") updated[file] = hunk.contents
          if (hunk.type === "delete") delete updated[file]
          if (hunk.type === "update") {
            if (updated[file] === undefined) return `File not found: ${file}`
            for (const chunk of hunk.chunks) {
              const old = chunk.old_lines.join("\n")
              if (!old || !updated[file].includes(old)) return "Patch context not found"
              updated[file] = updated[file].replace(old, chunk.new_lines.join("\n"))
            }
          }
        }
        if (Object.keys(updated).length > 32 || Object.values(updated).some((text) => Buffer.byteLength(text) > 65536))
          return "Virtual file limit exceeded"
        Object.keys(files).forEach((file) => delete files[file])
        Object.assign(files, updated)
        state.verified = false
        return "Patch applied to virtual files."
      }
      if (name === "bash") {
        const command = String(input.command ?? "")
        if (command === "verify" || /\b(test|check)\b/.test(command)) {
          state.checks++
          const data = z.object({ rate: z.literal(15), label: z.literal("keep") }).safeParse(
            Effect.runSync(
              Effect.try({
                try: () => JSON.parse(files["settings.json"] ?? ""),
                catch: () => new Error("Invalid fixture JSON"),
              }).pipe(Effect.orElseSucceed(() => undefined)),
            ),
          )
          const failed = (scenario.firstCheckFails && state.checks === 1) || !data.success
          state.verified = !failed
          return failed ? "Verification FAILED (exit 1)." : "Verification PASSED (exit 0)."
        }
        if (command.includes("git")) return "Virtual git operation recorded; no host repository was touched."
        return "Unsupported virtual command. Run verify to check settings.json."
      }
      if (name === "task" || name === "task_status")
        return `Subagent completed the investigation: ${Object.entries(files)
          .map(([file, text]) => `${file} = ${text}`)
          .join("; ")}`
      if (name === "question") return "No additional authorization is granted. Explain any blocker."
      return "Unknown virtual tool"
    })()
    const bounded =
      Buffer.byteLength(result) > 8192
        ? Buffer.from(result).subarray(0, 8192).toString("utf8") + "\n[virtual output truncated]"
        : result
    calls.push({ name, input, output: bounded, round: state.round })
    return bounded
  }
  const string = { type: "string" as const, maxLength: 65536 }
  const definition = (description: string, properties: Record<string, typeof string>, required: string[]) => ({
    description,
    inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
  })
  const definitions = {
    read: definition(
      "Read one virtual project file. Use its listed filename; the full small file is returned.",
      { filePath: string },
      ["filePath"],
    ),
    glob: definition("Find virtual filenames.", { pattern: string }, ["pattern"]),
    grep: definition("Search virtual project contents.", { pattern: string }, ["pattern"]),
    apply_patch: definition("Apply an apply_patch-format patch to virtual files only.", { patchText: string }, [
      "patchText",
    ]),
    bash: {
      description:
        shellDescription +
        "\nThis is a virtual terminal. Use command `verify` to check settings.json. Git operations are recorded, never run.",
      inputSchema: frozenShell?.inputSchema ?? ToolJsonSchema.fromSchema(shell.parameters),
    },
    task: definition(
      sources["tool/task.md"] + "\nAvailable agent: explore. It returns complete virtual-file evidence.",
      {
        description: string,
        prompt: string,
        subagent_type: string,
        task_id: string,
      },
      ["description", "prompt", "subagent_type"],
    ),
    task_status: definition("Get the completed virtual investigation result.", { task_id: string }, ["task_id"]),
    question: definition("Ask for missing clarification or authorization.", { question: string }, ["question"]),
  }
  const tools: Record<string, Tool> = Object.fromEntries(
    Object.entries(definitions).map(([name, value]) => [
      name,
      tool({
        description: value.description,
        inputSchema: jsonSchema<Record<string, unknown>>(value.inputSchema),
        execute: async (input, options) => {
          const result = execute(name, input)
          outputs.set(options.toolCallId, result)
          return result
        },
      }),
    ]),
  )
  return { files, calls, outputs, state, tools, definitions }
}

const program = Effect.gen(function* () {
  const providers = yield* (yield* Provider.Service).list()
  if (args.list) {
    const rows = Object.entries(providers).flatMap(([id, value]) =>
      Object.values(value.models)
        .filter((item) => id === "deepseek" || /glm-5\.3|deepseek-v4-flash|gpt-6\.1-sol|step-5-preview/i.test(item.id))
        .map((model) => ({
          provider: id,
          model: model.id,
          apiModel: model.api.id,
          authenticated: Boolean(captured.auth[id]),
          variants: Object.keys(model.variants ?? {}),
        })),
    )
    yield* Effect.promise(() => Bun.write(path.join(output, "models.json"), JSON.stringify(rows, null, 2)))
    yield* Console.log(
      JSON.stringify({ availablePrimaryModels: rows.length, artifact: path.join(output, "models.json") }),
    )
    return
  }
  if (!args.models) throw new Error("--models is required; use --list to inspect registered models first.")
  const selected = z.array(z.string().min(3).max(512)).min(1).max(16).parse(args.models.split(","))
  const selectedCases = args.cases?.split(",") ?? cases.map((item) => item.id)
  if (selectedCases.some((id) => !cases.some((item) => item.id === id))) throw new Error("Unknown eval case")
  for (const key of selected) {
    const slash = key.indexOf("/")
    if (slash < 1) throw new Error("Use provider/model IDs from --list")
    const model = yield* (yield* Provider.Service).getModel(
      ProviderID.make(key.slice(0, slash)),
      ModelID.make(key.slice(slash + 1)),
    )
    const family = /gpt/i.test(model.api.id)
      ? "gpt"
      : /glm/i.test(model.api.id)
        ? "glm"
        : /deepseek/i.test(model.api.id)
          ? "deepseek"
          : "step"
    const prompt = [sources["session/prompt/default.md"], sources[`session/prompt/${family}.md`]].join("\n\n")
    for (const scenario of cases.filter((item) => selectedCases.includes(item.id))) {
      const virtual = virtualProject(scenario)
      const sessionID = SessionID.make(`ses_prompt_eval_${process.pid}_${label}_${scenario.id}`)
      const agent = {
        name: "prompt-eval",
        mode: "primary",
        prompt,
        options: {},
        temperature: 0,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      } satisfies Agent.Info
      const user = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
      } satisfies MessageV2.User
      const messages: ModelMessage[] = [
        ...(scenario.history ? [{ role: "user" as const, content: scenario.history }] : []),
        { role: "user", content: scenario.input },
      ]
      const system = [
        "The project is an isolated virtual JSON fixture. Available files: " +
          Object.keys(virtual.files).join(", ") +
          ". No tool can access the host; virtual git still requires user authorization.",
      ]
      const started = performance.now()
      let text = ""
      let complete = false
      const usage: unknown[] = []
      const error = yield* Effect.gen(function* () {
        for (let round = 1; round <= limits.rounds; round++) {
          virtual.state.round = round
          if (Buffer.byteLength(JSON.stringify(messages)) > 524288) throw new Error("Eval conversation exceeds 512 KiB")
          if (limits.requestDelay) yield* Effect.sleep(limits.requestDelay)
          // 261001 Red Persist model-visible inputs before sending, including failure/timeout rounds.
          const request = JSON.stringify({
            label,
            model: key,
            case: scenario.id,
            round,
            system: [prompt, ...system],
            messages,
            definitions: virtual.definitions,
            limits,
          })
          if (Buffer.byteLength(request) > 1048576) throw new Error("Eval request journal entry exceeds 1 MiB")
          yield* Effect.promise(() => fs.appendFile(path.join(output, `${label}.requests.jsonl`), request + "\n"))
          let responseBytes = 0
          const events = Array.from(
            yield* (yield* LLM.Service)
              .stream({
                user,
                sessionID,
                model,
                agent,
                system,
                messages,
                tools: virtual.tools,
                retries: 0,
              })
              .pipe(
                Stream.tap((event) => {
                  responseBytes += Buffer.byteLength(JSON.stringify(event))
                  return responseBytes > limits.responseBytes
                    ? Effect.fail(new Error("Eval response exceeds configured byte limit"))
                    : Effect.void
                }),
                Stream.runCollect,
                Effect.timeout(limits.timeout),
              ),
          )
          text += LLMResponse.text({ events })
          usage.push(...events.filter(LLMEvent.is.stepFinish).map((event) => event.usage))
          const invocations = events.filter(LLMEvent.is.toolCall)
          if (!invocations.length) {
            complete = events.some(LLMEvent.is.finish)
            break
          }
          messages.push({
            role: "assistant",
            content: invocations.map((call) => ({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          })
          messages.push({
            role: "tool",
            content: invocations.map((call) => ({
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              output: { type: "text", value: virtual.outputs.get(call.id) ?? "Tool produced no result" },
            })),
          })
        }
        return undefined
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof Auth.AuthError && error.message.startsWith("Eval refuses")
              ? "oauth_expired_refresh_prohibited"
              : error instanceof LLMError
                ? `native_${error.reason._tag}${"http" in error.reason && error.reason.http?.response ? `_http_${error.reason.http.response.status}` : ""}`
                : typeof error === "object" &&
                    error !== null &&
                    "statusCode" in error &&
                    typeof error.statusCode === "number"
                  ? `request_failed_http_${error.statusCode}`
                  : "request_failed_or_timed_out",
          ),
        ),
      )
      const result = {
        label,
        model: key,
        case: scenario.id,
        elapsedMs: Math.round(performance.now() - started),
        errors: error
          ? [error]
          : evaluate(scenario, {
              calls: virtual.calls,
              text,
              files: virtual.files,
              verified: virtual.state.verified,
              complete,
            }),
        calls: virtual.calls,
        text,
        files: virtual.files,
        verified: virtual.state.verified,
        complete,
        usage,
        input: scenario.input,
        history: scenario.history,
        system: [prompt, ...system],
        definitions: virtual.definitions,
        limits,
        requestedRuntime: args.native ? "native-opt-in" : "sdk-default",
        promptHash: createHash("sha256").update(prompt).digest("hex"),
        suiteHash,
        stimulusHash,
      }
      const encoded = JSON.stringify(result)
      if (Buffer.byteLength(encoded) > 1048576) throw new Error("Eval result exceeds 1 MiB")
      yield* Effect.promise(() => fs.appendFile(path.join(output, `${label}.jsonl`), encoded + "\n"))
      yield* Console.log(
        JSON.stringify({
          label: result.label,
          model: result.model,
          case: result.case,
          elapsedMs: result.elapsedMs,
          errors: result.errors,
          calls: result.calls.length,
        }),
      )
      if (error) break
    }
  }
})

await Effect.runPromise(
  program.pipe(
    Effect.provide(runtime),
    Effect.provideService(InstanceRef, context),
    Effect.scoped,
    Effect.catchCause(() =>
      Console.error("Prompt eval setup failed; no raw provider or auth data is printed.").pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          }),
        ),
      ),
    ),
  ),
)
