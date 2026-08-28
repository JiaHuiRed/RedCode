// 260828 cc 清扫陈旧的测试临时目录。
//
// 每个测试进程会在 %TEMP% 下留 `redcode-test-data-<pid>`（test/preload.ts）与若干
// `redcode-test-<rand>`（test/fixture/fixture.ts）。两处都有 finalizer，但：
// · Windows 上 rm 撞到未释放句柄（SQLite WAL、git 子进程、node_modules 链接）会
//   EBUSY/EPERM，自带的重试跑完仍可能失败；
// · **进程被超时杀掉、崩溃或 Ctrl-C 时 finalizer 根本不会跑** —— 这一类漏得最多。
//
// 实测后果：1565 个目录、40GB，从 2026-08-12 累到 08-28 无人知晓，最后把 C 盘写满。
// fixture 侧改成失败留痕只解决"知不知道"，不解决"清不清得掉"；这里是兜底。
//
// 形态对应 deepseek-harness 的 `implemented/architecture/2026-07-17-local-spill-startup-cleanup.md`
// （本地 spill 文件的启动期清理）。
import fs from "fs/promises"
import os from "os"
import path from "path"

export const PREFIX = "redcode-test"
const DEFAULT_TTL_HOURS = 2

export interface SweepResult {
  readonly removed: number
  readonly bytes: number
  /** 命中年龄条件但删不掉的（别人还占着、权限不足）—— 留给下一轮，不是错误。 */
  readonly skipped: number
}

async function directorySize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else if (entry.isFile()) total += await fs.stat(full).then((s) => s.size).catch(() => 0)
  }
  return total
}

/**
 * 删掉 `root` 下所有 `redcode-test*` 前缀、且 mtime 早于 `ttlHours` 的目录。
 *
 * **按 mtime 年龄过滤而不是按 pid**：并发跑的另一个测试进程的目录一定是新的，不会被
 * 误删；而按 pid 判活在 Windows 上不可靠（pid 会被回收）。
 *
 * 尽力而为：删不掉的留到下一轮，绝不抛 —— 清扫失败不该让测试跑不起来。
 */
export async function sweepStaleTestDirs(options?: { root?: string; ttlHours?: number }): Promise<SweepResult> {
  const root = options?.root ?? os.tmpdir()
  const ttlHours = options?.ttlHours ?? Number(process.env["REDCODE_TEST_TMP_TTL_HOURS"] ?? DEFAULT_TTL_HOURS)
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return { removed: 0, bytes: 0, skipped: 0 }

  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  let removed = 0
  let bytes = 0
  let skipped = 0

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue
    const full = path.join(root, entry.name)
    const stat = await fs.stat(full).catch(() => undefined)
    if (!stat || stat.mtimeMs >= cutoff) continue
    const size = await directorySize(full)
    const ok = await fs
      .rm(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      skipped++
      continue
    }
    removed++
    bytes += size
  }

  return { removed, bytes, skipped }
}
