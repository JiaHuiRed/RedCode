import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

// 260916 Red sidecar 拉起的 MCP 子进程在 Windows 上没有 job object 兜底（那套绑定依赖
//   bun:ffi，GUI 的 sidecar 是 node bundle，用不了），所以父进程一死它们就成孤儿。
//   两条路都会留下残骸：① sidecar 猝死重生时旧的一树没人清；② GUI 被强杀或崩溃时
//   exit / SIGINT / SIGTERM / before-quit 一条都跑不到。实测残留 20+ 个 python/node/fff-mcp。
//   这里落盘「谁在带这棵树」，并在两个时机按 ParentProcessId 反查清掉孩子。
//   决策记录：docs/notes/implemented/bug-fix/2026-09-16-instance-cache-and-orphans.md
const FILE = path.join(os.homedir(), ".redcode", "data", "sidecar-tree.json")

interface Tree {
  appPid: number
  sidecarPid: number
}

function read(): Tree | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Tree> | null
    if (typeof value?.appPid !== "number" || typeof value.sidecarPid !== "number") return undefined
    return { appPid: value.appPid, sidecarPid: value.sidecarPid }
  } catch {
    // 文件不存在（首次启动）或内容损坏，都当作「没有记录」：没有记录就没有可清的树。
    return undefined
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // 260916 Red Windows 上对已退出的进程抛 ESRCH，对无权访问的进程抛 EPERM——后者仍然活着。
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// 261024 Red PowerShell/taskkill 全部异步化：同步版 execFileSync 最坏 3×10s + taskkill
//   10s，跑在 whenReady 之后的串行路径上会把主进程事件循环整个冻结、推迟建窗。失败语义
//   逐条保留：单步失败降级为「本次漏清」，残留下次异常恢复还会被扫到，宁可漏清不误杀。
const execFileP = promisify(execFile)

function powershell(script: string): Promise<string> {
  return execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  }).then((result) => result.stdout)
}

// PID 会被系统复用，动手杀树前必须确认这个号还是我们的 sidecar、而不是巧合撞号的别的进程。
async function looksLikeSidecar(pid: number) {
  try {
    return (await powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`)).includes(
      "sidecar",
    )
  } catch {
    // 拿不到命令行就不猜：宁可漏清一次（下一个会话启动时还在，会再被扫到），也不误杀别的进程。
    return false
  }
}

async function childrenOf(parentPid: number): Promise<number[]> {
  try {
    const out = (
      await powershell(
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}"` +
          ` | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`,
      )
    ).trim()
    const parsed: unknown = JSON.parse(out || "null")
    // 单个子进程时 ConvertTo-Json 给的是标量而不是数组。
    if (typeof parsed === "number") return [parsed]
    if (Array.isArray(parsed)) return parsed.filter((value): value is number => typeof value === "number")
    return []
  } catch {
    // 查不到就当没有孩子：宁可漏清，也不误伤。
    return []
  }
}

async function killTree(pid: number) {
  try {
    // /T 连孙子一起杀：MCP server 自己也可能再拉子进程（uv/python/node 包装层）。
    await execFileP("taskkill", ["/F", "/T", "/PID", String(pid)], {
      windowsHide: true,
      timeout: 10_000,
    })
  } catch {
    // 单个 PID 杀不掉不影响其余；残留下次启动还会被扫到。
  }
}

// sidecar 已经死了但它的孩子还活着时用这个：taskkill /T 对已退出的父进程无效，
// 只能按 ParentProcessId 反查一代孩子，再各自按树杀。
export async function killOrphanChildren(parentPid: number) {
  for (const pid of await childrenOf(parentPid)) await killTree(pid)
}

export function rememberSidecarTree(appPid: number, sidecarPid: number | undefined) {
  // sidecar listener 不一定给出 pid（类型上就是可选的），没有 pid 就没法按树清理。
  if (typeof sidecarPid !== "number") return
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify({ appPid, sidecarPid } satisfies Tree))
  } catch {
    // 落盘失败只影响「下次启动能不能清扫」，不影响本次运行，不往启动路径上抛。
  }
}

export function forgetSidecarTree() {
  try {
    fs.rmSync(FILE, { force: true })
  } catch {
    // 删不掉也无妨：树已经被清掉，sweep 下次读到它只会发现进程早已不在。
  }
}

async function sweepStaleSidecarTree() {
  const tree = read()
  if (!tree) return
  // 记录里的那个 GUI 还活着，说明是另一个实例（多开）在用它，不归本次启动清。
  if (alive(tree.appPid)) return
  if (alive(tree.sidecarPid)) {
    // 确认是我们的 sidecar 才动手；不对就什么都不做，避免误伤撞号的进程。
    if (await looksLikeSidecar(tree.sidecarPid)) await killTree(tree.sidecarPid)
  } else {
    await killOrphanChildren(tree.sidecarPid)
  }
  forgetSidecarTree()
}

// 261024 Red 启动清扫的唯一入口：whenReady 后立刻起跑（不挡建窗），sidecar spawn 前由
//   调用方 await——「清完旧树才起新 sidecar」的先后是硬约束，但等待不该串在建窗前面。
//   每次进程生命周期只跑一次；空 catch 是有意的降级：单步失败已在内部逐条吞掉，能走到
//   这里的只有意外抛错，吞掉等价于「本次不清」，与同步版单步失败的语义一致。
let sweepInFlight: Promise<void> | undefined

export function beginStaleSidecarSweep(): Promise<void> {
  sweepInFlight ??= sweepStaleSidecarTree().catch(() => {})
  return sweepInFlight
}
