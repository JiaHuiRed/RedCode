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
import { ImageTokens } from "./image-tokens"

const log = Log.create({ service: "session.tools" })

// 261006 Red MCP resource tools 常量（移植上游）。MIME 白名单 = 模型可消费的附件类型
// （processor 的 tool-result 分支只对 image/* 缩放，PDF 原样透传）；大小/条数限额不走
// 上游的 10MB 常量，统一用 ImageTokens（5MB/32 条，与 MCP 工具循环、tool/read 同源）。
const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MCP_RESOURCE_ATTACHMENT_MIMES = new Set(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"])

// 260918 Red MCP 入口闸门，避免构造 data: URL 前就把无界内容放进内存；
// ImageTokens.fitToolResult 还会在所有工具的共同出口再次执行同样的限制。
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
// 260920 Red Explore capability 的权威来源是 TaskTool 写下的 canonical record。
// Storage 不可见或 record 缺失时退回 profile 白名单（explore 仅 read/search）——
// 上限相同、不扩大权限，也不会因为一次读盘失败把子代理整个锁死。
const exploreCapabilities = Effect.fn("SessionTools.exploreCapabilities")(function* (sessionID: SessionID) {
  const fallback = capabilitySet(profileCapabilitySet("explore"))
  const storage = yield* Effect.serviceOption(Storage.Service)
  if (Option.isNone(storage)) return fallback
  return yield* storage.value.read<ChildTaskRecord>(["task-runtime", String(sessionID)]).pipe(
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
  const childCapabilities = input.agent.name === "explore" ? yield* exploreCapabilities(input.session.id) : undefined

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
          const capabilityReason = childCapabilities ? capabilityDeniedForSet(childCapabilities, item.id) : undefined
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

  // 261006 Red 移植上游 MCP resource tools：resources 是 MCP 协议里 tool calling 之外的
  // 另一半数据通道（文件/schema/应用信息）。底层 clients/resources/resourceTemplates/
  // readResource 早已在 mcp/index.ts（260610 #31612 超时、260624 listing），这里只补
  // 工具装配。执行闸门与下方 MCP 工具循环一致（before/pre 钩子 + explore capability）。
  const mcpClients = yield* mcp.clients()
  if (Object.values(mcpClients).some((client) => !!client.getServerCapabilities()?.resources)) {
    const resourceServers = Object.entries(mcpClients)
      .filter(([, client]) => !!client.getServerCapabilities()?.resources)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b))

    // 公共闸门：args 改写 → pre 钩子 → explore capability → read permission。
    // blocked 时 output 已是最终工具结果，调用方直接 return。
    // 261006 Red permission pattern 经 authorize 回调基于**改写后**的 args 计算：
    // 此前调用方在闸门外用原始 args 解析 server/uri，before hook 的改写只流进事件流，
    // client 查找、permission pattern 与 readResource 仍按改写前的值执行——
    // observability 显示改写成功而执行行为没变。现在闸门先产出最终 args，
    // 调用方一律从 gate.args 重新解析，parsed 与 permission pattern 同源。
    const resourceGate = Effect.fn("SessionTools.mcpResourceGate")(function* (
      name: string,
      rawArgs: Record<string, unknown>,
      opts: ToolExecutionOptions<Record<string, unknown>>,
      authorize: (rewritten: Record<string, unknown>) => {
        metadata: Record<string, unknown>
        patterns: string[]
        always: string[]
      },
    ) {
      const beforeHook = yield* plugin.trigger(
        "tool.execute.before",
        { tool: name, sessionID: input.session.id, callID: opts.toolCallId },
        { args: rawArgs },
      )
      const args = beforeHook.args
      const ctx = context(name, args, opts)
      const preToolUse = yield* plugin.trigger(
        "tool.use.pre",
        { tool: name, sessionID: ctx.sessionID, callID: ctx.callID, args },
        { denied: false as boolean, reason: undefined as string | undefined },
      )
      if (preToolUse.denied) {
        return {
          blocked: true as const,
          output: {
            title: "Blocked",
            output: `Tool "${name}" was blocked by hook.${preToolUse.reason ? ` Reason: ${preToolUse.reason}` : ""}`,
            metadata: { blocked: true },
          },
        }
      }
      const capabilityReason = childCapabilities ? capabilityDeniedForSet(childCapabilities, name) : undefined
      if (capabilityReason) {
        return {
          blocked: true as const,
          output: {
            title: "Blocked",
            output: capabilityReason,
            metadata: { blocked: true, capability: "child-record" },
          },
        }
      }
      yield* ctx.ask({ permission: "read", ...authorize(args) })
      return { blocked: false as const, ctx, args }
    })

    // list / listTemplates 同形状：列出（指定 server 时 mcp 层只访问该 server，否则
    // 并发收集全部 connected server，条目带 client 字段）→ 过滤兜底 → 排序 → JSON 输出。
    const listTool = <T extends { client: string; name: string }>(
      name: string,
      description: string,
      label: string,
      list: (server?: string) => Effect.Effect<Record<string, T>>,
      format: (item: T) => Record<string, unknown>,
    ) =>
      tool({
        description,
        inputSchema: jsonSchema(
          ProviderTransform.schema(input.model, {
            type: "object",
            properties: {
              server: {
                type: "string",
                description: `Optional MCP server name. When omitted, lists ${label} from every connected server.`,
              },
            },
            additionalProperties: false,
          }),
        ),
        execute(args: unknown, opts: ToolExecutionOptions<Record<string, unknown>>) {
          return run.promise(
            Effect.gen(function* () {
              const gate = yield* resourceGate(name, toMcpRecord(args), opts, (rewritten) => {
                const parsed = parseMcpResourceListArgs(rewritten)
                const patterns = parsed.server
                  ? [`mcp:${parsed.server}:*`]
                  : resourceServers.map((server) => `mcp:${server}:*`)
                return { metadata: parsed.server ? { server: parsed.server } : {}, patterns, always: patterns }
              })
              if (gate.blocked) return gate.output
              // 261006 Red unknown server 校验同样基于改写后的最终 args
              const parsed = parseMcpResourceListArgs(gate.args)
              if (parsed.server && !resourceServers.includes(parsed.server))
                throw new Error(
                  resourceServers.length === 0
                    ? `MCP server "${parsed.server}" does not support resources`
                    : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
                )
              // 261006 Red server-scoped：指定 server 时只访问该 server，不再全量
              // 扇出后过滤；不过滤是兜底（防异常 server 把别家条目塞进响应）。
              const entries = Object.values(yield* list(parsed.server)).filter(
                (item) => !parsed.server || item.client === parsed.server,
              )
              entries.sort((a, b) => (a.client + "\u0000" + a.name).localeCompare(b.client + "\u0000" + b.name))
              const formatted = entries.map((item) => format(item))
              const fitted = yield* truncate.result(
                { output: JSON.stringify({ [label]: formatted }, null, 2) },
                { model: gate.ctx.extra?.model as { providerID: string } | undefined },
                input.agent,
              )
              const output = {
                title: parsed.server ? `MCP ${label}: ${parsed.server}` : `MCP ${label}`,
                metadata: {
                  count: entries.length,
                  servers: resourceServers,
                  ...(parsed.server ? { server: parsed.server } : {}),
                  truncated: fitted.metadata.truncated,
                  ...(fitted.metadata.outputPath && { outputPath: fitted.metadata.outputPath }),
                },
                output: fitted.output,
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: name, sessionID: gate.ctx.sessionID, callID: gate.ctx.callID, args: gate.args },
                output,
              )
              if (opts.abortSignal?.aborted) yield* input.processor.completeToolCall(opts.toolCallId, output)
              return output
            }),
          )
        },
      })

    tools[MCP_RESOURCE_TOOLS.list] = listTool(
      MCP_RESOURCE_TOOLS.list,
      "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      "resources",
      (server?: string) => mcp.resources(server),
      formatMcpResource,
    )
    tools[MCP_RESOURCE_TOOLS.listTemplates] = listTool(
      MCP_RESOURCE_TOOLS.listTemplates,
      "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      "resourceTemplates",
      (server?: string) => mcp.resourceTemplates(server),
      formatMcpResourceTemplate,
    )

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: { type: "string", description: "MCP server name exactly as returned by list_mcp_resources." },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args: unknown, opts: ToolExecutionOptions<Record<string, unknown>>) {
        return run.promise(
          Effect.gen(function* () {
            // 261006 Red parsed 永远基于 before hook 改写后的最终 args：client 查找、
            // capability 校验与 readResource 必须和 permission pattern 同源。
            const gate = yield* resourceGate(MCP_RESOURCE_TOOLS.read, toMcpRecord(args), opts, (rewritten) => {
              const parsed = parseMcpResourceReadArgs(rewritten)
              return {
                metadata: { server: parsed.server, uri: parsed.uri },
                patterns: [`mcp:${parsed.server}:${parsed.uri}`],
                always: [`mcp:${parsed.server}:*`],
              }
            })
            if (gate.blocked) return gate.output
            const parsed = parseMcpResourceReadArgs(gate.args)
            const client = mcpClients[parsed.server]
            if (!client) throw new Error(`MCP server "${parsed.server}" is not connected`)
            if (!client.getServerCapabilities()?.resources)
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)
            const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
            const formatted = formatMcpResourceContent(
              parsed.server,
              parsed.uri,
              content,
             (_mime, size) =>
               size <= ImageTokens.MAX_ATTACHMENT_BASE64_BYTES &&
               attachments.length < ImageTokens.MAX_ATTACHMENTS,
              attachments,
            )
            const fitted = yield* truncate.result(
              { output: formatted.text, attachments },
              { model: gate.ctx.extra?.model as { providerID: string } | undefined },
              input.agent,
            )
            // 261006 Red metadata 的附件数以 fit 后实际发送的为准：此前用
            // formatted.attachments（fit 前候选数），fitToolResult 按 token 预算
            // 丢附件时观测计数与真实模型输入不一致。
            const outputAttachments = ((fitted.attachments ?? attachments) as typeof attachments).map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: gate.ctx.sessionID,
              messageID: input.processor.message.id,
            }))
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: outputAttachments.length,
                truncated: fitted.metadata.truncated,
                ...(fitted.metadata.outputPath && { outputPath: fitted.metadata.outputPath }),
              },
              output: fitted.output,
              attachments: outputAttachments,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              {
                tool: MCP_RESOURCE_TOOLS.read,
                sessionID: gate.ctx.sessionID,
                callID: gate.ctx.callID,
                args: gate.args,
              },
              output,
            )
            if (opts.abortSignal?.aborted) yield* input.processor.completeToolCall(opts.toolCallId, output)
            return output
          }),
        )
      },
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
            base64Bytes <= ImageTokens.MAX_ATTACHMENT_BASE64_BYTES && attachments.length < ImageTokens.MAX_ATTACHMENTS
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
              ? `${fitted.output}\n\n[${droppedAttachments} attachment${droppedAttachments === 1 ? "" : "s"} dropped: over the ${ImageTokens.MAX_ATTACHMENTS}-attachment limit or the ${ImageTokens.MAX_ATTACHMENT_BASE64_BYTES / (1024 * 1024)} MB single-attachment budget. The tool result was left unchanged.]`
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

function toMcpRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function optionalMcpString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredMcpString(args: Record<string, unknown>, key: string) {
  const value = optionalMcpString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function parseMcpResourceListArgs(value: unknown) {
  return { server: optionalMcpString(toMcpRecord(value), "server") }
}

function parseMcpResourceReadArgs(value: unknown) {
  const args = toMcpRecord(value)
  return { server: requiredMcpString(args, "server"), uri: requiredMcpString(args, "uri") }
}

// 261006 Red client 字段对模型暴露时改名 server（与上游一致：模型 schema 里只有 server 概念）。
function formatMcpResource(item: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(item).filter((entry) => entry[0] !== "client"))
  return { ...result, server: item.client }
}

function formatMcpResourceTemplate(item: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(item).filter((entry) => entry[0] !== "client"))
  return { ...result, server: item.client }
}

/**
 * 261006 Red 把 readResource 结果格式化成模型可读文本 + 附件。blob 附件的类型看
 * MCP_RESOURCE_ATTACHMENT_MIMES，大小/条数由 accept 回调判定（ImageTokens 闸门），
 * 拒收不报错：文本里说明情况，模型可以换方式取（与 tool/read、MCP 工具循环同语义）。
 */
function formatMcpResourceContent(
  server: string,
  uri: string,
  content: { contents: unknown },
  accept: (mime: string, base64Bytes: number) => boolean,
  attachments: { type: "file"; mime: string; url: string; filename?: string }[],
) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  )
  const text: string[] = []
  let attached = 0
  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      // 261006 Red 数 base64 串自身字节（与 data URL payload 同口径），不再按
      // 解码后大小判定：常量名叫 MAX_ATTACHMENT_BASE64_BYTES，read.ts 与 MCP
      // 工具循环量的都是 base64 串，这里曾是全仓唯一的解码口径。
      const size = item.blob.length
      if (!MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${mcpFormatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (!accept(mime, size)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${mcpFormatBytes(size)}) exceeds the attachment size/count budget]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attached++
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }
  return {
    contents: items.length,
    attachments: attached,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function mcpFormatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
