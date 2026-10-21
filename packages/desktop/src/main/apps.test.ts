import { describe, expect, test } from "bun:test"
import { createWslPath } from "./apps"

const win32 = "win32" as NodeJS.Platform

describe("wslPath", () => {
  test("leaves paths alone outside windows and never spawns wsl", async () => {
    let calls = 0
    const wsl = createWslPath({
      platform: "linux",
      exec: async () => {
        calls += 1
        return "/mnt/c\n"
      },
    })
    expect(await wsl.path("C:\\x", "linux")).toBe("C:\\x")
    expect(await wsl.paths(["C:\\x"], "linux")).toEqual(["C:\\x"])
    expect(calls).toBe(0)
  })

  test("converts a windows path through wslpath", async () => {
    const seen: string[][] = []
    const wsl = createWslPath({
      platform: win32,
      exec: async (args) => {
        seen.push(args)
        return "/mnt/c/dir\n"
      },
    })
    expect(await wsl.path("C:\\dir", "linux")).toBe("/mnt/c/dir")
    expect(seen).toEqual([["-e", "wslpath", "-u", "C:\\dir"]])
  })

  test("expands a home path through the remote shell", async () => {
    const seen: string[][] = []
    const wsl = createWslPath({
      platform: win32,
      exec: async (args) => {
        seen.push(args)
        return "C:\\Users\\me\n"
      },
    })
    expect(await wsl.path("~/docs", "windows")).toBe("C:\\Users\\me")
    expect(seen[0]?.slice(0, 4)).toEqual(["-e", "sh", "-lc", 'wslpath -w "$HOME/docs"'])
  })

  // 261021 Red 审计 RC21-07：这条以前是 execFileSync，主进程事件循环会被整个卡住。
  // 现在等待转换期间定时器照常触发 —— 这就是「其他 IPC 仍能响应」的最小判据。
  test("a pending conversion does not block the event loop", async () => {
    let release!: (value: string) => void
    const wsl = createWslPath({
      platform: win32,
      exec: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    })

    const pending = wsl.path("C:\\slow", "linux")
    let ticked = false
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true
        resolve()
      }, 0),
    )
    expect(ticked).toBe(true)

    release("/mnt/c/slow\n")
    expect(await pending).toBe("/mnt/c/slow")
  })

  test("a timeout rejects with an actionable message", async () => {
    const wsl = createWslPath({
      platform: win32,
      timeoutMs: 5000,
      exec: async () => {
        throw new Error("Command failed: timeout 5000ms")
      },
    })

    await expect(wsl.path("C:\\x", "linux")).rejects.toThrow(/after 5000ms/)
    await expect(wsl.path("C:\\x", "linux")).rejects.toThrow(/wsl -l -v/)
  })

  test("converts many paths with a single wsl call", async () => {
    const seen: string[][] = []
    const wsl = createWslPath({
      platform: win32,
      exec: async (args) => {
        seen.push(args)
        return "/mnt/c/a\n/mnt/c/b\n"
      },
    })

    expect(await wsl.paths(["C:\\a", "C:\\b"], "linux")).toEqual(["/mnt/c/a", "/mnt/c/b"])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('for p in "$@"; do wslpath -u "$p"; done')
    expect(seen[0]?.slice(-2)).toEqual(["C:\\a", "C:\\b"])
  })

  test("rejects instead of misaligning results when the batch returns the wrong count", async () => {
    const wsl = createWslPath({
      platform: win32,
      exec: async () => "/mnt/c/a\n",
    })
    await expect(wsl.paths(["C:\\a", "C:\\b"], "linux")).rejects.toThrow(/expected 2/)
  })

  test("mixes home and literal paths without losing their positions", async () => {
    const calls: string[][] = []
    const wsl = createWslPath({
      platform: win32,
      exec: async (args) => {
        calls.push(args)
        // 单条 `~` 走 sh -lc 的四参数形式；批量是 sh -lc + script + $0 + 若干路径。
        return args.length === 4 ? "C:\\Users\\me\\docs\n" : "/mnt/c/b\n"
      },
    })

    expect(await wsl.paths(["C:\\b", "~/docs"], "linux")).toEqual(["/mnt/c/b", "C:\\Users\\me\\docs"])
    expect(calls).toHaveLength(2)
  })
})
