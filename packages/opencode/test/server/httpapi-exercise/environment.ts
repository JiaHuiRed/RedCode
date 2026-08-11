import { Flag } from "@redcode-ai/core/flag/flag"
import { Effect } from "effect"
import { copyFileSync, existsSync, mkdirSync } from "fs"
import os from "os"
import path from "path"

// 260811 cc audit Y8 续：本文件此前只设 XDG_*，而 RedCode 自 260613 统一到 ~/.redcode
// 之后，源码里没有任何一处读 XDG_* —— 门禁的"隔离"从那天起就是装饰，Global.Path.config
// 实际解析到开发者真实的 ~/.redcode。08-11 实证：门禁把 username:"httpapi-global" 写进了
// 用户 live 配置，还把本地层的 provider.ollama 回写全局层（updateGlobal 整文件覆写合并结果）。
// 真正生效的隔离变量是 REDCODE_TEST_HOME（core/global.ts 的 home 从它派生）。
// XDG_* 保留：DCP 插件有自己的 XDG 解析，它认这几个。
const preserveExerciseGlobalRoot = !!process.env.REDCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.REDCODE_HTTPAPI_EXERCISE_GLOBAL ??
  // 原来写死 "/tmp"：Windows 上解析成"当前盘根目录\tmp"，仓库在 E 盘时落到 E:\tmp
  // （跨盘路径 bug 家族的又一例，同 f2bdd49）。
  path.join(process.env.TMPDIR ?? os.tmpdir(), `redcode-httpapi-global-${process.pid}`)

const exerciseHome = path.join(exerciseGlobalRoot, "home")
process.env.REDCODE_TEST_HOME = exerciseHome
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.REDCODE_DISABLE_SHARE = "true"

// 与 core/global.ts 的布局对齐：home/.redcode 是配置根，data 在其下。
// 场景断言直接读这两个目录，所以它们必须和服务端真正写入的路径是同一处——
// 对不齐就会出现"服务端写别处、断言读隔离目录"的假绿（本文件历史上正是如此）。
export const exerciseConfigDirectory = path.join(exerciseHome, ".redcode")
export const exerciseDataDirectory = path.join(exerciseConfigDirectory, "data")

// 工具二进制缓存单独放行：隔离后 Global.Path.bin 是空的，而 ripgrep 的查找顺序是
// PATH → Path.bin → 去 GitHub 下载。本机 PATH 里没有 rg，于是 find.files/find.text
// 两个场景每跑一次就下一个 4MB 二进制，30s 超时打红。这里从真实缓存**单向复制**一份
// （只读真实目录，绝不写回），配置/数据的隔离不受影响；缓存缺失就退回下载，CI 上行为不变。
const realBin = path.join(os.homedir(), ".redcode", "cache", "bin")
const isolatedBin = path.join(exerciseConfigDirectory, "cache", "bin")
const rg = process.platform === "win32" ? "rg.exe" : "rg"
if (existsSync(path.join(realBin, rg))) {
  mkdirSync(isolatedBin, { recursive: true })
  copyFileSync(path.join(realBin, rg), path.join(isolatedBin, rg))
}

const preserveExerciseDatabase = !!process.env.REDCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.REDCODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? os.tmpdir(), `redcode-httpapi-exercise-${process.pid}.db`)
process.env.REDCODE_DB = exerciseDatabasePath
Flag.REDCODE_DB = exerciseDatabasePath

export const original = {
  REDCODE_SERVER_PASSWORD: Flag.REDCODE_SERVER_PASSWORD,
  REDCODE_SERVER_USERNAME: Flag.REDCODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
