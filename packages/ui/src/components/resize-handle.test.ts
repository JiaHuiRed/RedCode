import { describe, expect, test } from "bun:test"
import { keyboardResizeSize, pointerResizeSize } from "./resize-handle"

// 261024 Red 把手换算逻辑的纯函数单测：edge/invert 的方向语义、夹紧、键盘映射。
// 组件里 rAF 合帧与 pointer capture 是 DOM 行为，不在这里覆盖。

const base = { direction: "horizontal", edge: "end", start: 100, startSize: 300, min: 220, max: 480 } as const

describe("pointerResizeSize", () => {
  test("end-edge handle follows the pointer", () => {
    expect(pointerResizeSize({ ...base, pos: 140 })).toBe(340)
    expect(pointerResizeSize({ ...base, pos: 60 })).toBe(260)
  })

  test("start-edge handle inverts the drag direction", () => {
    const startEdge = { ...base, edge: "start" as const }
    // start 侧把手向右（向内）拖是收窄，向左（向外）拖是变宽。
    expect(pointerResizeSize({ ...startEdge, pos: 140 })).toBe(260)
    expect(pointerResizeSize({ ...startEdge, pos: 60 })).toBe(340)
  })

  test("invert flips the whole mapping once", () => {
    expect(pointerResizeSize({ ...base, invert: true, pos: 140 })).toBe(260)
  })

  test("clamps into [min, max]", () => {
    expect(pointerResizeSize({ ...base, pos: 500 })).toBe(480)
    expect(pointerResizeSize({ ...base, pos: -100 })).toBe(220)
  })

  test("vertical direction uses the same rule with the y axis", () => {
    const vertical = { direction: "vertical" as const, edge: "end" as const, start: 200, startSize: 150, min: 100, max: 400 }
    expect(pointerResizeSize({ ...vertical, pos: 260 })).toBe(210)
    expect(pointerResizeSize({ ...vertical, edge: "start" as const, pos: 140 })).toBe(210)
  })
})

describe("keyboardResizeSize", () => {
  test("horizontal handle maps to left/right arrows", () => {
    expect(keyboardResizeSize({ ...base, key: "ArrowRight", size: 300 })).toBe(316)
    expect(keyboardResizeSize({ ...base, key: "ArrowLeft", size: 300 })).toBe(284)
    expect(keyboardResizeSize({ ...base, key: "ArrowDown", size: 300 })).toBeUndefined()
  })

  test("vertical handle maps to up/down arrows", () => {
    const vertical = { direction: "vertical" as const, min: 100, max: 400 }
    expect(keyboardResizeSize({ ...vertical, key: "ArrowDown", size: 150 })).toBe(166)
    expect(keyboardResizeSize({ ...vertical, key: "ArrowUp", size: 150 })).toBe(134)
  })

  test("Home/End jump to the bounds, clamped keys stay inside", () => {
    expect(keyboardResizeSize({ ...base, key: "Home", size: 300 })).toBe(220)
    expect(keyboardResizeSize({ ...base, key: "End", size: 300 })).toBe(480)
    expect(keyboardResizeSize({ ...base, key: "ArrowRight", size: 470 })).toBe(480)
    expect(keyboardResizeSize({ ...base, key: "ArrowLeft", size: 225 })).toBe(220)
  })

  test("unrelated keys return undefined", () => {
    expect(keyboardResizeSize({ ...base, key: "a", size: 300 })).toBeUndefined()
    expect(keyboardResizeSize({ ...base, key: "Enter", size: 300 })).toBeUndefined()
  })
})
