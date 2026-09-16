import { describe, expect, test } from "bun:test"
import { createDeepLinkDelivery } from "./deep-link-delivery"

describe("deep link delivery", () => {
  test("queues until ready, delivers live links, and queues again after reload", () => {
    const sent: string[][] = []
    const delivery = createDeepLinkDelivery((urls) => {
      sent.push([...urls])
      return true
    })

    delivery.emit(["redcode://open-project?directory=/before"])
    expect(delivery.consumeInitial()).toEqual(["redcode://open-project?directory=/before"])

    delivery.markReady()
    delivery.emit(["redcode://open-project?directory=/live"])
    expect(sent).toEqual([["redcode://open-project?directory=/live"]])

    delivery.reset()
    delivery.emit(["redcode://open-project?directory=/reload"])
    expect(sent).toEqual([["redcode://open-project?directory=/live"]])

    delivery.markReady()
    expect(sent).toEqual([["redcode://open-project?directory=/live"], ["redcode://open-project?directory=/reload"]])
  })

  test("keeps links queued when the renderer cannot receive them", () => {
    const delivery = createDeepLinkDelivery(() => false)

    delivery.markReady()
    delivery.emit(["redcode://open-project?directory=/retry"])

    expect(delivery.consumeInitial()).toEqual(["redcode://open-project?directory=/retry"])
  })
})
