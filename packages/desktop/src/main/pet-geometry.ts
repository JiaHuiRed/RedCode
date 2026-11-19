import type { Point, Rectangle } from "electron"
import type { DesktopPetLayout } from "@redcode-ai/ui/desktop-pet"

export const PET_WINDOW = { width: 320, height: 432 }
const PET_SIZE = 184
const BUBBLE_ROOM = 224
const INSET = 16

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

export function petGeometry(area: Rectangle, saved?: Point): { point: Point; bounds: Rectangle; layout: DesktopPetLayout } {
  const right = area.x + area.width
  const bottom = area.y + area.height
  const point = {
    x: clamp(saved?.x ?? right - PET_SIZE - INSET, area.x + INSET, right - PET_SIZE - INSET),
    y: clamp(saved?.y ?? bottom - PET_SIZE - INSET, area.y + INSET, bottom - PET_SIZE - INSET),
  }
  const placement = point.y - area.y >= BUBBLE_ROOM ? "above" : "below"
  const x = clamp(point.x - (PET_WINDOW.width - PET_SIZE) / 2, area.x, right - PET_WINDOW.width)
  const y = placement === "above" ? point.y - BUBBLE_ROOM : Math.max(area.y, point.y - INSET)
  return {
    point,
    bounds: { ...PET_WINDOW, x, y },
    layout: { left: point.x - x, top: point.y - y, placement },
  }
}

export function savedPetPoint(raw: unknown): Point | undefined {
  if (!raw || typeof raw !== "object" || !("x" in raw) || !("y" in raw)) return
  if (typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return
  return { x: Math.round(raw.x), y: Math.round(raw.y) }
}
