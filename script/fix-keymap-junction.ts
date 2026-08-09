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
function detectTargetInstance(): string | undefined {
 const bunDir = join(ROOT, "node_modules", ".bun")
 // 260808 Red hoisted 布局（CI `bun install --linker hoisted`）没有 .bun 目录，
 // keymap 单实例平铺在 node_modules/@opentui/keymap，不存在双实例问题 → 跳过
 if (!existsSync(bunDir)) {
   console.log("[fix-keymap] no .bun dir (hoisted layout) — keymap is single instance, skip")
   return undefined
 }
 const all: Array<{ dir: string; version: string; solidReal?: string }> = []
 for (const name of readdirSync(bunDir)) {
   if (!name.startsWith("@opentui+keymap@")) continue
   const inst = join(bunDir, name, "node_modules", "@opentui", "keymap")
   if (!existsSync(inst)) continue
   let solidReal: string | undefined
   try {
     // realpathSync 一步到位：readlink 返回相对路径，手工 resolve 必须先拼所在目录，容易错
     solidReal = realpathSync(join(bunDir, name, "node_modules", "solid-js"))
   } catch {}
   all.push({ dir: inst, version: name.slice("@opentui+keymap@".length).split("+")[0]!, solidReal })
 }
 if (!all.length) {
   console.log("[fix-keymap] no keymap instance under .bun — nothing to fix, skip")
   return undefined
 }

 // 单实例无需消歧（全新 worktree 常态）。多实例时按 solid 同源筛：
 // 锚点依次试根/opencode 的 node_modules/solid-js（bun 的提升布局因树而异，
 // worktree 实测没有根级 solid-js），都没有则退到 .bun 里唯一的 solid 实例。
 // 260809 Red 锚点必须真实命中 .bun 实例才算数：hoisted 布局残留的根级真实
 // 目录（realpathSync 返回自身路径）匹配不到任何实例，误判为「有锚点」会
 // 让 matched 空、退化到 all[0] 选错实例 → junction 指向错误 solid → 运行时
 // createContext 身份对不上 → TUI 启动即崩 "Keymap not found"。
 let pool = all
 if (all.length > 1) {
   let anchor: string | undefined
   for (const p of [join(ROOT, "node_modules", "solid-js"), join(ROOT, "packages", "opencode", "node_modules", "solid-js")]) {
     try {
       const real = realpathSync(p)
       // 只有能匹配到至少一个 .bun 实例的锚点才有效，否则继续试下一个
       if (all.some((c) => c.solidReal === real)) {
         anchor = real
         break
       }
     } catch {}
   }
   if (!anchor) {
     const solids = readdirSync(bunDir).filter((n) => n.startsWith("solid-js@"))
     if (solids.length === 1) anchor = realpathSync(join(bunDir, solids[0]!, "node_modules", "solid-js"))
   }
   if (anchor) {
     const matched = all.filter((c) => c.solidReal === anchor)
     if (matched.length) pool = matched
   }
 }
  // 版本排序取最高的 0.2.x（catalog 钉的是 0.2.15；0.4.x 是并存的未启用实例）
  const wanted = pool.filter((c) => c.version.startsWith("0.2."))
  const final = wanted.length ? wanted : pool
  final.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  return final[0]!.dir
}

const TARGET_INSTANCE = detectTargetInstance()
if (TARGET_INSTANCE === undefined) process.exit(0)
console.log(`[fix-keymap] target: ${TARGET_INSTANCE.replace(ROOT, "<root>")}`)
// 需要统一指向的位置：opencode（运行时）与 plugin（SDK 类型链）
const LINKS = [
  join(ROOT, "packages/opencode/node_modules/@opentui/keymap"),
  join(ROOT, "packages/plugin/node_modules/@opentui/keymap"),
]

// 260806 Red 悬空 junction 陷阱：existsSync 会**顺着链接**判断，目标不存在时返回 false，
// 于是删除分支被跳过、symlinkSync 直接 EEXIST。全新 worktree 首装时必踩（旧 solid 实例
// 不存在，postinstall 建出的 junction 天生悬空）。判断"链接本身在不在"必须用 lstat。
function linkStat(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return undefined
  }
}

function isJunctionToTarget(p: string): boolean {
  const st = linkStat(p)
  if (!st?.isSymbolicLink()) return false
  return resolve(readlinkSync(p)) === resolve(TARGET_INSTANCE)
}

for (const link of LINKS) {
  // 已是正确 junction → 跳过（幂等）
  if (isJunctionToTarget(link)) {
    console.log(`[fix-keymap] ok: ${link}`)
    continue
  }
  const bak = `${link}.bak`
  const st = linkStat(link)
  if (st) {
    if (st.isSymbolicLink()) {
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
