/**
 * sync-home-scripts 的前置闸门：拦住「home 有、seed 没有」的孤儿脚本。
 *
 * 背景：sync-home-scripts.bat 是**真镜像**——先 `rd /s /q ~/.redcode/scripts` 再从
 * seed/scripts 铺回来。而私仓的 .gitignore 从 260816 起忽略了 scripts/（权威移到公仓 seed）。
 * 两条叠起来的后果是：任何人往 home 写个脚本却没同步进 seed，下一次 build 就静默抹掉，
 * git 也不会吭一声。260901 那次 hooks/pre-commit 被反复抹掉正是这个形态。
 *
 * 所以在 rd 之前先比对：发现孤儿就中止并列出来，把「静默丢失」变成「build 报错」。
 * 逃生口 REDCODE_SYNC_SCRIPTS_FORCE=1 —— 明知要丢也要继续时用（例如确认那些文件是垃圾）。
 */
import fs from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dir, "..")
const SEED = path.join(REPO, "seed", "scripts")
const HOME = path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".redcode", "scripts")

function walk(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else out.push(path.relative(root, full).split(path.sep).join("/"))
    }
  }
  return out
}

// home 不存在 = 首次同步，没有可丢的东西
if (!fs.existsSync(HOME)) process.exit(0)

const seed = new Set(walk(SEED))
const orphans = walk(HOME)
  .filter((rel) => !seed.has(rel))
  .sort()

if (orphans.length === 0) process.exit(0)

const force = process.env["REDCODE_SYNC_SCRIPTS_FORCE"] === "1"
const label = force ? "[sync-scripts] 警告" : "[sync-scripts] 已中止"
console.error(`${label}：${HOME} 下有 ${orphans.length} 个文件在 seed/scripts 里没有对应源，`)
console.error(`镜像会先 rd 整个目录，这些文件将永久丢失（scripts/ 在私仓被 gitignore，git 不会留底）：`)
for (const rel of orphans) console.error(`    ${rel}`)
console.error("")
if (force) {
  console.error("REDCODE_SYNC_SCRIPTS_FORCE=1 已设置，继续镜像。")
  process.exit(0)
}
console.error("处理方式三选一：")
console.error(`  1. 要留 → 复制进 ${path.relative(REPO, SEED).split(path.sep).join("/")}/ 并提交，seed 是唯一权威`)
console.error("  2. 是垃圾 → 手动删掉 home 里那几个文件，再重跑")
console.error("  3. 明知要丢 → set REDCODE_SYNC_SCRIPTS_FORCE=1 后重跑")
process.exit(1)
