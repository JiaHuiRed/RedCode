export const CHARS_PER_TOKEN = 4

export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

// 260929 Red CJK 字符（中日假名 + 统一表意 + 扩展 A + 兼容表意 + 半角片假名）在 BPE 下
// 远不止一个 token，按 2 倍权重计入。权重是**借来的未校准启发式**——抄自 ZCode 的
// estimateTokens（apps/zcode-cli/packages/core/src/context/utils.ts:12-18），它自己的注释
// 也只敢写 "for debugging and monitoring"。本仓没有真 tokenizer（tiktoken / gpt-tokenizer
// 都没装），所以这个数只能进诊断侧，理由见 estimateReporting。
// 韩文音节与其余脚本同理但本仓用不到，刻意不收：加权范围写多大，就得为多大范围负责。
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/g

/**
 * 诊断侧估算器：CJK 按 2 倍权重计入后再除 CHARS_PER_TOKEN。
 *
 * 为什么不直接改 `estimate`：那个函数被**行为**侧依赖——工具结果硬限
 * （image-tokens.ts 的 fitToolResult）与压缩触发线（compaction.ts:403）都用它，而
 * `truncateToTokens` 又拿 CHARS_PER_TOKEN 做它的**逆换算**（「估算不超预算」这个承诺
 * 靠这两边同口径才成立）。改 estimate = 改行为，得先独立测量压缩触发点的位移，
 * 不塞进一个「让 UI 数字更准」的改动里。
 *
 * 两个估算器并存不是漏了抽取，是**故意不对称**：budget 估算器必须能和逆换算对齐，
 * reporting 估算器要近似真 tokenizer。谁再把它们「统一」回去，先读这段。
 *
 * 实测本机五份注入（全局/项目 AGENTS.md、MEMORY.md、soul，合计 57759 字节）：
 * 朴素 7892 token vs 加权 10696，**低估 36%**；纯中文的 soul 偏得最狠（1.75×）。
 */
export function estimateReporting(input: string) {
  const text = input || ""
  const cjk = text.match(CJK)?.length ?? 0
  return Math.max(0, Math.round((text.length + cjk) / CHARS_PER_TOKEN))
}

export * as Token from "./token"
