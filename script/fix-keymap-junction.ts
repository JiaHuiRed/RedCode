// 260802 Red fix-keymap-junction
// @opentui/keymap 双 hash 实例修复：bun 对同一版本在不同 workspace 的
// peer 解析上下文不同，会实例化成两个 hash 目录（opencode→77dde1de，
// plugin→0d7da94b），TS 类型（#private 成员）互不兼容导致 typecheck 挂。
// 统一两个 workspace 位置都指向 77dde1de 实例。幂等，可反复执行。
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

// 260806 Red 目标实例不再写死 hash，改为运行时探测。
// 教训：hash 后缀是 bun 按 peer 解析上下文算的，260806 只是把 catalog 的 solid-js
// 1.9.13→1.9.14，keymap 就实例化出了新 hash（45062d8c），而这里还钉着旧的
// 77dde1de（绑 1.9.13）。两份 solid 不同源 → createContext 身份对不上 →
// 终端跑源码的 TUI 启动即崩 "Keymap not found"（编译产物不受影响，依赖已打包）。
// 探测规则：在 .bun 里找 keymap 实例，其内嵌 solid-js 链接与仓库根解析到的
// solid-js 实例一致 —— 那就是当前 peer 上下文的正解。多个匹配取版本最高的 0.2.x。
function detectTargetInstance(): string {
  const bunDir = join(ROOT, "node_modules", ".bun")
  // realpathSync 一步到位：readlink 返回的是相对路径，手工 resolve 必须先拼所在目录，容易错
  const rootSolidReal = realpathSync(join(ROOT, "node_modules", "solid-js"))
  const candidates: Array<{ dir: string; version: string }> = []
  for (const name of readdirSync(bunDir)) {
    if (!name.startsWith("@opentui+keymap@")) continue
    const inst = join(bunDir, name, "node_modules", "@opentui", "keymap")
    if (!existsSync(inst)) continue
    const solidLink = join(bunDir, name, "node_modules", "solid-js")
    if (!existsSync(solidLink)) continue
    let solidReal: string
    try {
      solidReal = realpathSync(solidLink)
    } catch {
      continue
    }
    if (solidReal !== rootSolidReal) continue
    candidates.push({ dir: inst, version: name.slice("@opentui+keymap@".length).split("+")[0]! })
  }
  if (!candidates.length) throw new Error("[fix-keymap] no keymap instance matches the workspace solid-js — run bun install first")
  // 版本排序取最高的 0.2.x（catalog 钉的是 0.2.15；0.4.x 是并存的未启用实例）
  const wanted = candidates.filter((c) => c.version.startsWith("0.2."))
  const pool = wanted.length ? wanted : candidates
  pool.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  return pool[0]!.dir
}

const TARGET_INSTANCE = detectTargetInstance()
console.log(`[fix-keymap] target: ${TARGET_INSTANCE.replace(ROOT, "<root>")}`)
// 需要统一指向的位置：opencode（运行时）与 plugin（SDK 类型链）
const LINKS = [
  join(ROOT, "packages/opencode/node_modules/@opentui/keymap"),
  join(ROOT, "packages/plugin/node_modules/@opentui/keymap"),
]

function isJunctionToTarget(p: string): boolean {
  if (!existsSync(p)) return false
  const st = lstatSync(p)
  if (!st.isSymbolicLink()) return false
  return resolve(readlinkSync(p)) === resolve(TARGET_INSTANCE)
}

for (const link of LINKS) {
  // 已是正确 junction → 跳过（幂等）
  if (isJunctionToTarget(link)) {
    console.log(`[fix-keymap] ok: ${link}`)
    continue
  }
  const bak = `${link}.bak`
  if (existsSync(link)) {
    if (lstatSync(link).isSymbolicLink()) {
      // 指向错误实例的 junction → 摘掉链接本身，重建
      // 260806 Red rmSync(link) 在 Windows 上删目录型 junction 会 EFAULT（bun 1.3.14 实测），
      // postinstall 因此整个失败 → 任何 bun install/update 都写不进 package.json（升依赖时撞到）。
      // 先试 unlink（POSIX 符号链接），失败再退 rmdir（Windows junction），两者都只摘链接不碰目标。
      // 绝不能改成 rmSync(link, { recursive: true })：那会顺着 junction 把目标实例的内容一并删掉。
      try {
        unlinkSync(link)
      } catch {
        rmdirSync(link)
      }
    } else if (existsSync(bak)) {
      // 真实目录 + 已有 .bak → 直接删目录（bun install 可再生成）
      rmSync(link, { recursive: true })
    } else {
      // 真实目录 → 改名 .bak 保留，再建 junction
      renameSync(link, bak)
    }
  }
  symlinkSync(TARGET_INSTANCE, link, "junction")
  console.log(`[fix-keymap] relinked: ${link} -> ${TARGET_INSTANCE}`)
}
