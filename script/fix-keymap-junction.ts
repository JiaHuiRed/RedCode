// 260802 Red fix-keymap-junction
// @opentui/keymap 双 hash 实例修复：bun 对同一版本在不同 workspace 的
// peer 解析上下文不同，会实例化成两个 hash 目录（opencode→77dde1de，
// plugin→0d7da94b），TS 类型（#private 成员）互不兼容导致 typecheck 挂。
// 统一两个 workspace 位置都指向 77dde1de 实例。幂等，可反复执行。
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
// bun 的 keymap 实例目录（77dde1de 为 TUI/opencode 解析的实例）
const TARGET_INSTANCE = join(
  ROOT,
  "node_modules/.bun/@opentui+keymap@0.2.15+77dde1de2a06b7f4/node_modules/@opentui/keymap",
)
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
      // 指向错误实例的 junction → 删掉重建
      rmSync(link)
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
