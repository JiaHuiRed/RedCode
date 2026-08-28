const pattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function sessionTitle(title?: string) {
  if (!title) return title
  const match = title.match(pattern)
  return match?.[1] ?? title
}

// 260828 cc 标题里的人格前缀（`[宋雨琦] 修改UL黄卡代码…`）拆出来。
//
// 前缀由标题生成时写进去（人格名取自 soul 第一行）。在看板里同一批卡片的前缀几乎恒等，
// 于是每张卡最值钱的那几个字符——标题开头——被一个常量占掉。拆开之后第一行是纯标题，
// 前缀降到第二行的元信息里跟日期作伴。
const PERSONA_PREFIX = /^\[([^\]]{1,12})\]\s*/

export function sessionTitleParts(title?: string): { persona?: string; text: string } {
  const normalized = sessionTitle(title) ?? ""
  const match = normalized.match(PERSONA_PREFIX)
  if (!match) return { text: normalized }
  const text = normalized.slice(match[0].length)
  // 去掉前缀之后什么都不剩就别拆——那说明整个标题就是个前缀，拆了反而没东西显示
  if (!text) return { text: normalized }
  return { persona: match[1], text }
}
