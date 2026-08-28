// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// 260828 cc 启动期清扫陈旧的测试临时目录。理由与判据见 test/lib/sweep-temp.ts ——
// 简言之：进程被超时杀掉/崩溃时 finalizer 根本不会跑，那一类漏得最多，只能靠兜底扫。
// `REDCODE_TEST_TMP_TTL_HOURS=0` 可关掉。
const { sweepStaleTestDirs } = await import("./lib/sweep-temp")
const swept = await sweepStaleTestDirs()
if (swept.removed > 0) {
  console.warn(
    `[preload] swept ${swept.removed} stale test temp dir(s), ${(swept.bytes / 1024 / 1024).toFixed(0)} MB` +
      (swept.skipped > 0 ? ` (${swept.skipped} still in use, left for a later run)` : ""),
  )
}

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "redcode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { Database } = await import("../src/storage/db")
  Database.close()
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1) throw error
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["REDCODE_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
// 260827 cc: 目录已经钉在上面那份 fixture 上，可 ModelsDev 层每次构建仍会 forkScoped 一个
// 后台 refresh 去真拉 models.dev（~3MB）—— 对测试是纯死工作，还制造了"第二个用例必挂"：
// 第一个用例结束时 afterEach 的 disposeAllInstances() 首次建起整个 AppLayer，它那份 ModelsDev
// 抢到 models-dev 的 flock 开始下载，而 AppRuntime 全程不 dispose；第二个用例自己的 ModelsDev
// 于是堵在 Flock.effect 上，而 acquireRelease 的 acquire 段不可中断 —— 它的 layer scope 关不掉，
// 用例被拖满整个下载时长（实测 4-9s），默认 5000ms 超时下必红，且与用例内容无关（谁排第二谁挂）。
// test/lib/cli-process.ts 给子进程早就设了这个变量，进程内跑的测试一直漏了。
process.env["REDCODE_DISABLE_MODELS_FETCH"] = "1"
process.env["REDCODE_EXPERIMENTAL_WORKSPACES"] = "true"
// 260828 cc 测试里不要真的 npm install。那步是分离 fiber，比临时目录的 finalizer 活得
// 长：finalizer 删完之后 npm 又把 .redcode/node_modules 写回来，于是留下一个 38MB 的
// 目录且**没有任何告警**（clean() 当时确实删成功了）。实测一轮会话攒出 177 个、6.5GB。
process.env["REDCODE_DISABLE_PLUGIN_DEP_INSTALL"] = "1"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["REDCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["REDCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "redcode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["REDCODE_SERVER_PASSWORD"]
delete process.env["REDCODE_SERVER_USERNAME"]

// Use in-memory sqlite
process.env["REDCODE_DB"] = ":memory:"

// Now safe to import from src/
const { Log } = await import("@redcode-ai/core/util/log")
const { initProjectors } = await import("../src/server/projectors")

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()
