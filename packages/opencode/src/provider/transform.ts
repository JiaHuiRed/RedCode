import type { ModelMessage, ToolResultPart } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type * as Provider from "./provider"
import type * as ModelsDev from "@redcode-ai/core/models-dev"
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { join } from "path"
import { tmpdir } from "os"
import { iife } from "@/util/iife"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000
// 260710 Red MiMo 模型支持超长输出（MiMo-V2.5 等），给予更高上限
export const MIMO_OUTPUT_TOKEN_MAX = 100_000
// 260801 Red DeepSeek V4 Flash 思考链长（max 档 311 avg，长尾远超），正文被 32K 共享预算挤断
// max_tokens 覆盖 reasoning_content + content 总和；模型自身 output 384K，提到 64K 防截断
// 260803 Red 上限调回 50K 试跑：截断由 llm.ts 续写机制兜底，输出 token 成本随之下降
export const DEEPSEEK_V4_FLASH_OUTPUT_TOKEN_MAX = 50_000

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
    case "ai-gateway-provider":
      // ai-gateway-provider/unified wraps createOpenAICompatible({ name: "Unified" }),
      // and @ai-sdk/openai-compatible parses compatibleOptions from one of
      // "openai-compatible" / "openaiCompatible" / "Unified" / "unified". The
      // "openai-compatible" key emits a deprecation warning at runtime, so we
      // pick the camelCase form the SDK now treats as canonical.
      return "openaiCompatible"
  }
  return undefined
}

// TODO: fix this stupid inefficient dogshit function
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  const sanitizeToolResultOutput = (content: ToolResultPart) => {
    if (content.output.type === "text" || content.output.type === "error-text") {
      content.output.value = sanitizeSurrogates(content.output.value)
    }
    if (content.output.type === "content") {
      content.output.value = content.output.value.map((item) => {
        if (item.type === "text") {
          item.text = sanitizeSurrogates(item.text)
        }
        return item
      })
    }
    return content
  }

  msgs = msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })

  // 260701 Red 防御：压缩（DCP 插件的 compress / core compaction）可能切断 tool_call/tool_result
  // 配对，留下没有前置 tool_calls 的孤儿 tool 消息 → DeepSeek 等 provider 报
  // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"，
  // 会话直接断。孤儿会一直赖在历史里直到某次 collapse 才消失，不能靠碰运气。发送前扫描：丢弃
  // 无前置配对 tool_call 的 tool-result，整条 tool 消息若无剩余则删除。放在所有 provider 专用块
  // 之前，因为 deepseek/interleaved 分支会提前 return。
  // 注意：只处理"result 无 call"（哥哥实测的报错方向）；反向的"call 无 result"暂未观测到，未处理。
  {
    const seenCallIds = new Set<string>()
    msgs = msgs.flatMap((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "tool-call") seenCallIds.add(part.toolCallId)
        }
        return [msg]
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        const kept = msg.content.filter((part) => part.type !== "tool-result" || seenCallIds.has(part.toolCallId))
        if (kept.length === 0) return []
        msg.content = kept
        return [msg]
      }
      return [msg]
    })
  }

  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.anthropic?.signature != null ||
              part.providerOptions?.anthropic?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  // Bedrock specific transforms
  if (model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.bedrock?.signature != null ||
              part.providerOptions?.bedrock?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }
  if (["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
    // Anthropic rejects assistant turns where tool_use blocks are followed by non-tool
    // content, e.g. [tool_use, tool_use, text], with:
    // `tool_use` ids were found without `tool_result` blocks immediately after...
    //
    // Reorder that invalid shape into [text] + [tool_use, tool_use]. Consecutive
    // assistant messages are later merged by the provider/SDK, so preserving the
    // original [tool_use...] then [text] order still produces the invalid payload.
    //
    // The root cause appears to be somewhere upstream where the stream is originally
    // processed. We were unable to locate an exact narrower reproduction elsewhere,
    // so we keep this transform in place for the time being.
    msgs = msgs.flatMap((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg]

      const parts = msg.content
      const first = parts.findIndex((part) => part.type === "tool-call")
      if (first === -1) return [msg]
      if (!parts.slice(first).some((part) => part.type !== "tool-call")) return [msg]
      return [
        { ...msg, content: parts.filter((part) => part.type !== "tool-call") },
        { ...msg, content: parts.filter((part) => part.type === "tool-call") },
      ]
    })
  }
  if (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLowerCase().includes("devstral")
  ) {
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
        .substring(0, 9) // Take first 9 characters
        .padEnd(9, "0") // Pad with zeros if less than 9 characters
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg)

      // Fix message sequence: tool messages cannot be followed by user messages
      if (msg.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  // Deepseek requires all assistant messages to have reasoning on them
  if (model.api.id.toLowerCase().includes("deepseek")) {
    msgs = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg
      if (Array.isArray(msg.content)) {
        if (msg.content.some((part) => part.type === "reasoning")) return msg
        return { ...msg, content: [...msg.content, { type: "reasoning", text: "" }] }
      }
      return {
        ...msg,
        content: [
          ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
          { type: "reasoning" as const, text: "" },
        ],
      }
    })
  }

  if (
    typeof model.capabilities.interleaved === "object" &&
    model.capabilities.interleaved.field &&
    model.api.npm !== "@openrouter/ai-sdk-provider"
  ) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages.
        // Always set the field even when empty — some providers (e.g. DeepSeek) may return empty
        // reasoning_content which still needs to be sent back in subsequent requests.
        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...msg.providerOptions?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }

      return msg
    })
  }

  return msgs
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
}

/**
 * 拆开 AI SDK v7 给 file/image part 载荷加的那层包装。
 * v7: `{ type: "url", url: URL }`（data: URL 里带 base64）或 `{ data: <bytes> }`；
 * v4/v6: 直接就是 string / Uint8Array / ArrayBuffer，原样返回。
 */
function unwrapV7Payload(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer) return value
  if (typeof value !== "object") return value
  const v = value as Record<string, unknown>
  if (v.type === "url" && v.url != null) return String(v.url)
  if (v.data != null) return v.data
  return value
}

// vision 临时文件只写不删（同图同路径靠 existsSync 去重），temp 目录会缓慢堆积截图。
// 首次落盘时惰性清一次 7 天前的旧文件；正在活跃引用的文件必然是近期写入，不会误删。
let visionTempSwept = false
const VISION_TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000
function sweepVisionTemp() {
  if (visionTempSwept) return
  visionTempSwept = true
  try {
    const dir = tmpdir()
    const cutoff = Date.now() - VISION_TEMP_TTL_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("redcode-vision-")) continue
      const filepath = join(dir, name)
      try {
        if (statSync(filepath).mtimeMs < cutoff) unlinkSync(filepath)
      } catch {}
    }
  } catch {}
}

/** Save an unsupported media part to a temp file so a subagent can read it later. */
function savePartToTemp(part: unknown): string | null {
  const p = part as Record<string, unknown>

  // Extract MIME: ImagePart uses mimeType; FilePart uses mediaType
  const mime = p.type === "image"
    ? String(p.mimeType || "")
    : String(p.mediaType || "")
  const ext = MIME_EXT[mime] || "bin"

  // Extract raw data: FilePart uses "data" (AI SDK v4); ImagePart uses "image"
  //
  // 260808 Red：v7 把 file part 的载荷包了一层——实测形态是
  //   { type: "file", mediaType, filename, data: { type: "url", url: URL } }
  // 既没有顶层 `url` 字段，`data` 也不再是字符串/字节，而是个对象（URL 里才是
  // 那串 data:image/png;base64,…）。旧代码三个分支都不匹配，直接落到 `return null`：
  // 图片**根本没写进临时目录**，于是占位文本里没有 TEMP_FILE 路径，模型被告知
  // "去读下面那个路径"却看不到路径，只能自己去 prompt-history.jsonl 里刨 base64
  // 手动解码（实测发生过，慢且脆）。这里先把 v7 的包装拆开再走原有解码。
  const rawInput = p.type === "image" ? p.image : (p.data ?? p.url)
  const raw = unwrapV7Payload(rawInput)
  if (raw == null) return null

  let buffer: Buffer
  if (typeof raw === "string") {
    // String: data URL ("data:image/png;base64,...") or raw base64
    const m = raw.match(/^data:[^;]+;base64,(.*)$/)
    if (m) {
      buffer = Buffer.from(m[1], "base64")
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      // 远程 URL（http/https/file…）：这里是同步路径，不去网络取；交给下游按 URL 处理
      return null
    } else {
      buffer = Buffer.from(raw, "base64")
    }
  } else if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    buffer = Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw)
  } else {
    return null
  }

  if (buffer.length === 0) return null
  // 260804 Red 文件名必须由**内容**决定，不能用 Date.now()。
  //
  // 这个路径会原样进请求体：不支持图片的模型（如 deepseek-v4-flash）走 unsupportedParts()，
  // 历史里每张图都被换成 `ERROR: Cannot read … TEMP_FILE:<这个路径>` 的占位文本。用时间戳
  // 就意味着**同一张历史图片每一轮都生成不同的文本**，而它在消息列表里位置固定 ——
  // 于是从那条消息往后的所有内容每轮全部失配，provider 的前缀缓存被永久钉死在它前面。
  //
  // 线上实测（ses_035a2d2e3ffe / ses_0357643d8ffe，08-04）：相邻两次请求逐条比对，第一处
  // 差异恒定落在那条含图的 user 消息上，长度分毫不差、只有时间戳数字在变
  // （…-1785809543199.png → …-1785809578133.png）。表现是 read 钉死在某个值（97k/110k/114k
  // 就是那条消息之前的长度）、write 每轮重写、命中率线性下滑到 50% 左右，且不会自愈。
  // 能收图的模型（step-3.7-flash）不进这段代码，所以从来不复现 —— 这正是"切到 DeepSeek
  // 就开始掉"的真正原因，与 DCP、上下文大小、供应商都无关。
  //
  // 改用内容哈希后：同一张图恒定映射到同一路径，请求体逐字节稳定，缓存前缀得以延伸。
  // 顺带去掉了每轮往 temp 目录扔一个新文件的垃圾。
  sweepVisionTemp()
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 16)
  const filepath = join(tmpdir(), `redcode-vision-${digest}.${ext}`)
  try {
    // 已经落过盘就不重复写 —— 内容相同，路径也相同
    if (!existsSync(filepath)) writeFileSync(filepath, buffer)
    return filepath
  } catch {
    return null
  }
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image"
        ? (String((part as unknown as Record<string, unknown>).mimeType || ""))
        : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      const savedPath = savePartToTemp(part)
      // 260808 Red：文案必须跟着"有没有落盘成功"走。原来无条件写 "…at the path below"
      // 再拼一个可能为空的 pathHint —— 落盘失败时就成了"让我读下面的路径"但下面什么都没有，
      // 模型只能自己去 prompt-history.jsonl 里刨 base64 手动解码（实测发生过，慢且脆）。
      // 另：原文案是 "Use vision_analyze_image tool."，而 vision MCP 已于 96c7da9 整体退役，
      // 指的是个不存在的工具；现统一指向多模态子代理，与 prompt.ts 的权威注入口径一致。
      const instruction = savedPath
        ? `Dispatch a multimodal subagent (task tool, \`explore\` agent) and have it read this file: ${savedPath}`
        : `Ask the user to re-send it as a file path, or switch to a model with ${modality} input — the attachment could not be written to disk, so there is no path to read.`
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). ${instruction}`,
      }
    })

    return { ...msg, content: filtered }
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  if (
    (model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/alibaba") &&
    model.api.npm !== "@ai-sdk/gateway"
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
            return { ...part }
          }
          return { ...part, providerOptions: remap(part.providerOptions) }
        }),
      } as typeof msg
    })
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  // 260806 Red 对齐 DeepSeek 官方 V4-Flash-0731 公告里跑基准所用的采样配置
  // （max 档 + temperature=1.0 + top_p=0.95）。温度刻意不写：DeepSeek 服务端默认就是 1.0，
  // 显式重复一遍只会多带一个参数，官方哪天调默认反而跟不上；差异只在 top_p（默认 1.0）。
  if (isDeepSeekV4FlashModel(model)) return 0.95
  return undefined
}

export function topK(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]

// 260729 Red GLM 的思考控制分两代（依据智谱官方「核心参数说明」）：
//   · thinking.type —— GLM-4.5 及以上都有，二值 enabled/disabled，默认 enabled
//   · reasoning_effort —— **仅 GLM-5.2 及以上支持**
// 且 5.2 的 7 个取值里有一半是别名：none/minimal 都是放弃思考，low/medium 都映射成 high，
// xhigh 映射成 max。全摆出来是骗人的——用户选了 low 实际吃到的是 high。只暴露三档真实行为。
// max 是官方默认值，所以不选任何变体时的行为就等于 max。
const GLM_EFFORTS = ["none", "high", "max"]

// grok-4.5（xAI 官方文档）：reasoning_effort 取值 low/medium/high，默认 high，**无法禁用推理**，
// 所以不给 none 档。另注：该文档说 presence_penalty / frequency_penalty / stop 不能与推理模型
// 同用，否则整个请求报错 —— RedCode 目前不发这三个参数（只有 schema 定义和协议层映射，
// 没有赋值点），若将来有人加上，grok 会第一个炸。
const GROK_EFFORTS = WIDELY_SUPPORTED_EFFORTS
// kimi-k3（Moonshot 官方文档）：始终开启思考，reasoning_effort 取值 low/high/max，默认 max。
// 注意档位集合与 grok 不同（有 max、无 medium），别图省事共用一张表。
const KIMI_K3_EFFORTS = ["low", "high", "max"]

const GLM_RE = /glm-(\d+)(?:\.(\d+))?/
const GROK_RE = /grok-(\d+)(?:\.(\d+))?/
const KIMI_RE = /kimi-k(\d+)(?:\.(\d+))?/

/** 从模型 id 里解出版本号（major.minor 记作 major + minor/100）；认不出来返回 undefined */
function modelVersion(re: RegExp, ...ids: (string | undefined)[]): number | undefined {
  for (const raw of ids) {
    const m = raw?.toLowerCase().match(re)
    if (m) return Number(m[1]) + Number(m[2] ?? 0) / 100
  }
  return undefined
}

const glmVersion = (...ids: (string | undefined)[]) => modelVersion(GLM_RE, ...ids)

/** GLM-5.2 及以上才支持 reasoning_effort。注意 glm-5-turbo / glm-5v-turbo 都是 5.0，不算。 */
function glmSupportsEffort(...ids: (string | undefined)[]): boolean {
  const v = glmVersion(...ids)
  return v !== undefined && v >= 5.02
}

const effortVariants = (efforts: string[]) =>
  Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))

// 260814 Red 推理档位数据驱动（决策：数据打底、硬编码表覆盖）。
// models.dev 的 reasoning_options 只在 variants() 里"通用猜测"的兜底路径上生效：
// openai-compatible 系尾部的 WIDELY_SUPPORTED_EFFORTS 猜测、未知 npm 的空表。
// 所有实测校准的特判（GLM/KIMI/GROK/DeepSeek/排除名单）在此之前就已返回，
// 数据永远压不过它们——models.dev 错了有表兜着，新模型没进表时数据顶上。
//
// 只消化 effort 型（这些落点的参数形状全是 {reasoningEffort}，与档位值无关）；
// budget_tokens/toggle 型在这些 provider 上没有已知的参数形状，返回 undefined 退回硬编码。
// 字段是 Unknown 透传（外部数据形态会演化），所以逐层运行时收窄，认不出就放弃。
function dataEffortVariants(model: Provider.Model): Record<string, Record<string, any>> | undefined {
  const options = model.reasoningOptions
  if (!Array.isArray(options)) return undefined
  const effort = options.find(
    (o) => typeof o === "object" && o !== null && !Array.isArray(o) && (o as Record<string, unknown>).type === "effort",
  ) as { values?: unknown } | undefined
  const values = effort?.values
  if (!Array.isArray(values)) return undefined
  const efforts = values.flatMap((v) => {
    if (v === null) return ["none"]
    if (typeof v === "string" && v.length > 0) return [v]
    return []
  })
  if (efforts.length === 0) return undefined
  return effortVariants([...new Set(efforts)])
}
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

// Computes the reasoning_effort tiers an OpenAI (or OpenAI-compatible upstream
// routed through it, e.g. cf-ai-gateway) model exposes. Effort order: weakest
// to strongest.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes("deep-research")) return ["medium"]
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  // GPT-5.1 replaced GPT-5's `minimal` effort with `none`; GPT-5.2+
  // additionally accepts `xhigh`. Model pages list the supported subset.
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
  return efforts
}

function openaiCompatibleReasoningEfforts(id: string) {
  const apiId = id.toLowerCase()
  const chatEfforts = gpt5ChatReasoningEfforts(apiId)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_EFFORTS
  return gpt5CodexReasoningEfforts(apiId) ?? versionedGpt5ReasoningEfforts(apiId) ?? OPENAI_EFFORTS
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (["opus-4-7", "opus-4.7"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

function googleThinkingLevelEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  if (!id.includes("gemini-3")) return ["low", "high"]
  if (id.includes("flash-image")) return ["minimal", "high"]
  if (id.includes("pro-image")) return ["high"]
  if (id.includes("flash")) return ["minimal", "low", "medium", "high"]
  return ["low", "medium", "high"]
}

function googleThinkingBudgetMax(apiId: string) {
  const id = apiId.toLowerCase()
  if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
  return 24_576
}

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning && model.api.npm !== "@ai-sdk/openai-compatible") return {}

  const id = model.id.toLowerCase()
  if (
    model.api.id.toLowerCase().includes("minimax-m3") &&
    ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible"].includes(model.api.npm)
  ) {
    return {
      none: { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    }
  }
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)

  // 260729 Red GLM 从排除表移出：reasoning_effort 在 GLM-5.2 起是官方支持的（见 GLM_EFFORTS
  // 上方注释）。5.1 及以下仍然只有 thinking 二值开关，没有"想多深"这个维度，继续不给变体。
  // 此前无差别排除整个 glm 家族，导致 5.2 明明支持却在页脚看不到任何档位。
  if (id.includes("glm")) return glmSupportsEffort(id, model.api.id) ? effortVariants(GLM_EFFORTS) : {}

  // 260729 Red kimi-k3 起支持 reasoning_effort（Moonshot 官方文档）。k2 系列只有思考开关，
  // 没有强度维度，继续排除 —— 所以按版本判定而不是整个 kimi 家族一刀切。
  if (id.includes("kimi")) {
    const v = modelVersion(KIMI_RE, id, model.api.id)
    return v !== undefined && v >= 3 ? effortVariants(KIMI_K3_EFFORTS) : {}
  }

  if (id.includes("minimax") || id.includes("k2p") || id.includes("qwen") || id.includes("big-pickle")) return {}

  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") && id.includes("grok-3-mini")) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        low: { reasoning: { effort: "low" } },
        high: { reasoning: { effort: "high" } },
      }
    }
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }
  // 260729 Red grok-4.5 起支持 reasoning_effort（xAI 官方文档）。此前整个 grok 家族除
  // grok-3-mini 外一律无档位，4.5 明明支持却在页脚看不到。
  if (id.includes("grok")) {
    const v = modelVersion(GROK_RE, id, model.api.id)
    return v !== undefined && v >= 4.05 ? effortVariants(GROK_EFFORTS) : {}
  }

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      if (!id.includes("gpt") && !id.includes("gemini-3") && !id.includes("claude")) return {}
      return Object.fromEntries(
        (id.includes("gpt") ? openaiCompatibleReasoningEfforts(id) : OPENAI_EFFORTS).map((effort) => [
          effort,
          { reasoning: { effort } },
        ]),
      )

    case "ai-gateway-provider": {
      // Cloudflare AI Gateway routes every upstream through its OpenAI-compatible
      // /v1/compat endpoint, so the body is always OAI-shaped. The gateway
      // translates `reasoning_effort` to the upstream provider's native control
      // (e.g. Anthropic thinking budgets) when needed. Variants therefore stay
      // OAI-style for all upstreams, with an extended effort set for OpenAI
      // models that support it.
      if (model.api.id.startsWith("openai/")) {
        const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.id.includes("google")) {
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      return Object.fromEntries(
        openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
      )

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const copilotEfforts = iife(() => {
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )

    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible":
      // 260802 Red: deepseek-v4 系列的最强档按 provider 区分——官方 DeepSeek API 与
      // opencode-go 聚合供应商都支持 max；sensenova 只认 low/medium/high/xhigh/none，
      // 带 max 会 400 报错，用 xhigh 代替 max 作最强档。
      //
      // 260808 Red: deepseek 档位改按**官方文档**给，不再复用 WIDELY_SUPPORTED_EFFORTS。
      // https://api-docs.deepseek.com/zh-cn/guides/thinking_mode 现在明确只有 low/high/max
      // ——**medium 已被移除**（该基座集是从上游 opencode 一路继承下来的，没跟过 DeepSeek 的变更）。
      // 为什么必须动：opencode-go 网关**不校验**这个参数，实测 low/medium/high/max/xhigh/none
      // 六个值全返回 200，选错不会报错，只会静默按别的档跑。同一道题各档实测思考 token：
      // low 240 / medium 133 / high 134 / max 164 —— medium 与 high 只差 1 个 token，
      // 基本可以判定 medium 被静默映射成了 high（单次采样，非严格结论，但方向明确）。
      // 摆一个官方已删、实际等同 high 的档位出来，就是 GLM 那段注释说的"骗人"。
      // sensenova 那条保持原样：它是中转、档位集合本就与官方不同（有 medium/xhigh、无 max），
      // 手头没有该 provider 的凭据可复测，不在没有证据的情况下改动它。
      if (id.includes("deepseek") || model.api.id.toLowerCase().includes("deepseek")) {
        // 非 v4 一律不给档位。DeepSeek 官方现在**只剩 v4 系列**（deepseek-chat 等 260807 前后
        // 已下线），所以这条实际是给陈旧模型目录兜底的防线，不是活跃路径——也正因为没人再用，
        // `variants > deepseek returns empty object` 这个用例一直红着也没人管。
        if (!model.api.id.toLowerCase().includes("deepseek-v4")) return {}
        return effortVariants(
          model.providerID === "sensenova" ? [...WIDELY_SUPPORTED_EFFORTS, "xhigh"] : ["low", "high", "max"],
        )
      }
      // 到这里说明上面的校准特判都没认领——属"通用猜测"地带，models.dev 数据优先
      return dataEffortVariants(model) ?? effortVariants(WIDELY_SUPPORTED_EFFORTS)

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      return Object.fromEntries(
        (GPT5_FAMILY_RE.test(id) && gpt5Version(id) === undefined
          ? ["minimal", ...WIDELY_SUPPORTED_EFFORTS]
          : WIDELY_SUPPORTED_EFFORTS
        ).map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )
    case "@ai-sdk/openai": {
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )
    }

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
      if (adaptiveEfforts) {
        let efforts = [...adaptiveEfforts]
        if (model.providerID === "github-copilot") {
          if (model.api.id.includes("opus-4.7")) {
            efforts = ["medium"]
          }
          // Efforts currently supported are: low, medium, high
          efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
        }
        return Object.fromEntries(
          efforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(model.api.id.includes("opus-4-7") || model.api.id.includes("opus-4.7")
                  ? { display: "summarized" }
                  : {}),
              },
              effort,
            },
          ]),
        )
      }

      if (["opus-4-5", "opus-4.5"].some((v) => model.api.id.includes(v))) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { effort }]))
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(model.api.id.includes("opus-4-7") || model.api.id.includes("opus-4.7")
                  ? { display: "summarized" }
                  : {}),
              },
            },
          ]),
        )
      }
      // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      if (id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: googleThinkingBudgetMax(id),
            },
          },
        }
      }

      return Object.fromEntries(
        googleThinkingLevelEfforts(id).map((effort) => [
          effort,
          {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      // https://docs.mistral.ai/capabilities/reasoning/adjustable
      if (!model.capabilities.reasoning) return {}
      // Only Mistral Small 4 and Medium 3.5 support reasoning
      const MISTRAL_REASONING_IDS = [
        "mistral-small-2603",
        "mistral-small-latest",
        "mistral-medium-3.5",
        "mistral-medium-2604",
      ]
      const mistralId = model.api.id.toLowerCase()
      if (!MISTRAL_REASONING_IDS.some((id) => mistralId.includes(id))) return {}
      return {
        high: { reasoningEffort: "high" },
      }

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2":
      if (model.api.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.api.id.includes("gemini") && id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id)) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return {}
  }
  // 未知 npm：硬编码表没有任何知识，models.dev 数据是唯一线索
  return dataEffortVariants(model) ?? {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  if (
    input.model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    (!input.model.api.id.includes("claude") && input.model.api.npm === "@ai-sdk/anthropic")
  ) {
    result["toolStreaming"] = false
  }

  // openai and providers using openai package should set store to false by default.
  if (
    input.model.providerID === "openai" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/github-copilot"
  ) {
    result["store"] = false
  }

  if (input.model.api.npm === "@ai-sdk/azure") {
    result["store"] = false
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = {
      include: true,
    }
    if (input.model.api.id.includes("gemini-3")) {
      result["reasoning"] = { effort: "high" }
    }
  }

  if (
    input.model.providerID === "baseten" ||
    (input.model.providerID === "redcode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
  ) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  // 260729 Red 判据从 provider 名改为模型本身。原先只认 providerID 含 zai/zhipuai 的路径，
  // 但同样的 GLM 也可能挂在别的聚合供应商下（本机就是 opencode-go/glm-5.2），那条路径既拿不到
  // thinking 参数、也没有档位，完全靠上游默认值，RedCode 这边一个字都没说。
  // 官方文档：thinking.type 是 GLM-4.5 及以上都有的开关，默认 enabled。
  if (
    (glmVersion(input.model.id, input.model.api.id) !== undefined ||
      ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id))) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  // 260731 Red: 火山方舟 Doubao-Seed 系列（2.1 等）默认不返回独立思考字段——思考内容
  // 直接混进 content 正文，RedCode 端认不出 reasoning part，思考与正文完全摊在一起。
  // 实测：请求 body 加 thinking: {type: "enabled"} 后，思考走独立 reasoning_content 字段，
  // AI SDK openai-compatible 识别成 reasoning part → UI 自动折叠成「已思考」。
  // 判据用模型名（同 GLM 教训：挂聚合供应商下也生效），不用 providerID。
  if (
    input.model.api.id.toLowerCase().includes("doubao") &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
    }
  }

  // 260627 Red: stepfun/step-plan 加 promptCacheKey，稳定前缀缓存（同 openai/venice/openrouter）
  if (
    input.model.providerID === "openai" ||
    input.model.providerID === "stepfun" ||
    input.model.providerID === "step-plan" ||
    input.providerOptions?.setCacheKey
  ) {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
    if (input.model.capabilities.reasoning) {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }
  }

  // MiniMax's Anthropic interface defaults thinking off, unlike Chat Completions.
  const modelId = input.model.api.id.toLowerCase()
  if (modelId.includes("minimax-m3") && input.model.api.npm === "@ai-sdk/anthropic") {
    result["thinking"] = { type: "adaptive" }
  }

  // Enable thinking by default for kimi models using anthropic SDK
  if (
    (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
    (modelId.includes("kimi-k3") || modelId.includes("k2p") || modelId.includes("kimi-k2.") || modelId.includes("kimi-k2p"))
  ) {
    result["thinking"] = {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
    }
  }

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.model.api.npm === "@ai-sdk/azure" && input.model.api.id.includes("gpt-5.5")) {
    result["reasoningSummary"] = "auto"
    return result
  }

  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      result["reasoningSummary"] = "auto"
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat") &&
      input.model.providerID !== "azure"
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("redcode")) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = ["reasoning.encrypted_content"]
      result["reasoningSummary"] = "auto"
    }
  }

  if (input.model.providerID === "venice") {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.providerID === "openrouter") {
    result["prompt_cache_key"] = input.sessionID
  }
  if (input.model.api.npm === "@ai-sdk/gateway") {
    result["gateway"] = {
      caching: "auto",
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  const small = Object.values(model.variants ?? {})[0] ?? {}
  if (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/github-copilot"
  ) {
    const base = { store: false }
    return mergeDeep(base, small)
  }
  if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
    if (Object.keys(small).length === 0 && model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
  }

  if (model.providerID === "venice") {
    if (Object.keys(small).length > 0) return small
    return { veniceParameters: { disableThinking: true } }
  }

  return small
}

// Maps model ID prefix to provider slug used in providerOptions.
// Example: "amazon/nova-2-lite" → "bedrock"
const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  if (model.api.npm === "@ai-sdk/gateway") {
    // Gateway providerOptions are split across two namespaces:
    // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
    // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
    // We keep `gateway` as-is and route every other top-level option under the
    // model-derived upstream slug.
    const i = model.api.id.indexOf("/")
    const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
    const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
    const gateway = options.gateway
    const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
    const has = Object.keys(rest).length > 0

    const result: Record<string, any> = {}
    if (gateway !== undefined) result.gateway = gateway

    if (has) {
      if (slug) {
        // Route model-specific options under the provider slug
        result[slug] = rest
      } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
        result.gateway = { ...gateway, ...rest }
      } else {
        result.gateway = rest
      }
    }

    return result
  }

  // AI SDK packages that resolve providerOptionsName by splitting the
  // provider name on "." (e.g. "wafer.ai" -> "wafer") need the same
  // logic here so the key we write matches the key they read.
  // Other SDKs (xai, mistral, groq, cohere, etc.) use hardcoded keys
  // like "xai" or "cohere" - applying .split(".")[0] would break those.
  const usesDotSplitOptions =
    model.api.npm === "@ai-sdk/openai-compatible" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/anthropic"
  const key = sdkKey(model.api.npm) ?? (usesDotSplitOptions ? model.providerID.split(".")[0] : model.providerID)
  // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
  // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
  // "azure" first. Pass both so model options work on either code path.
  if (model.api.npm === "@ai-sdk/azure") {
    return { openai: options, azure: options }
  }
  return { [key]: options }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  // 260710 Red MiMo 模型用更高的 output token 上限
  // 260801 Red v4Flash 思考链长，正文被 32K 共享预算挤断，同样放宽到 64K
  const effective = isMimoModel(model)
    ? Math.max(outputTokenMax, MIMO_OUTPUT_TOKEN_MAX)
    : isDeepSeekV4FlashModel(model)
      ? Math.max(outputTokenMax, DEEPSEEK_V4_FLASH_OUTPUT_TOKEN_MAX)
      : outputTokenMax
  return Math.min(model.limit.output, effective) || effective
}

function isMimoModel(model: Provider.Model): boolean {
  // 260729 Red 空值保护：`model.api` 并非在所有构造路径上都存在，裸取 `.id` 会抛
  // "undefined is not an object"。它经由 maxOutputTokens → overflow.usable → isOverflow
  // 位于压缩判定的主路径上，抛在这里等于整条压缩链断掉。compaction 那 8 条 isOverflow
  // 测试长期挂的就是这个，不是断言写错。
  const id = model.api?.id?.toLowerCase() ?? model.id?.toLowerCase() ?? ""
  return id.includes("mimo")
}

function isDeepSeekV4FlashModel(model: Provider.Model): boolean {
  // 260801 Red 覆盖家族变体：deepseek-v4-flash / deepseek/deepseek-v4-flash /
  // deepseek-v4-flash-free / deepseek-v4-flash-think / empiriolabs/deepseek-v4-flash-el
  const id = model.api?.id?.toLowerCase() ?? model.id?.toLowerCase() ?? ""
  return id.includes("deepseek-v4-flash")
}

export function schema(model: Provider.Model, schema: JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  if (model.providerID === "moonshotai" || model.api.id.toLowerCase().includes("kimi")) {
    const sanitizeMoonshot = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== "object") return obj
      if (Array.isArray(obj)) return obj.map(sanitizeMoonshot)
      // Moonshot expands $ref before validation and rejects sibling keywords like description on the same node.
      if ("$ref" in obj && typeof obj.$ref === "string") return { $ref: obj.$ref }
      const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, sanitizeMoonshot(value)]))
      // MFJS does not support tuple-style `items` arrays; it requires one schema object for all array items.
      if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
      return result
    }

    const sanitized = sanitizeMoonshot(schema)
    if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
      schema = sanitized
    }
  }

  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema
}

export * as ProviderTransform from "./transform"
