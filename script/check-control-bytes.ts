// 260821 cc 源文件裸控制字节自检
//
// 不变量：git 跟踪的非二进制文件里不得出现裸的 C0 控制字节（制表/换行/回车除外）。
//
// 由来见 cc086f83 —— permission/index.ts 拿 NUL 当复合 map key 的分隔符，选得没错，
// 但写下去的时候本意是转义序列，落盘成了裸字节 0x00。危害整个在运行时之外：file(1)
// 把该文件报成 data，grep 与 ripgrep 判二进制直接静默跳过、只吐一句
// "Binary file ... matches" 而不给行号——于是一个权限审批模块对全仓代码搜索完全隐身，
// 而且没有任何征兆，代码照跑，测试照过。
//
// 修的时候顺手全仓扫了一遍，又捞出 CHANGELOG.md 里一个把正则反向引用 `\1` 写成裸
// 0x01 的字节。同一类手滑（转义序列落成了裸字节），只是没到隐身的程度。所以这条闸门
// 收的是整个 C0 族，不是只收 NUL。
//
// 两级分开报：只有 NUL 会触发 grep/ripgrep 的二进制判定，那是真正的隐身；其余控制
// 字节是"转义序列写成了裸字节"的正文损坏，改法一样（改回转义写法）但危害不同。
//
// 例外必须显式豁免：写进下面的 EXEMPT，带路径带理由。不留沉默通道——一份日志抓的就
// 是带 ANSI 的终端输出，那是内容本身，但它得在名单上写明白，而不是靠扫描器猜。
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** 路径 → 豁免理由。理由为空视为没写，一样报错。 */
const EXEMPT: Record<string, string> = {
  "packages/storybook/debug-storybook.log":
    "抓下来的 storybook 终端输出，0x1b 是 ANSI 颜色码，是这份日志的内容本身而不是手滑",
}

// 二进制资产按扩展名跳过。这里刻意用**黑名单**而不是白名单：漏登记一种二进制格式
// 只会让 push 响一次、加一行就好；而白名单漏掉一种源码扩展名，是静默不检——正是这条
// 闸门要防的那种失败。宁可吵。
const BINARY = new Set(
  (
    "png jpg jpeg gif ico icns bmp tif tiff webp avif " +
    "woff woff2 ttf otf eot " +
    "mp3 mp4 aac wav ogg oga webm mov m4a flac " +
    "zip gz tgz bz2 xz 7z rar tar " +
    "pdf " +
    "exe dll so dylib node wasm bin dat " +
    "db sqlite sqlite3 lockb " +
    "class jar pyc pyd " +
    "keystore jks p12 pfx"
  ).split(" "),
)

const ALLOWED = new Set([0x09, 0x0a, 0x0d]) // tab / LF / CR

/** 返回缓冲区里全部裸控制字节的位置。真文件与自检走的是同一个函数。 */
function findControlBytes(buf: Uint8Array): Array<{ offset: number; byte: number }> {
  const out: Array<{ offset: number; byte: number }> = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!
    if (b === 0x7f || (b < 0x20 && !ALLOWED.has(b))) out.push({ offset: i, byte: b })
  }
  return out
}

const hex = (b: number) => "0x" + b.toString(16).padStart(2, "0")

/** 按字节偏移定位到行列，并把该行的控制字节换成可见标记后截一段上下文。 */
function locate(buf: Uint8Array, offset: number) {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++
      lineStart = i + 1
    }
  }
  let lineEnd = offset
  while (lineEnd < buf.length && buf[lineEnd] !== 0x0a) lineEnd++
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(lineStart, lineEnd))
  const column = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(lineStart, offset)).length + 1
  const visible = [...text]
    .map((c) => {
      const code = c.charCodeAt(0)
      return code === 0x7f || (code < 0x20 && !ALLOWED.has(code)) ? "<" + hex(code) + ">" : c
    })
    .join("")
  const from = Math.max(0, column - 40)
  const snippet = (from > 0 ? "…" : "") + visible.slice(from, from + 100).trim() + (visible.length > from + 100 ? "…" : "")
  return { line, column, snippet }
}

// ── 自检 1：检测器必须真的会响。构造一段含 NUL 与 0x01 的缓冲区走同一个函数，
// 一个都不报说明扫描逻辑已经坏掉，此时"全仓干净"是假消息。
{
  const probe = new TextEncoder().encode("ok\tline\nmid")
  const withCtrl = new Uint8Array([...probe, 0x00, 0x41, 0x01])
  const found = findControlBytes(withCtrl)
  const clean = findControlBytes(probe)
  if (found.length !== 2 || found[0]!.byte !== 0x00 || found[1]!.byte !== 0x01 || clean.length !== 0) {
    console.error("check-control-bytes: 自检失败——检测器对已知样本不响（或对干净样本误报）。")
    console.error("  期望 [0x00, 0x01]，实得 " + JSON.stringify(found.map((f) => hex(f.byte))))
    console.error("  修检测器，别改自检。")
    process.exit(1)
  }
}

// ── 枚举：走 git ls-files 而不是遍历文件系统。它给的正是"会被推上去的那一组"，
// 且跟 .gitignore 不会失配。git 挂了就报错退出，不退化成扫本地目录——那样会把
// 一次失效读成一次通过。
const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, timeout: 30000 })
if (ls.exitCode !== 0) {
  console.error("check-control-bytes: git ls-files 失败（exitCode=" + ls.exitCode + "），无法确定要扫哪些文件。")
  console.error(new TextDecoder().decode(ls.stderr).trim())
  process.exit(1)
}
const tracked = new TextDecoder().decode(ls.stdout).split("\0").filter(Boolean)
if (tracked.length === 0) {
  console.error("check-control-bytes: git ls-files 一个文件都没返回——检测失效了，不是仓库干净")
  process.exit(1)
}

const extOf = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

type Violation = { path: string; line: number; column: number; byte: number; snippet: string }
const nul: Violation[] = []
const other: Violation[] = []
const bulk: string[] = []
const hitPaths = new Set<string>()
let scanned = 0
let unreadable = 0

for (const path of tracked) {
  if (BINARY.has(extOf(path))) continue
  let buf: Uint8Array
  try {
    buf = readFileSync(join(root, path))
  } catch {
    unreadable++ // 已从工作区删除但仍在索引里，没内容可扫
    continue
  }
  scanned++
  const found = findControlBytes(buf)
  if (found.length === 0) continue
  hitPaths.add(path)
  if (EXEMPT[path]?.trim()) continue

  // 一个文件里几十处控制字节，几乎一定是没登记扩展名的二进制资产，而不是几十次手滑。
  if (found.length > 20) {
    bulk.push(path + "  " + found.length + " 处控制字节")
    continue
  }
  for (const f of found) {
    const at = locate(buf, f.offset)
    const v = { path, byte: f.byte, ...at }
    ;(f.byte === 0x00 ? nul : other).push(v)
  }
}

// ── 自检 2：扫到的文件数明显偏低说明枚举或过滤出了问题（跑错目录、黑名单吃掉一切）。
// 现仓约 4000 个非二进制文件，500 是留足余量的绊线，不是容量规划。
if (scanned < 500) {
  console.error("check-control-bytes: 只扫到 " + scanned + " 个文件，明显偏低——枚举或扩展名过滤坏了，不是仓库干净")
  process.exit(1)
}

// ── 自检 3：豁免名单不能烂在这。文件已经改干净或已删除，条目就得跟着删，
// 否则它会一直替将来某次真回归背书。
const stale = Object.keys(EXEMPT).filter((path) => !hitPaths.has(path))
if (stale.length) {
  console.error("check-control-bytes: 下列豁免条目已经没有对应的控制字节（文件改干净了或已删除）：")
  for (const path of stale) console.error("  " + path)
  console.error("")
  console.error("  把它们从 script/check-control-bytes.ts 的 EXEMPT 里删掉。过期的豁免会替将来的真回归背书。")
  process.exit(1)
}

if (bulk.length) {
  console.error("check-control-bytes: 下列文件含大量控制字节，看着像没登记的二进制资产：")
  for (const b of bulk) console.error("  " + b)
  console.error("")
  console.error("  若确实是二进制，把扩展名加进 script/check-control-bytes.ts 的 BINARY。")
  process.exit(1)
}

if (nul.length || other.length) {
  if (nul.length) {
    console.error("check-control-bytes: " + nul.length + " 处裸 NUL 字节（0x00）：")
    for (const v of nul) console.error("  " + v.path + ":" + v.line + ":" + v.column + "  " + v.snippet)
    console.error("")
    console.error("  裸 NUL 会让 file(1) 把文件报成 data、grep/ripgrep 判二进制直接静默跳过，")
    console.error("  只吐 \"Binary file ... matches\" 不给行号——这个文件对全仓代码搜索就此隐身。")
  }
  if (other.length) {
    if (nul.length) console.error("")
    console.error("check-control-bytes: " + other.length + " 处裸控制字节：")
    for (const v of other) console.error("  " + v.path + ":" + v.line + ":" + v.column + "  " + hex(v.byte) + "  " + v.snippet)
    console.error("")
    console.error("  多半是转义序列写成了裸字节（本意 \\1 落成 0x01 那种），正文已经损坏。")
  }
  console.error("")
  console.error("  改回转义写法即可，语义不变；真属例外就写进 EXEMPT 并说明理由。")
  process.exit(1)
}

console.log(
  "check-control-bytes: " +
    scanned +
    " 个非二进制文件无裸控制字节（跟踪 " +
    tracked.length +
    " 个，豁免 " +
    Object.keys(EXEMPT).length +
    " 个" +
    (unreadable ? "，跳过 " + unreadable + " 个已删除" : "") +
    "）",
)
