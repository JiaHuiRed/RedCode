// 260828 cc：图片在上下文估算里按什么计价。
//
// 病灶：SessionCompaction.estimate 是 `Token.estimate(JSON.stringify(modelMessages))`，
// 而 toModelMessages 把图片拼成内联 data URL（message-v2.ts 的 file part）。chars/4
// 于是把一张 400KB 的 JPEG 算成约 13 万 token —— 它在 DeepSeek 上实际最多 384。
//
// 触发线没被这个数带偏（level() 取 provider usage，锚是对的），但 select() 用它算
// 保留哪些轮次：倒着累加各轮 size 直到超预算，一张图必然让那一轮超，splitTurn 也切
// 不出能装下的片，结果图片所在轮及更早的全部被判出局。
//
// 形态取自 deepseek-harness 的 route-priced image request pressure：**usage 仍是完成
// 请求的锚，路由投影只给增量定价**。这里只做增量那一半。
import { Token, CHARS_PER_TOKEN } from "@/util/token"

// DeepSeek 官方 v4 视觉计算器的上限（14px patch、3:1 下采样、384 token 封顶）。
//
// 取上限而不按尺寸精算：FilePart 不带宽高，要拿到得解码；而本仓在 image.ts 里已经
// 把图归一化到 ≤2000×2000，那个尺寸下投影本来就顶到封顶附近。方向是保守的——只会
// 高估不会低估，最大误差 384，对照现状的约 13 万。
const DEEPSEEK_IMAGE_TOKENS = 384

// 其它供应商的视觉投影各不相同（tile 数、detail 档位、预处理都不一样），没有实测
// 就不编数字。**默认值现在刻意等于 deepseek 那条**，所以即使 providerID 的键写错
// 也不会静默改变行为；等真要按供应商分档时，加的那个键必须先对着实际 provider 列表
// 验过（见 memory 里 DCP 触发线键写错静默回落那次）。
const IMAGE_TOKENS_BY_PROVIDER: Record<string, number> = {
  deepseek: DEEPSEEK_IMAGE_TOKENS,
}
const CONSERVATIVE_DEFAULT = DEEPSEEK_IMAGE_TOKENS

export function imageRequestTokens(model: { providerID: string }): number {
  return IMAGE_TOKENS_BY_PROVIDER[model.providerID] ?? CONSERVATIVE_DEFAULT
}

// 内联载荷被换成一个短占位再计长度。留一点长度是因为 file part 的其余字段
// （type/mediaType/filename）本来就要占位置，占位串本身的贡献可以忽略。
const PLACEHOLDER = "data:image/*;base64,<image>"

function isImagePayload(container: unknown, key: string, value: string): boolean {
  if (key !== "url" && key !== "data") return false
  if (value.startsWith("data:image/")) return true
  const record = container as Record<string, unknown> | undefined
  const mediaType = record?.["mediaType"] ?? record?.["mime"]
  return typeof mediaType === "string" && mediaType.startsWith("image/")
}

/**
 * 数出一段模型消息里的**路由无关事实**：文本 token 数（chars/4）与图片张数。
 *
 * 内联载荷在计长度前换成占位串；远程图片 URL 原样保留（它本来就只占自己那点长度），
 * 但**同样计入一张图**——否则就成了反方向的失真：上游正是因为把图按结构 JSON 算成
 * 约 40 token 而让压缩迟到溢出。
 *
 * 之所以把"事实"和"定价"分开：调用方可以按对象引用缓存事实，等到真正要出数时再按
 * **当前路由**定价。缓存里存价钱的话，换模型之后留下的是上一条路由的价。
 */
export function countModelMessageContent(value: unknown): { text: number; images: number } {
  let images = 0
  const text = JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    if (typeof item !== "string") return item
    if (!isImagePayload(this, key, item)) return item
    images++
    // 远程 URL 原样留着；内联载荷换占位 —— 既包括 `data:image/...;base64,` 这种完整
    // data URL，也包括 { mediaType, data } 形态下的裸 base64。
    const remote = item.startsWith("http://") || item.startsWith("https://")
    return remote ? item : PLACEHOLDER
  })
  return { text: Token.estimate(text ?? ""), images }
}

/** 按路由给模型消息估算 token：文本照旧 chars/4，图片按路由投影计价。 */
export function estimateModelMessages(messages: unknown, model: { providerID: string }): number {
  const facts = countModelMessageContent(messages)
  return facts.text + facts.images * imageRequestTokens(model)
}

/* --------------------------------------------------------------------------
   260923 Red 工具结果在模型侧的硬预算。

   缺口：图片与工具输出的**字节**闸门已经有两道（read.ts 的附件上限、
   session/tools.ts 的 5MB base64 + 32 条），但字节不等于模型开销 —— 32 张各自
   合法通过字节闸门的图，在模型侧是 32 × 视觉投影的账。字节线管的是内存，这条
   管的是上下文，此前**一条都没有**（tool/read.ts 的图片分支和 summary.diffs
   就是同一类"写的时候没人问上限"）。

   取 14,000 的理由：它高于既有纯文本上限（tool/truncate.ts 默认 MAX_BYTES =
   50 KiB ≈ 12,800 token），所以**纯文本工具结果的行为逐字节不变**，这条线只对
   「文本 + 附件」的合成结果生效。
   -------------------------------------------------------------------------- */
export const TOOL_RESULT_TOKEN_BUDGET = 14_000

// 附件全占满时仍给文本留的预览额度。附件不可拆，文本可以两头截，所以丢附件之前
// 先把这段额度保住，否则一个纯图结果会把正文挤成空串，模型失去全部上下文。
const TEXT_FLOOR = 400

// file part 的 JSON 包壳（键名 + 占位串）本身也进模型上下文。密图结果里它不可忽略：
// 一张图约 82 字符，32 张就是约 660 token。按 32 计（≈128 字符）留一点余量，否则
// 「预算只算正文和投影」的账会在附件密集时系统性低估。
const ATTACHMENT_ENVELOPE_TOKENS = 32

// 文本截断的省略标记要占位置（含被省略的字符数，长度随数字位数变化）。预留一个安全
// 上界，否则标记本身就能把总账顶过线。
const MARKER_RESERVE = 120

/**
 * 一条附件在预算里占多少：视觉投影 + JSON 包壳。
 *
 * 260923 Red **非图片媒体（PDF）刻意计 0**：它已经被字节线（5MB base64）与条数线
 * （32）限住，而真实开销按页计、从字节推不出来。按 base64/4 计的话 5MB 就是约
 * 1.7M token，会把每一个合法 PDF 都判出局 —— 比这点不精确更糟。
 */
export function attachmentRequestTokens(mime: string, model: { providerID: string }): number {
  return mime.startsWith("image/") ? imageRequestTokens(model) + ATTACHMENT_ENVELOPE_TOKENS : 0
}

/**
 * 按 token 预算双端截断文本（head 80% / tail 20%，与 tool/truncate.ts 和压缩摘要同比例，
 * 尾部常是结论或报错）。
 *
 * token ↔ 字符用 CHARS_PER_TOKEN 换算，与 Token.estimate 同一口径 —— 换成别的比例，
 * 「估算不超预算」这个承诺就不成立了。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const usable = Math.max(0, Math.max(0, maxTokens) * CHARS_PER_TOKEN - MARKER_RESERVE)
  if (text.length <= usable) return text
  const head = Math.floor(usable * 0.8)
  const tail = usable - head
  const omitted = text.length - usable
  const marker = `\n[... ${omitted} chars omitted, tool result over the model-visible token budget ...]\n`
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`
}

export interface FittedToolResult<T> {
  text: string
  attachments: T[]
  /** 被预算挡在门外的附件（尾部），按原顺序，供调用方另存。 */
  dropped: T[]
  truncated: boolean
}

/**
 * 把一条工具结果（文本 + 附件）压进 TOOL_RESULT_TOKEN_BUDGET。
 *
 * 取舍顺序是刻意的：**先截文本、后丢附件**。文本可拆（两头各留一段），附件不可拆；
 * 所以附件只在「自己就装不下」时才从尾部丢，且丢之前先保住 TEXT_FLOOR 的正文预览。
 *
 * `options.notice` 是调用方打算追加的提示（比如「完整内容在 <路径>」）。那条提示本身
 * 也进模型上下文，所以显式从预算里扣掉，而不是猜一个固定预留值。
 */
export function fitToolResult<T extends { mime: string }>(
  input: { text: string; attachments?: T[] },
  model: { providerID: string },
  options?: { notice?: string },
): FittedToolResult<T> {
  const attachments = input.attachments ?? []
  const price = (item: T) => attachmentRequestTokens(item.mime, model)
  const total = attachments.reduce((sum, item) => sum + price(item), 0)
  if (Token.estimate(input.text) + total <= TOOL_RESULT_TOKEN_BUDGET)
    return { text: input.text, attachments, dropped: [], truncated: false }

  const budget = TOOL_RESULT_TOKEN_BUDGET - Token.estimate(options?.notice ?? "")
  const ceiling = budget - TEXT_FLOOR
  const kept: T[] = []
  let spent = 0
  for (const item of attachments) {
    if (spent + price(item) > ceiling) break
    kept.push(item)
    spent += price(item)
  }
  return {
    text: truncateToTokens(input.text, budget - spent),
    attachments: kept,
    dropped: attachments.slice(kept.length),
    truncated: true,
  }
}

/** 按与 fitToolResult 相同的口径估价一条工具结果（文本 + 附件），供测试与断言使用。 */
export function estimateToolResult(
  input: { text: string; attachments?: Array<{ mime: string }> },
  model: { providerID: string },
): number {
  return (
    Token.estimate(input.text) +
    (input.attachments ?? []).reduce((sum, attachment) => sum + attachmentRequestTokens(attachment.mime, model), 0)
  )
}

export * as ImageTokens from "./image-tokens"
