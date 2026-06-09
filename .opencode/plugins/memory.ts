import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

// 260609 Red CORE 铁律每轮注入 —— 从 ~/.redcode/AGENTS.md 抽 <!-- CORE:START/END --> 块，
// 追加到 system[] 末尾（最高 recency，弱模型也吃得住，治"规则被埋"）。
// 公开仓机制无个人痕迹：无标记 / 无文件即 no-op，新用户自行在私有 AGENTS.md 加标记才生效。
const AGENTS_PATH = path.join(os.homedir(), ".redcode", "AGENTS.md")
const CORE_RE = /<!--\s*CORE:START\s*-->([\s\S]*?)<!--\s*CORE:END\s*-->/

const core = () => {
  if (!existsSync(AGENTS_PATH)) return ""
  return readFileSync(AGENTS_PATH, "utf-8").match(CORE_RE)?.[1].trim() ?? ""
}

export default {
  id: "redcode-core-memory",
  server: async () => ({
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      const block = core()
      if (block) output.system.push(block)
    },
  }),
}
