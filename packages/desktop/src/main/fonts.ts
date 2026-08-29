import { execFile } from "node:child_process"
import util from "node:util"

const execFilePromise = util.promisify(execFile)

// 260829 Red 设置面板字体下拉：枚举本机已安装字体，读系统而非浏览器，拿到的名字一定能直接用
const REG_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
]

// 粗体/斜体由浏览器合成，注册表里它们跟正体是同一 family 的不同条目
const SYNTHETIC = /\s(bold|italic|oblique)$/i

let cache: Promise<string[]> | undefined

export function listFonts() {
  cache ??= enumerate().catch((error) => {
    cache = undefined
    throw error
  })
  return cache
}

function enumerate() {
  if (process.platform === "win32") return windows()
  if (process.platform === "darwin") return macos()
  return linux()
}

async function windows() {
  const entries: string[] = []
  for (const key of REG_KEYS) {
    const output = await run("reg", ["query", key])
    for (const line of output.split("\n")) {
      const match = line.match(/^\s{2,}(.+?)\s+REG_SZ\s+/)
      if (match) entries.push(match[1])
    }
  }
  // 一个字体文件可能承载多个 family，注册表用 & 分隔（"SimSun & NSimSun"）；
  // 逗号则是位图字体的尺寸表（"Courier 10,12,15"），不是分隔符，整条丢掉
  return sorted(clean(entries.flatMap((entry) => entry.split("&"))))
}

async function macos() {
  const output = await run("system_profiler", ["-json", "SPFontsDataType"])
  if (!output) return []
  const data = JSON.parse(output) as { SPFontsDataType?: { _items?: { family?: string }[] }[] }
  const families = (data.SPFontsDataType ?? []).flatMap((group) => group._items ?? [])
  return sorted(clean(families.map((item) => item.family ?? "")))
}

async function linux() {
  const output = await run("fc-list", ["--format", "%{family[0]}\n"])
  return sorted(clean(output.split("\n").flatMap((line) => line.split(","))))
}

const clean = (parts: string[]) =>
  parts
    .map((part) => part.replace(/\s*\((TrueType|OpenType|All res|Version [^)]*)\)\s*$/i, "").trim())
    .filter(
      (name) =>
        name.length > 0 &&
        !name.startsWith("@") && // @ 前缀 = 竖排字体
        !name.includes(",") &&
        !SYNTHETIC.test(name),
    )

const sorted = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b))

async function run(cmd: string, args: string[]) {
  const { stdout } = await execFilePromise(cmd, args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  }).catch(() => ({ stdout: Buffer.alloc(0) }))
  // 中文 Windows 上 reg.exe 按控制台代码页输出，utf8 解会出乱码
  return new TextDecoder(process.platform === "win32" ? "gbk" : "utf8").decode(stdout)
}
