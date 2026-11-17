// 260819 cc audit：按 sessionID 累积的进程内状态的通用回收。
//
// 背景：审计发现三处这样的状态全都没有删除点（prompt-caches 的四个缓存、file/time 的
// 「读过的文件 → mtime」表、prefix-shape 的前缀指纹），CLI 形态无影响（进程即会话），
// 但 GUI sidecar 与 serve 是长驻多会话进程，只增不减。第三处出现时把回收逻辑抽出来，
// 免得同一段 TTL+上限的代码在仓里存三份、将来改一处漏两处。
//
// 口径用「冷」而不是「删」：会话被显式删除是少数情况，绝大多数只是不再被使用。
//   TTL 为主——超过阈值没被碰过即回收。
//   数量为辅——只挡突发。
//   当前 key 永不被自己这一轮的 touch 顺手回收掉。
//
// 惰性清扫而非定时器：条目数是「近期会话数」量级（个位到几十），每次 touch 扫一遍代价
// 可忽略，也不必操心 timer 的生命周期与 unref。

export interface SessionEvictor {
  /** 登记一次使用，并回收冷条目。返回真正释放了东西的 key（供调用方打日志）。 */
  touch(key: string, now?: number): string[]
  /** 只摘记账，数据由调用方自己删——给「主动 drop 某个 key」的路径用，避免记账泄漏。 */
  forget(key: string): void
  /** 当前记账中的 key 数（测试钩子 / 日志用）。 */
  size(): number
  /** 清空记账（测试钩子）。 */
  clear(): void
}

export function sessionEvictor(opts: {
  ttlMs: number
  max: number
  /** 摘掉这个 key 的数据，返回释放了多少东西；返回 0 表示只有记账、没有数据。 */
  drop: (key: string) => number
  /**
   * 记账存储。默认新建；prompt-caches 那种要跟缓存本体放同一个 globalThis 槽的
   * （分开放会让「模块被实例化多次」时各实例按各自的视图回收共享数据）传自己的。
   */
  seen?: Map<string, number>
}): SessionEvictor {
  const seen = opts.seen ?? new Map<string, number>()

  const evict = (key: string, out: string[]) => {
    const freed = opts.drop(key)
    seen.delete(key)
    if (freed > 0) out.push(key)
  }

  return {
    touch(key, now = Date.now()) {
      // 重新插入把自己挪到末尾——Map 保插入序，于是从头遍历就是「从最冷到最热」
      seen.delete(key)
      seen.set(key, now)

      const evicted: string[] = []
      for (const [id, at] of [...seen]) {
        if (id === key) continue
        if (now - at <= opts.ttlMs) break // 后面的只会更热
        evict(id, evicted)
      }
      while (seen.size > opts.max) {
        const oldest = seen.keys().next().value
        if (oldest === undefined || oldest === key) break
        evict(oldest, evicted)
      }
      return evicted
    },
    forget(key) {
      seen.delete(key)
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  }
}

// 三处共用的阈值。1 小时的依据：对 prompt-caches 而言，此时 provider 侧的前缀缓存
// （分钟量级）早已过期，重建不多花钱；32 的依据：回收活跃会话是有代价的（丢
// msgPin/modelMsgs 等于让 DCP 攒下的改写一次性生效、整条前缀重写），单人使用下
// 一小时内触碰超过 32 个会话不现实。
export const SESSION_TTL_MS = 60 * 60 * 1000
export const MAX_SESSIONS = 32
