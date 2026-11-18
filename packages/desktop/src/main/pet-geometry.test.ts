import { describe, expect, test } from "bun:test"
import { petGeometry, savedPetPoint } from "./pet-geometry"

describe("desktop pet geometry", () => {
  test("retains a negative coordinate on a left or upper monitor", () => {
    const geometry = petGeometry({ x: -1920, y: -1080, width: 1920, height: 1040 }, { x: -800, y: -900 })
    expect(geometry.point).toEqual({ x: -800, y: -900 })
    expect(geometry.bounds.x + geometry.layout.left).toBe(-800)
    expect(geometry.bounds.y + geometry.layout.top).toBe(-900)
    expect(geometry.layout.placement).toBe("below")
  })

  test("keeps the sprite reachable when a previously saved monitor is unavailable", () => {
    const geometry = petGeometry({ x: 0, y: 0, width: 1280, height: 760 }, { x: -800, y: 300 })
    expect(geometry.point).toEqual({ x: 16, y: 300 })
    expect(geometry.bounds.x).toBe(0)
    expect(geometry.layout.placement).toBe("above")
  })

  test("starts near the bottom right without covering the taskbar", () => {
    const geometry = petGeometry({ x: 1920, y: 0, width: 1280, height: 760 })
    expect(geometry.point).toEqual({ x: 3000, y: 560 })
    expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(3200)
    expect(geometry.point.y + 184).toBeLessThan(760)
  })

  test("ignores invalid persisted coordinates", () => {
    expect(savedPetPoint({ x: 0, y: Infinity })).toBeUndefined()
    expect(savedPetPoint({ x: "-42", y: 0 })).toBeUndefined()
    expect(savedPetPoint({ x: -42.4, y: 0 })).toEqual({ x: -42, y: 0 })
  })
})
