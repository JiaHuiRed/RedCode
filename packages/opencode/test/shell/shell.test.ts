import { describe, expect, test } from "bun:test"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { which } from "../../src/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("redcode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("redcode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(Filesystem.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })

    // 261010 Red 双 Shell 显式选择（Phase 1）
    test("pick resolves Git Bash and never degrades powershell to 5.1", () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.pick("bash")).toBe(bash)
      const picked = Shell.pick("powershell")
      if (!picked) return
      expect(Shell.name(picked)).toBe("pwsh")
    })

    test("choose prefers explicit param over agentDefault over fallback", () => {
      const fallback = Shell.acceptable()
      const bash = Shell.gitbash()

      // 缺省参数走 agentDefault；agentDefault 缺省/legacy 走工具默认
      const viaDefault = Shell.choose(undefined, "git-bash", fallback)
      if (bash) expect(viaDefault).toBe(bash)
      else expect(viaDefault).toBeUndefined()
      expect(Shell.choose("default", "git-bash", fallback)).toBe(viaDefault)
      expect(Shell.choose(undefined, "legacy", fallback)).toBe(fallback)
      expect(Shell.choose(undefined, undefined, fallback)).toBe(fallback)

      // 显式参数优先于 agentDefault；解析不到时返回 undefined（调用方报错），绝不静默降级
      if (bash) {
        expect(Shell.choose("bash", "legacy", fallback)).toBe(bash)
        expect(Shell.choose("bash", undefined, fallback)).toBe(bash)
      }
      const pwsh = Shell.pick("powershell")
      if (bash && pwsh) {
        expect(Shell.name(Shell.choose("bash", "powershell", fallback)!)).toBe("bash")
        expect(Shell.name(Shell.choose("powershell", "git-bash", fallback)!)).toBe("pwsh")
      }
    })
  }
})
