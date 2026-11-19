import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// 261119 Red 桌宠宿主的本机登记文件：运行中的宿主（pet-host.json）与 spawn 命令登记
// （pet-host-install.json），都落 `~/.redcode/state/`（与 balloon-pos.json 同目录约定）。
// 本模块保持 Electron 无关（纯 fs + 路径），spawn 命令的判定由调用方注入，便于测试。

export const PET_HOST_FILE = "pet-host.json"
export const PET_HOST_INSTALL_FILE = "pet-host-install.json"

export function petStateDir() {
  return join(homedir(), ".redcode", "state")
}

function petStatePath(name: string) {
  return join(petStateDir(), name)
}

/** 读登记文件；不存在或 JSON 损坏一律返回 undefined——登记文件永远不做信任判据。 */
export function readPetStateJson(name: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(petStatePath(name), "utf8"))
  } catch (error) {
    // 吞掉的只有「文件不存在/损坏」——登记文件缺失是常态（宿主未运行），损坏按缺失处理
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return undefined
  }
}

/** 原子写：临时文件 + rename，避免来源读到半截 JSON。 */
export function writePetStateJson(name: string, value: unknown): void {
  const dir = petStateDir()
  mkdirSync(dir, { recursive: true })
  const target = petStatePath(name)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, target)
}

export function removePetStateJson(name: string): void {
  rmSync(petStatePath(name), { force: true })
}

/**
 * 宿主 spawn 命令：与桌面版同一可执行文件加 `--pet-host`。
 * dev 下 Electron 的 argv[1] 是 app 目录，必须原样带上（照 deep-link 的 dev 注册约定）；
 * 打包后 argv[1] 是宿主自身路径，不能重复传。
 */
export function petHostSpawnCommand(deps: { isPackaged: boolean; execPath: string; appArg?: string }): string[] {
  return deps.isPackaged ? [deps.execPath, "--pet-host"] : [deps.execPath, deps.appArg ?? ".", "--pet-host"]
}
