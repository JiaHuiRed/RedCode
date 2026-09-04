import { describe, expect, test } from "bun:test"
import { eventData } from "@/server/routes/instance/httpapi/handlers/sse-encode"

// 260904 cc SSE 事件体按对象缓存（黄档 A4 的服务端那一半）。
//
// `/event` 与 `/global/event` 每条连接各建一条 Stream、各自 map(eventData)，所以同一个事件
// 对象会被 stringify N 遍（N = 订阅者数）。GUI 一个窗口固定开两条流连同一个端点，会话 diff
// 那类事件能到 30MB 级——每多一个订阅者就多一遍全量序列化。
//
// 计数靠 getter：JSON.stringify 会读属性，命中缓存就一次都不读。

function counted(payload: unknown) {
  const state = { reads: 0 }
  const event = {
    directory: "/repo",
    get payload() {
      state.reads += 1
      return payload
    },
  }
  return { event, state }
}

describe("eventData", () => {
  test("同一个事件对象只序列化一次", () => {
    const { event, state } = counted({ id: "evt_1", type: "message.updated" })

    const first = eventData(event)
    expect(state.reads).toBe(1)

    const second = eventData(event)
    // 第二个订阅者拿到同样的字节，但没有再走一遍 stringify
    expect(state.reads).toBe(1)
    expect(second.data).toBe(first.data)
  })

  test("不同的事件对象各自序列化", () => {
    const a = counted({ id: "evt_a", type: "x" })
    const b = counted({ id: "evt_b", type: "x" })

    eventData(a.event)
    eventData(b.event)

    expect(a.state.reads).toBe(1)
    expect(b.state.reads).toBe(1)
  })

  test("形状与 Sse.Event 一致", () => {
    const out = eventData({ payload: { id: "evt_1", type: "server.connected" } })
    expect(out._tag).toBe("Event")
    expect(out.event).toBe("message")
    expect(out.id).toBeUndefined()
    expect(JSON.parse(out.data)).toEqual({ payload: { id: "evt_1", type: "server.connected" } })
  })

  // 心跳那类每次新建的对象不会命中，但也不能出错；primitive 更不能进 WeakMap。
  test("primitive 与 null 照常编码", () => {
    expect(eventData(null).data).toBe("null")
    expect(eventData(42).data).toBe("42")
    expect(eventData("hi").data).toBe('"hi"')
  })
})
