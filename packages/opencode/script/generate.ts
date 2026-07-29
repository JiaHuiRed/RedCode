import path from "path"
import os from "os"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.REDCODE_MODELS_URL || "https://models.dev"

// 260728 Red models.dev 在国内直连不通（实测 12s 无响应；走本机 7897 代理才 200）。
// git 有自己的 http.proxy 配置，bun 的 fetch 只认 HTTPS_PROXY 环境变量 —— 只给 git 配过代理的
// 机器上，push 能通但 build 必挂，且错误信息（ConnectionRefused）完全看不出是代理问题。
// 这里 fetch 到的快照会烤进二进制（build.ts 的 REDCODE_MODELS_DEV），所以回退必须挑明：
// 悄悄用过期缓存 = 悄悄发布带着旧定价/旧上下文上限/旧能力位的版本。
//
// 回退只在"默认源 + 非 CI + 缓存确实存在"三个条件同时成立时发生，并且必然打 warning。
// 显式指定了 REDCODE_MODELS_URL 就不回退：那份缓存是默认源的，混用等于拿错数据。
const CACHE_FILE = path.join(os.homedir(), ".redcode", "cache", "models.json") // 同 core/src/global.ts

// 260729 Red 自动沿用 git 的代理配置。上面那条注释说的"只给 git 配过代理的机器 build 必挂"
// 是本机的实际状态，而让用户每次构建都记得 set HTTPS_PROXY 是不现实的。既然 git 已经配好了
// 能用的代理，直接拿来用：bun 的 fetch 支持 { proxy } 选项，不依赖环境变量。
// 只读不写，不碰用户的 git 配置。
function gitProxy(): string | undefined {
  for (const key of ["https.proxy", "http.proxy"]) {
    try {
      const value = execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      if (value) return value
    } catch {
      // 没配这一项，或者根本没有 git —— 都不是错误，继续试下一个
    }
  }
  return undefined
}

// 代理路径实测慢（本机走 7897 拉这 1.2MB 要 20s 上下），给足超时，别让它半路断掉又回退到缓存
const FETCH_TIMEOUT_MS = 90_000

async function fetchModels(url: string): Promise<string> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((x) => x.text())
  } catch (error) {
    // HTTPS_PROXY/HTTP_PROXY 已设时 bun 会自动走，走到这儿说明要么没设、要么设了也不通。
    // 此时再试一次 git 配的代理 —— 这是绝大多数"push 能通 build 不通"机器的解。
    const proxy = gitProxy()
    if (!proxy) throw error
    console.log(`  models.dev 直连失败，改走 git 配置的代理 ${proxy} 重试…`)
    return await fetch(url, { proxy, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((x) => x.text())
  }
}

async function load(): Promise<string> {
  if (process.env.MODELS_DEV_API_JSON) {
    return await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  }

  try {
    return await fetchModels(`${modelsUrl}/api.json`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    if (process.env.REDCODE_MODELS_URL) {
      throw new Error(
        `Failed to fetch ${modelsUrl}/api.json (${reason}). REDCODE_MODELS_URL is set, so the ` +
          `models.dev cache is NOT used as a fallback — it belongs to a different source. ` +
          `Fix connectivity, or point MODELS_DEV_API_JSON at a snapshot of your own source.`,
      )
    }

    if (process.env.CI) {
      throw new Error(
        `Failed to fetch ${modelsUrl}/api.json (${reason}). Refusing to fall back to a local ` +
          `cache in CI — a release build must not silently bake in stale model data.`,
      )
    }

    const cache = Bun.file(CACHE_FILE)
    if (!(await cache.exists())) {
      throw new Error(
        `Failed to fetch ${modelsUrl}/api.json (${reason}), and no local cache at ${CACHE_FILE}. ` +
          `If this machine reaches the internet through a proxy, note that bun's fetch reads ` +
          `HTTPS_PROXY/HTTP_PROXY — git's http.proxy config does not apply here. ` +
          `Otherwise run \`redcode models\` on a connected machine and pass the snapshot via ` +
          `MODELS_DEV_API_JSON.`,
      )
    }

    const ageHours = (Date.now() - cache.lastModified) / 3_600_000
    const age = ageHours < 48 ? `${ageHours.toFixed(1)}h` : `${(ageHours / 24).toFixed(1)}d`
    console.warn(
      [
        "",
        "  ##############################################################",
        "  #  WARNING: models.dev unreachable — using STALE local cache  #",
        "  ##############################################################",
        `  reason : ${reason}`,
        `  cache  : ${CACHE_FILE}`,
        `  age    : ${age} old`,
        "",
        "  This snapshot is baked into the binary. Pricing, context limits and",
        "  capability flags will be as of the timestamp above, not current.",
        "  Do NOT ship a release built this way — refresh with `redcode models`,",
        "  or set HTTPS_PROXY if this machine needs a proxy to reach the internet.",
        "",
      ].join("\n"),
    )
    return await cache.text()
  }
}

export const modelsData = await load()
console.log("Loaded models.dev snapshot")
