import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

// 260810 cc audit R8: v2 组件 CSS 曾有 262 处引用少了 --v2- 前缀（var(--text-text-base)
// 而 token 定义是 --v2-text-text-base），全是死引用——outline 失效导致表单控件焦点环
// 全灭、tooltip/menu/toast 背景透明穿底。token 定义与引用分属两批文件、写错不报错，
// 只能靠这条测试钉死：凡是 v2/styles 里定义过 --v2-X 的名字，组件里就禁止出现无前缀
// 的 var(--X)。
const root = join(import.meta.dir)

function cssFiles(dir: string) {
  return readdirSync(join(root, dir))
    .filter((file) => file.endsWith(".css"))
    .map((file) => join(root, dir, file))
}

describe("v2 token references", () => {
  test("component css never references a defined v2 token without the --v2- prefix", () => {
    const defined = new Set<string>()
    for (const file of cssFiles("styles")) {
      for (const match of readFileSync(file, "utf8").matchAll(/--v2-([a-z0-9-]+):/g)) {
        defined.add(match[1])
      }
    }
    expect(defined.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of cssFiles("components")) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/var\(--([a-z0-9-]+)/g)) {
        const name = match[1]
        if (name.startsWith("v2-")) continue
        if (!defined.has(name)) continue
        const line = text.slice(0, match.index).split("\n").length
        offenders.push(`${file.split(/[\\/]/).pop()}:${line} var(--${name}) → 应为 var(--v2-${name})`)
      }
    }

    expect(offenders).toEqual([])
  })
})
