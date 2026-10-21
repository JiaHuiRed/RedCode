import { execFile } from "node:child_process"
import { access, readFile, readdir } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import util from "node:util"

const execFilePromise = util.promisify(execFile)

// 261021 Red 审计 RC21-07：wslpath 以前用 execFileSync，由主进程 IPC 直接调用 —— WSL 冷启动
// 或挂起期间整个主进程事件循环被阻塞，所有窗口操作与 IPC 一起排队。改成异步执行 + 显式超时；
// 超时不是「失败就算了」：WSL 挂起时子进程可能永远不返回，超时是唯一的出口。
// 取舍见 docs/notes/implemented/bug-fix/2026-10-21-wsl-async-path.md。
const WSL_PATH_TIMEOUT_MS = 5_000

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false)

export function checkAppExists(appName: string) {
  if (process.platform === "win32") return true
  if (process.platform === "linux") return true
  return checkMacosApp(appName)
}

export function resolveAppPath(appName: string) {
  if (process.platform !== "win32") return appName
  return resolveWindowsAppPath(appName)
}

/** 跑一次 wsl 并交出 stdout。抽成依赖是为了让超时、批量合并与错误信息可以被测试钉住。 */
export type WslExec = (args: string[]) => Promise<string>

const defaultWslExec: WslExec = (args) =>
  execFilePromise("wsl", args, { timeout: WSL_PATH_TIMEOUT_MS, windowsHide: true }).then((result) =>
    result.stdout.toString(),
  )

export function createWslPath(options: { exec?: WslExec; platform?: NodeJS.Platform; timeoutMs?: number } = {}) {
  const exec = options.exec ?? defaultWslExec
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? WSL_PATH_TIMEOUT_MS

  // 错误信息要能指导下一步：只说 "failed" 等于让用户去猜 WSL 有没有起来。
  const fail = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(
      `WSL path conversion failed after ${timeoutMs}ms: ${detail}. ` +
        `Check that WSL is installed and running (wsl -l -v), then try again.`,
      { cause: error },
    )
  }

  const path = async (value: string, mode: "windows" | "linux" | null) => {
    if (platform !== "win32") return value
    const flag = mode === "windows" ? "-w" : "-u"
    try {
      // `~` 必须由远端 shell 展开：直接交给 wslpath 会当成字面量目录名。
      if (value.startsWith("~")) {
        const suffix = value.slice(1)
        const output = await exec(["-e", "sh", "-lc", `wslpath ${flag} "$HOME${suffix.replace(/"/g, '\\"')}"`])
        return output.trim()
      }
      return (await exec(["-e", "wslpath", flag, value])).trim()
    } catch (error) {
      throw fail(error)
    }
  }

  /**
   * 一次 WSL 调用转换多条路径。多选文件原来对每个路径各发一次 IPC，各自都是一次 WSL
   * 冷启动；串行也只是把 N 次冷启动排成队，合并成一段 shell 循环才真的只起一次进程。
   * `~` 开头的仍走单条路径（需要远端 shell 展开）。
   */
  const paths = async (values: string[], mode: "windows" | "linux" | null) => {
    if (platform !== "win32") return values
    if (!values.length) return []
    const flag = mode === "windows" ? "-w" : "-u"
    const positions = values.map((value, position) => ({ value, position }))
    const tildes = positions.filter((item) => item.value.startsWith("~"))
    const literals = positions.filter((item) => !item.value.startsWith("~"))
    const result: string[] = Array.from({ length: values.length })
    if (literals.length) {
      try {
        const output = await exec([
          "-e",
          "sh",
          "-lc",
          `for p in "$@"; do wslpath ${flag} "$p"; done`,
          "redcode",
          ...literals.map((item) => item.value),
        ])
        const lines = output.split(/\r?\n/).filter((line) => line.length > 0)
        // 行数对不上说明有路径没转换成功：宁可整体失败，也不要把结果错位配给别的路径。
        if (lines.length !== literals.length) {
          throw new Error(`expected ${literals.length} converted paths, got ${lines.length}`)
        }
        literals.forEach((item, offset) => {
          result[item.position] = lines[offset]!
        })
      } catch (error) {
        throw fail(error)
      }
    }
    for (const item of tildes) result[item.position] = await path(item.value, mode)
    return result
  }

  return { path, paths }
}

const wsl = createWslPath()

export const wslPath = wsl.path
export const wslPathMany = wsl.paths

async function checkMacosApp(appName: string) {
  const locations = [`/Applications/${appName}.app`, `/System/Applications/${appName}.app`]

  const home = process.env.HOME
  if (home) locations.push(`${home}/Applications/${appName}.app`)

  for (const location of locations) {
    if (await exists(location)) return true
  }

  return execFilePromise("which", [appName])
    .then(() => true)
    .catch(() => false)
}

async function resolveWindowsAppPath(appName: string): Promise<string | null> {
  let output: string
  try {
    output = await execFilePromise("where", [appName]).then((r) => r.stdout.toString())
  } catch {
    return null
  }

  const paths = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const hasExt = (path: string, ext: string) => extname(path).toLowerCase() === `.${ext}`

  const exe = paths.find((path) => hasExt(path, "exe"))
  if (exe) return exe

  const resolveCmd = async (path: string) => {
    const content = await readFile(path, "utf8")
    for (const token of content.split('"').map((value: string) => value.trim())) {
      const lower = token.toLowerCase()
      if (!lower.includes(".exe")) continue

      const index = lower.indexOf("%~dp0")
      if (index >= 0) {
        const base = dirname(path)
        const suffix = token.slice(index + 5)
        const resolved = suffix
          .replace(/\//g, "\\")
          .split("\\")
          .filter((part: string) => part && part !== ".")
          .reduce((current: string, part: string) => {
            if (part === "..") return dirname(current)
            return join(current, part)
          }, base)

        if (await exists(resolved)) return resolved
      }

      if (await exists(token)) return token
    }

    return null
  }

  for (const path of paths) {
    if (hasExt(path, "cmd") || hasExt(path, "bat")) {
      const resolved = await resolveCmd(path)
      if (resolved) return resolved
    }

    if (!extname(path)) {
      const cmd = `${path}.cmd`
      if (await exists(cmd)) {
        const resolved = await resolveCmd(cmd)
        if (resolved) return resolved
      }

      const bat = `${path}.bat`
      if (await exists(bat)) {
        const resolved = await resolveCmd(bat)
        if (resolved) return resolved
      }
    }
  }

  const key = appName
    .split("")
    .filter((value: string) => /[a-z0-9]/i.test(value))
    .map((value: string) => value.toLowerCase())
    .join("")

  if (key) {
    for (const path of paths) {
      const dirs = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))]
      for (const dir of dirs) {
        try {
          for (const entry of await readdir(dir)) {
            const candidate = join(dir, entry)
            if (!hasExt(candidate, "exe")) continue
            const stem = entry.replace(/\.exe$/i, "")
            const name = stem
              .split("")
              .filter((value: string) => /[a-z0-9]/i.test(value))
              .map((value: string) => value.toLowerCase())
              .join("")
            if (name.includes(key) || key.includes(name)) return candidate
          }
        } catch {
          continue
        }
      }
    }
  }

  return paths[0] ?? null
}
