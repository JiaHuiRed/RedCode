import * as Sse from "effect/unstable/encoding/Sse"

/**
 * 260904 cc SSE 事件体的序列化，**按事件对象缓存**（黄档 A4 的服务端那一半）。
 *
 * 病灶：`/event` 与 `/global/event` 都是**每条连接建一条独立的 Stream**，各自
 * `Stream.map(eventData)`。同一个事件对象因此被 `JSON.stringify` N 遍，N = 当前订阅者数。
 * 而 GUI 一个窗口就固定开**两条**流（`context/global-sdk.tsx` 在 onMount 自启动，
 * `context/server-sync.tsx` 在下一帧启动 `server-sdk`），两条连的是同一个 server 的同一个
 * 端点；再算上 TUI、第二个窗口、分享服务，N 还会更大。会话 diff 那类事件能到 30MB 级，
 * 每多一个订阅者就多一遍全量 stringify。
 *
 * 为什么可以缓存：`GlobalBus` 是 Node 的 `EventEmitter`，`super.emit` 把**同一个对象引用**
 * 同步派给所有 handler；instance 侧的 `bus.subscribeAll()`（Effect PubSub）同样不拷贝。
 * 各连接的 handler 只把它入队，没有任何一处改写事件对象——`GlobalBus.emit` 里那次
 * `payload.id` 赋值发生在 `super.emit` **之前**，轮不到订阅者看见半成品。
 *
 * 为什么有界：用 `WeakMap`。事件对象只要还在某条连接的队列里就活着、条目就在；两条队列
 * 都消费完，对象被回收，条目自动消失。不需要上限，也不会拖住内存。
 *
 * 未命中不出错：心跳与 `server.connected` 每次都是新对象，照常各自序列化一次——它们本来
 * 就小，不是这条路要省的东西。
 */
const encoded = new WeakMap<object, string>()

export function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: encode(data),
  }
}

function encode(data: unknown): string {
  if (data === null || typeof data !== "object") return JSON.stringify(data)
  const hit = encoded.get(data)
  if (hit !== undefined) return hit
  const json = JSON.stringify(data)
  encoded.set(data, json)
  return json
}
