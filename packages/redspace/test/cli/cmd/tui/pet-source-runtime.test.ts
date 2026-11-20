import { expect, test } from "bun:test"
import { join } from "node:path"

// 261120 Red 桌宠入口不能加载第二份 Solid：TUI 锁 1.9.14，跨包引 ui/pet-store 会再拉起
// catalog 的 1.9.17，启动时打 duplicate-instances 警告。警告只在运行时初始化时打一次，
// 同进程的前序模块会让它失效，所以每个用例单起一个 Bun 子进程。
// 决策 → docs/plans/2026-11-20-redspace-tui-solid-fix.md
test(
  "tui pet source loads a single Solid runtime",
  async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "--conditions=development",
        "-e",
        "await import('./src/cli/cmd/tui/pet-source.tsx'); console.log('IMPORT_OK')",
      ],
      { cwd: join(import.meta.dir, "../../../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).not.toContain("multiple instances of Solid")
    expect(stdout).toContain("IMPORT_OK")
    expect(code).toBe(0)
  },
  30_000,
)
