import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

/**
 * 声明式展示数据。只允许纯数据：客户端按 type 渲染，不认识的一律退回 output 文本，
 * 不接受 HTML、函数或任意脚本。summary 放工具行副标题，sections 进折叠区。
 */
export type ToolViewSection =
  | { type: "text"; title?: string; text: string }
  | { type: "items"; title?: string; items: Array<{ label: string; value: string }> }

export type ToolView = {
  summary?: string
  sections?: ToolViewSection[]
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
      /** 可选展示协议；序列化超过 8KB 会被宿主丢弃并退回 output。 */
      view?: ToolView
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
