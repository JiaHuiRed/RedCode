// 260809 Red 从 Prompt 主组件抽出的缓存统计 hook（纯计算，无副作用）。
// 三档命中率（turn/conn/life）+ stalled 冻结判据，原逻辑在 prompt/index.tsx 的 usage memo。
// 拆分原因：Prompt 圈复杂度 396 的巨型组件，usage 是最独立的一块——不碰 input/store/渲染，
// 零风险第一刀。行为零改动：memo 依赖（sessionID + sync.data.message + sync.data.session）原样搬移。
import { createMemo } from "solid-js"
import type { useSync } from "../../context/sync"

export interface PromptUsage {
  cacheHitPct: number
  cacheMissPct: number
  turnHitPct?: number
  stalled: boolean
  lifeHitPct?: number
  lifeMiss: number
}

export function usePromptUsage(
  sessionID: () => string | undefined,
  sync: ReturnType<typeof useSync>,
): () => PromptUsage | undefined {
  return createMemo(() => {
    const id = sessionID()
    if (!id) return
    const msg = sync.data.message[id] ?? []
    // 260612 Red session-aggregate cache rate (not last-turn-only which is always ~99%)
    // 260614 Red: cache hit = read / (read + miss). DeepSeek write=0 so use cache.miss.
    // 260707 Red fix: session.ts's DeepSeek cache-cap fallback (260705) can route the real
    // miss/fresh tokens into cache.write instead of cache.miss depending on which raw metadata
    // field the SDK response populated for a given step. miss and write never double-count the
    // same tokens (tokens.cache.miss === tokens.input by construction in session.ts), so summing
    // read+miss+write gives the true total instead of an either/or pick that silently drops
    // whichever bucket the buggy path skipped — this was inflating hit% (e.g. 99% vs the real ~96%).
    // 260804 Red 这个累计值的统计范围是 **sync.data.message 里现有的消息**，也就是
    // "本次连接以来"，不是本会话全历史 —— 重启客户端就归零重算。界面上原来只写
    // "Cache hit"，会被理解成会话累计；实测因此误判过一整天，所以标签改成写明范围。
    let sumRead = 0,
      sumMiss = 0,
      sumWrite = 0
    // 逐轮序列，用来算本轮值和"缓存有没有停止延伸"
    const turns: Array<{ read: number; bad: number }> = []
    for (const m of msg) {
      if (m.role === "assistant") {
        const read = m.tokens.cache.read
        const bad = (m.tokens.cache.miss ?? 0) + m.tokens.cache.write
        sumRead += read
        sumMiss += m.tokens.cache.miss ?? 0
        sumWrite += m.tokens.cache.write
        if (read + bad > 0) turns.push({ read, bad })
      }
    }
    if (sumRead <= 0) return
    const cacheDenom = sumRead + sumMiss + sumWrite
    const cacheHitPct = Math.round((sumRead / cacheDenom) * 10000) / 100
    const cacheMissPct = Math.round(((cacheDenom - sumRead) / cacheDenom) * 10000) / 100

    // 260804 Red 本轮命中率 + 冻结判据。
    //
    // 累计值对"缓存卡住"这件事几乎没有诊断力：它是全窗口平均，冻结要几十轮才看得出来，
    // 恢复后又要上百轮才爬回去，中间还会因为单轮波动误报。真正的判据是**本轮 read 有没有
    // 在长**——正常时每轮递增，卡住时纹丝不动而 write/miss 每轮重新付一遍。
    //
    // 08-04 实测的那个 bug（vision 临时文件名带 Date.now()，每轮改写一条历史消息，
    // 把 provider 前缀缓存永久钉死）就是这个形态：read 连续几十轮停在 97k/110k/114k，
    // write 每轮 55~84k，命中率线性跌到 50% 且不自愈。判据取"连续 3 轮 read 完全不变
    // 且本轮未命中 > 3k"——按这条扫历史数据，三次冻结全部命中，健康轮次零误报。
    const last = turns[turns.length - 1]
    const turnHitPct = last ? Math.round((last.read / (last.read + last.bad)) * 10000) / 100 : undefined
    let flat = 0
    for (let i = turns.length - 2; i >= 0 && turns[i].read === last?.read && last.read > 0; i--) flat++
    const stalled = flat >= 2 && (last?.bad ?? 0) > 3000

    // 260804 Red 会话全历史命中率：上面两个都是从 sync.data.message 算的，只覆盖客户端
    // 当前持有的消息（重启归零）；这个取会话记录上的累计 token，落在 DB 里、跨重启不丢，
    // 才是真正的"这个会话到目前为止"。会话记录没有 cache.miss 字段，tokens.input 就是
    // 那一项（session.ts 里 tokens.cache.miss === tokens.input by construction）。
    const record = sync.data.session.find((s) => s.id === id)?.tokens
    const lifeRead = record?.cache.read ?? 0
    // 260804 Red 累计未命中**按 token 数**给，不给百分比 —— 百分比恒等于 100−hit，
    // 加上去是纯冗余（原来的 "Cache hit X% · miss Y%" 就是这个毛病）。token 数则相反：
    // 它是从百分比反推不出来的（要知道总量），而且直接对应账单上按全价计费的那部分。
    const lifeMiss = (record?.input ?? 0) + (record?.cache.write ?? 0)
    const lifeDenom = lifeRead + lifeMiss
    const lifeHitPct = lifeDenom > 0 && lifeRead > 0 ? Math.round((lifeRead / lifeDenom) * 10000) / 100 : undefined

    return { cacheHitPct, cacheMissPct, turnHitPct, stalled, lifeHitPct, lifeMiss }
  })
}
