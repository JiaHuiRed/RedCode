import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@redcode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "redcode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  // 260811 cc audit Y8：root/config/data/state 曾在模块加载时用 os.homedir() 硬算成常量，
  // 只有 home getter 认 REDCODE_TEST_HOME —— 于是设了隔离变量的测试进程照样把真实
  // ~/.redcode 当配置目录读写（07-30、08-10 两次洗掉 live 配置的根因，08-11 又实证
  // httpapi 门禁把 username 写进了用户的 redcode.jsonc）。这条钉住"所有路径派生自
  // Path.home"，谁再把它改回常量就红。
  test("every path derives from Path.home so REDCODE_TEST_HOME isolates fully", () => {
    const root = path.join(Global.Path.home, ".redcode")
    // config 与 log 允许测试直接赋值重定向（见 global.ts 注释），未赋值时同样派生自 home
    for (const key of ["data", "cache", "config", "state", "bin", "log", "repos"] as const) {
      expect(Global.Path[key].startsWith(root)).toBe(true)
    }
  })

  test("Global.make() snapshots the same isolated paths as Path", () => {
    const made = Global.make()
    for (const key of ["home", "data", "cache", "state", "bin", "log", "repos"] as const) {
      expect(made[key]).toBe(Global.Path[key])
    }
  })
})
