import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain } from "electron"
import { PET_HOST_PROTOCOL, validatePetHostFile, validatePetInstallFile } from "@redcode-ai/ui/pet-host"
import { desktopAppId, SETTINGS_STORE } from "./constants"
import { initLogging, write as writeLog } from "./logging"
import {
  PET_HOST_FILE,
  PET_HOST_INSTALL_FILE,
  readPetStateJson,
  removePetStateJson,
  writePetStateJson,
} from "@redcode-ai/ui/pet-host-files"
import { createPetHostRegistry } from "./pet-host-registry"
import { createPetHostServer } from "./pet-host-server"
import { registerRendererProtocol } from "./windows"
import {
  closeDesktopPet,
  desktopPetHit,
  desktopPetReady,
  dragDesktopPet,
  isPetRenderer,
  POSITION_KEY,
  updatePetSnapshot,
} from "./pet-window"
import { getStore } from "./store"
import { savedPetPoint } from "./pet-geometry"

// 261119 Red TUI/GUI 共用桌面桌宠的宿主进程：桌面版同一可执行文件 + `--pet-host` 启动。
// 决策与边界 → docs/notes/implemented/feature/2026-11-18-tui-shared-desktop-pet.md：
// 独立 userData（与 GUI 的单实例锁互不干扰）、pet-only 不开主窗不启 sidecar、
// 最后一个来源释放后延迟自退；关闭按钮只关本次显示，不改任何持久开关。

const IDLE_EXIT_MS = 15_000

export function isPetHostArgv(argv: string[]) {
  return argv.includes("--pet-host")
}

/** GUI store（redcode.settings）→ 宿主 store 的一次性位置迁移：宿主 userData 是新目录。 */
function migratePetPosition(appId: string) {
  if (getStore().get(POSITION_KEY) !== undefined) return
  try {
    const legacy = JSON.parse(readFileSync(join(app.getPath("appData"), appId, SETTINGS_STORE), "utf8")) as Record<string, unknown>
    const point = savedPetPoint(legacy.desktopPetPosition)
    if (point) getStore().set(POSITION_KEY, point)
  } catch (error) {
    // 吞掉的是旧 GUI store 不存在/损坏：位置只是便利数据，缺省落主屏右下角，不值得阻断宿主
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      writeLog("window", "pet position migration skipped", { error }, "warn")
    }
  }
}

export async function runPetHost(): Promise<void> {
  const appId = desktopAppId()
  // userData 必须先于 requestSingleInstanceLock：锁按 userData 目录区分，
  // 宿主与 GUI 各持一把锁才能作为两个 Electron 进程共存（note 的原型验证点）
  app.setPath("userData", join(app.getPath("appData"), `${appId}-pet`))
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  // 261119 Red protocol.handle 必须在 app ready 之后调用；此前直接跑 runPetHost 会在
  // registerRendererProtocol 抛错，async 函数 reject 被调用处的 void 吞掉 →
  // 进程挂着却永不写 pet-host.json，来源侧反复 spawn 一个抢不到锁的新实例。
  await app.whenReady()
  const logger = initLogging()
  registerRendererProtocol()
  // 宿主无常驻窗：关掉 Electron 默认的「窗口全关即退出」，存活只由 idle-exit 与来源驱动
  app.on("window-all-closed", () => {})

  let displayClosed = false
  function applyDisplay() {
    if (displayClosed) return
    void updatePetSnapshot(registry.active()?.snapshot ?? null)
  }

  let idleTimer: NodeJS.Timeout | undefined
  function syncIdleExit() {
    if (registry.connectedCount() > 0) {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
      return
    }
    if (idleTimer) return
    idleTimer = setTimeout(() => app.quit(), IDLE_EXIT_MS)
    idleTimer.unref()
  }

  const registry = createPetHostRegistry({
    // 已定决策：显式激活接管——任一来源激活即解除「点 × 只关本次」的 latch，赤回来
    onActivate: () => {
      displayClosed = false
    },
    onChange: () => {
      applyDisplay()
      syncIdleExit()
    },
  })
  const token = randomUUID().replaceAll("-", "")
  const server = await createPetHostServer({ token, registry })

  // 安装登记（pet-host-install.json）由 GUI 启动时写、归 GUI 所有：dev 下宿主的
  // process.argv[1] 不是可靠的 app 路径，宿主覆写会污染 GUI 登记的 spawn 命令
  writePetStateJson(PET_HOST_FILE, {
    protocol: PET_HOST_PROTOCOL,
    pid: process.pid,
    port: server.port,
    token,
    version: app.getVersion(),
    startedAt: Date.now(),
  })

  migratePetPosition(appId)
  logger.log("pet host started", { port: server.port, pid: process.pid })

  // 赤渲染页的回程通道（ready/close/hit/drag）只存在于宿主进程；守卫同 ipc.ts 旧实现
  const onPet = (name: string, handler: (payload: unknown) => void) =>
    ipcMain.on(`desktop-pet:${name}`, (event, payload: unknown) => {
      if (isPetRenderer(event.sender) && event.senderFrame === event.sender.mainFrame) handler(payload)
    })
  onPet("ready", () => desktopPetReady())
  onPet("close", () => {
    // 已定决策：点关闭只关这一次显示——通知当前活跃来源（GUI 据此收敛 inline 状态），
    // 不改持久开关；下次任一来源显式激活即恢复
    displayClosed = true
    const active = registry.active()
    if (active) server.send(active.sourceID, { type: "closed" })
    closeDesktopPet()
  })
  onPet("hit", (value) => {
    if (typeof value === "boolean") desktopPetHit(value)
  })
  onPet("drag", (phase) => {
    if (phase === "start" || phase === "move" || phase === "end" || phase === "cancel") dragDesktopPet(phase)
  })

  app.on("will-quit", () => {
    void server.close()
    removePetStateJson(PET_HOST_FILE)
  })

  syncIdleExit()
}

/** 来源侧读取运行中宿主；文件缺失/损坏/协议不符一律 undefined，由调用方决定 spawn 或提示。 */
export function readRunningPetHost() {
  return validatePetHostFile(readPetStateJson(PET_HOST_FILE))
}

/** 来源侧读取宿主 spawn 命令登记（桌面版是否可用的判据）。 */
export function readPetHostInstall() {
  return validatePetInstallFile(readPetStateJson(PET_HOST_INSTALL_FILE))
}
