// 260907 ZCode 前台消息加载的跨模块计数器。
// GUI 性能审计问题 6：后台预取（±4 邻近会话 × 200 条全量 parts）与前台会话首屏
// 争抢同 host 的 6 个 HTTP/1.1 连接。fetchMessages（directory-sync，前台唯一拉消息
// 的出口）在此登记在途数量，prefetch 的 pump 看到非零就延迟让路——连接池优先
// 供给用户正在看的会话。预取不走 fetchMessages（直接调 client），不会被自己挡住。
let inflight = 0

export function foregroundMessageLoads(): number {
  return inflight
}

export function trackForegroundMessageLoad<T>(promise: Promise<T>): Promise<T> {
  inflight += 1
  return promise.finally(() => {
    inflight -= 1
  })
}
