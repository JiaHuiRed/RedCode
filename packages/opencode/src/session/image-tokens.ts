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
import { Token } from "@/util/token"

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

export * as ImageTokens from "./image-tokens"
