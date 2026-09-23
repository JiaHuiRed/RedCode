import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Freeform } from "@/tool/freeform"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID, SessionID } from "./schema"
import * as Log from "@redcode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { Goal } from "./goal"
import { capabilityDeniedForSet, capabilitySet, profileCapabilitySet } from "@/tool/capability"
import type { ChildTaskRecord } from "@/tool/task-runtime"
import { Storage } from "@/storage/storage"

const log = Log.create({ service: "session.tools" })

// 260918 Red MCP 附件闸门。此前这里是全仓唯一一条第三方服务器可以把无界字节塞进
// attachments 的路径：`result.content` 循环里 image / resource.blob 直接拼成 data: URL
// 就入列，既无字节线也无条数线，而 truncate.output 只作用于 textParts。
//
// 两条线对齐 tool/read.ts 的既有语义（260904 那批立的闸门）：
//   · 单条 5MB base64 —— 与 read.ts 的 MAX_PDF_BASE64_BYTES 同源。processor.ts 的
//     tool-result 分支只对 `image/*` 跑 Image.normalize（内部同一条 5MB 输入线 + 像素
//     预算 + 质量阶梯），**非图片 mime 原样透传给模型**，所以这条线画在这里才盖得住
//     PDF / octet-stream 这类绕开缩放器的附件。
//   · 条数 32 —— 上游没有可比对象，取宽松值：单条 5MB 已属极大，32 条远超任何模型的
//     上下文预算，先挡「一次带回几百个附件」的突发。
//
// 超限不报错（与 read.ts 同）：附件不内联，output 说明情况，模型可以换别的方式取。
const MAX_ATTACHMENT_BASE64_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENTS = 32

// 260920 Red Explore capability 的权威来源是 TaskTool 写下的 canonical record。
// Storage 不可见或 record 缺失时退回 profile 白名单（explore 仅 read/search）——
// 上限相同、不扩大权限，也不会因为一次读盘失败把子代理整个锁死。
const exploreCapabilities = Effect.fn("SessionTools.exploreCapabilities")(function* (sessionID: SessionID) {
  const fallback = capabilitySet(profileCapabilitySet("explore"))
  const storage = yield* Effect.serviceOption(Storage.Service)
  if (Option.isNone(storage)) return fallback
  return yield* storage.value
    .read<ChildTaskRecord>(["task-runtime", String(sessionID)])
    .pipe(
      Effect.map((record) => capabilitySet(record.capabilities)),
      Effect.catch(() => Effect.succeed(fallback)),
    )
})

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
  goal: Goal.Interface
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const childCapabilities =
    input.agent.name === "explore" ? yield* exploreCapabilities(input.session.id) : undefined

  const context = (
    name: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions<Record<string, unknown>>,
  ): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      goal: input.goal,
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, name, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    // 260902 cc GPT-5 系走 Responses custom tool：入参是裸字符串而不是对象，见 tool/freeform.ts。
    const freeform = Freeform.spec(input.model, item.id)
    const execute = (rawArgs: any, options: ToolExecutionOptions<Record<string, unknown>>) => {
      let args = Freeform.normalizeInput(item.id, rawArgs) ?? (rawArgs as Record<string, unknown>)
      return run.promise(
        Effect.gen(function* () {
          // 260811 cc audit Y5：返回值此前被丢弃，插件 SDK 承诺的 output.args 改写
          // （整体赋值写法）完全无效，只有原地 mutate 碰巧生效。接住返回值让两种写法都成立。
          const beforeHook = yield* plugin.trigger(
            "tool.execute.before",
            { tool: item.id, sessionID: input.session.id, callID: options.toolCallId },
            { args },
          )
          args = beforeHook.args
          // 260920 Red policy must inspect the final arguments after plugin rewriting.
          const ctx = context(item.id, args, options)
          const preToolUse = yield* plugin.trigger(
            "tool.use.pre",
            { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
            { denied: false as boolean, reason: undefined as string | undefined },
          )
          if (preToolUse.denied) {
            return {
              title: "Blocked",
              output: `Tool "${item.id}" was blocked by hook.${preToolUse.reason ? ` Reason: ${preToolUse.reason}` : ""}`,
              metadata: { blocked: true },
            } as any
          }
          const capabilityReason = childCapabilities
            ? capabilityDeniedForSet(childCapabilities, item.id)
            : undefined
          if (capabilityReason) {
            return {
              title: "Blocked",
              output: capabilityReason,
              metadata: { blocked: true, capability: "child-record" },
            } as any
          }
          const result = yield* item.execute(args, ctx).pipe(
            Effect.tapError((error) =>
              plugin
                .trigger(
                  "tool.execute.failure",
                  {
                    tool: item.id,
                    sessionID: ctx.sessionID,
                    callID: ctx.callID,
                    args,
                    error: String(error),
                  },
                  {},
                )
                .pipe(Effect.catch(() => Effect.void)),
            ),
          )
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
            output,
          )
          if (options.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(options.toolCallId, output)
          }
          return output
        }),
      )
    }
    tools[item.id] = freeform
      ? // AI SDK 里 provider 工具就是这个形状：type/id/args 原样交给 @ai-sdk/openai 的
        // `openai.custom` 分支拼成 {type:"custom", name, format}，name 取 tools 的键。
        // 带 execute 的工具一律由客户端执行（ai@7 只跳过 providerExecuted 的），
        // 所以执行器还是本仓这套，只有工具定义和入参形状换了。
        ({
          type: "provider",
          id: "openai.custom",
          args: {
            name: item.id,
            description: [item.description, freeform.note].join("\n\n"),
            format: { type: "grammar", syntax: "lark", definition: freeform.grammar },
          },
          inputSchema: jsonSchema({ type: "string" }),
          execute,
        } as unknown as AITool)
      : tool({
          description: item.description,
          inputSchema: jsonSchema(schema),
          execute,
        })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) => {
      return run.promise(
        Effect.gen(function* () {
          // 260811 cc audit Y5：同上，MCP 路径的 args 改写同样要接住返回值
          const beforeHook = yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: input.session.id, callID: opts.toolCallId },
            { args },
          )
          args = beforeHook.args
          // 260920 Red policy must inspect the final arguments after plugin rewriting.
          const ctx = context(key, args, opts)
          const preToolUse = yield* plugin.trigger(
            "tool.use.pre",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            { denied: false as boolean, reason: undefined as string | undefined },
          )
          if (preToolUse.denied) {
            return {
              title: "Blocked",
              output: `Tool "${key}" was blocked by hook.${preToolUse.reason ? ` Reason: ${preToolUse.reason}` : ""}`,
              metadata: { blocked: true },
              content: [],
            } as any
          }
          const capabilityReason = childCapabilities ? capabilityDeniedForSet(childCapabilities, key) : undefined
          if (capabilityReason) {
            return {
              title: "Blocked",
              output: capabilityReason,
              metadata: { blocked: true, capability: "child-record" },
              content: [],
            } as any
          }
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
            Effect.tapError((error) =>
              plugin
                .trigger(
                  "tool.execute.failure",
                  {
                    tool: key,
                    sessionID: ctx.sessionID,
                    callID: opts.toolCallId,
                    args,
                    error: String(error),
                  },
                  {},
                )
                .pipe(Effect.catch(() => Effect.void)),
            ),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          let droppedAttachments = 0
          const acceptAttachment = (base64Bytes: number) =>
            base64Bytes <= MAX_ATTACHMENT_BASE64_BYTES && attachments.length < MAX_ATTACHMENTS
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              if (!acceptAttachment(contentItem.data.length)) {
                droppedAttachments++
                continue
              }
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                if (!acceptAttachment(resource.blob.length)) {
                  droppedAttachments++
                  continue
                }
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const fitted = yield* truncate.result(
            { output: textParts.join("\n\n"), attachments },
            { model: ctx.extra?.model as { providerID: string } | undefined },
            input.agent,
          )
          const metadata = {
            ...result.metadata,
            truncated: fitted.metadata.truncated,
            ...(fitted.metadata.outputPath && { outputPath: fitted.metadata.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: droppedAttachments
              ? `${fitted.output}\n\n[${droppedAttachments} attachment${droppedAttachments === 1 ? "" : "s"} dropped: over the ${MAX_ATTACHMENTS}-attachment limit or the ${MAX_ATTACHMENT_BASE64_BYTES / (1024 * 1024)} MB single-attachment budget. The tool result was left unchanged.]`
              : fitted.output,
            // fitToolResult 原样保留附件对象引用（只筛掉一部分），type: "file" 还在
            attachments: ((fitted.attachments ?? attachments) as typeof attachments).map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    }
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
