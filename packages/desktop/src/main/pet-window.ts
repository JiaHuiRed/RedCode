import { BrowserWindow, screen } from "electron"
import type { Point, WebContents } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"
import type { PetDrag, PetScene } from "../preload/pet-types"
import { petGeometry, savedPetPoint } from "./pet-geometry"
import { rendererPage } from "./renderer-url"
import { getStore } from "./store"
import { write as writeLog } from "./logging"

// 261118 Red 窗口/坐标的归属与验收边界：docs/notes/implemented/feature/2026-10-06-pet-v02-presentation.md
// 261119 Red 窗口归属从 GUI BrowserWindow owner 改为宿主来源仲裁（pet-host-registry）：
//   本模块只管窗口本身（创建/发布/销毁/拖动/位置持久化），谁显示、何时销毁由 pet-host 决定。
export const POSITION_KEY = "desktopPetPosition"
const preload = join(dirname(fileURLToPath(import.meta.url)), "../preload/pet.js")
let pet: BrowserWindow | undefined
let snapshot: DesktopPetSnapshot | undefined
let geometry: ReturnType<typeof petGeometry>
let loading: Promise<boolean> | undefined
let resolveReady: ((ready: boolean) => void) | undefined
let ready = false
let drag: { cursor: Point; origin: Point; moved: boolean } | undefined
let interactive = false

export function isPetRenderer(sender: WebContents) {
  return pet?.webContents === sender
}

function publish() {
  if (!pet || !ready || !snapshot) return
  const scene: PetScene = { snapshot, layout: geometry.layout }
  pet.webContents.send("desktop-pet:scene", scene)
}

function reposition() {
  if (!pet || drag) return
  geometry = petGeometry(screen.getDisplayNearestPoint(geometry.point).workArea, geometry.point)
  pet.setBounds(geometry.bounds)
  publish()
}

export function updatePetSnapshot(next: DesktopPetSnapshot | null): Promise<boolean> | boolean {
  if (process.platform !== "win32") return false
  if (!next) {
    pet?.destroy()
    return true
  }
  snapshot = next
  if (pet) {
    publish()
    return ready || loading || false
  }

  const point = savedPetPoint(getStore().get(POSITION_KEY))
  geometry = petGeometry((point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay()).workArea, point)
  const win = new BrowserWindow({
    ...geometry.bounds,
    title: "RedSpace Pet",
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  pet = win
  loading = new Promise((resolve) => {
    resolveReady = resolve
  })
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.webContents.on("render-process-gone", () => win.destroy())
  win.setIgnoreMouseEvents(true, { forward: true })
  screen.on("display-added", reposition)
  screen.on("display-removed", reposition)
  screen.on("display-metrics-changed", reposition)
  win.once("closed", () => {
    screen.off("display-added", reposition)
    screen.off("display-removed", reposition)
    screen.off("display-metrics-changed", reposition)
    pet = undefined
    snapshot = undefined
    drag = undefined
    interactive = false
    ready = false
    resolveReady?.(false)
    resolveReady = undefined
    loading = undefined
  })
  void win.loadURL(rendererPage("pet.html")).catch((error) => {
    if (win.isDestroyed()) return
    writeLog("window", "desktop pet failed to load", { error }, "warn")
    win.destroy()
  })
  return loading
}

export function desktopPetReady() {
  if (!pet) return
  ready = true
  publish()
  pet.showInactive()
  resolveReady?.(true)
  resolveReady = undefined
}

export function desktopPetHit(next: boolean) {
  if (!pet || interactive === next) return
  interactive = next
  if (!drag) pet.setIgnoreMouseEvents(!next, { forward: true })
}

export function dragDesktopPet(phase: PetDrag) {
  if (!pet) return
  const cursor = screen.getCursorScreenPoint()
  if (phase === "start") {
    drag = { cursor, origin: geometry.point, moved: false }
    pet.setIgnoreMouseEvents(false)
    return
  }
  if (!drag) return
  const point = {
    x: drag.origin.x + cursor.x - drag.cursor.x,
    y: drag.origin.y + cursor.y - drag.cursor.y,
  }
  if (phase === "move") {
    drag.moved = true
    pet.setPosition(point.x - geometry.layout.left, point.y - geometry.layout.top)
    return
  }
  const dropped = phase === "end" && drag.moved
  const target = dropped ? point : drag.origin
  geometry = petGeometry(screen.getDisplayNearestPoint(dropped ? cursor : target).workArea, target)
  drag = undefined
  pet.setBounds(geometry.bounds)
  pet.setIgnoreMouseEvents(!interactive, { forward: true })
  publish()
  if (dropped) getStore().set(POSITION_KEY, geometry.point)
}

export function closeDesktopPet() {
  pet?.destroy()
}
