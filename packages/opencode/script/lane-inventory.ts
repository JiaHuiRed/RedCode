// 260929 Red 列出 test/ 下的「进程绑定」测试文件（写 process.env / 碰 XDG|REDCODE_DB 等
// 全局态的文件）。bun test 没有 exclude，全部 *.test.ts 单进程顺序跑，这些文件与全局状态
// 耦合，排查测试污染或考虑拆 lane 前先跑这个拿最新清单——清单会漂移，别靠记忆。
// 当前 bun test 是单 lane（bun run test），物理拆分未做：41/308 文件写 env、无真实炸点，
// 拆分成本 > 收益；本脚本是「随时可重新生成」的清单，配合根 AGENTS.md「测试 lane」表使用。
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const testDir = join(import.meta.dir, "..", "test")
// 宽松匹配（OR 语义），宁可多列：这是清单不是门禁。
const pattern =
  /process\.env\[[^\]]+\]\s*=|process\.env\.[A-Z_]+\s*=|XDG_[A-Z_]+|REDCODE_DB\s*=|Object\.assign\(process\.env/

const hits: string[] = []
function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!entry.name.endsWith(".test.ts")) continue
    if (pattern.test(readFileSync(path, "utf8"))) {
      hits.push(relative(testDir, path).replaceAll("\\", "/"))
    }
  }
}
walk(testDir)
hits.sort()

console.log(`process-bound test files (${hits.length}):`)
for (const hit of hits) console.log(`  ${hit}`)
