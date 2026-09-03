import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 浮层不许「真 border + 抬升阴影」并排写。
 *
 * 260903 cc 采自 DSH 2026-09-01 web-elevation-stroke-shadows。本仓两种写法一直并存：
 * context-menu / dialog / select / dock-surface 早就是「描边画进 box-shadow」，
 * 而 dropdown-menu / popover / hover-card 还是 border + 另一条 shadow —— 同一屏上两种做法。
 * 收敛之后靠这条扫描防回潮，新浮层只能选 `--shadow-*-border*` 那族 token。
 *
 * **反色面例外**：toast / tooltip / markdown 的代码复制提示用 `--surface-float-base`
 * （浅色深色两档都是 #161616，是固定深色面），跟随主题的描边色画在上面没有意义，
 * 保留真 border。上游同样把 Toast/HoverCard 留在外面，理由一致。
 */
const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SCAN = ["ui/src/components", "ui/src/v2/components"]

/** 反色填充的浮层：描边色跟随主题在这些面上无意义，保留真 border。 */
const INVERTED_SURFACE = /--surface-float-base/

function stylesheets(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...stylesheets(path))
    else if (entry.endsWith(".css")) out.push(path)
  }
  return out
}

/** 按大括号切出每一层规则体（只取该层直接写的声明，不含更深的嵌套层）。 */
function blocks(source: string): { line: number; text: string }[] {
  const lines = source.split("\n")
  const stack: { line: number; body: string[] }[] = []
  const out: { line: number; text: string }[] = []
  lines.forEach((line, index) => {
    for (let i = 0; i < (line.match(/\{/g)?.length ?? 0); i++) stack.push({ line: index + 1, body: [] })
    if (stack.length > 0) stack[stack.length - 1]!.body.push(line)
    for (let i = 0; i < (line.match(/\}/g)?.length ?? 0); i++) {
      const frame = stack.pop()
      if (frame) out.push({ line: frame.line, text: frame.body.join("\n") })
    }
  })
  return out
}

describe("elevation", () => {
  test("抬升阴影不与真 border 并排", () => {
    const offenders: string[] = []
    for (const dir of SCAN) {
      for (const file of stylesheets(join(ROOT, "packages", dir))) {
        for (const block of blocks(readFileSync(file, "utf8"))) {
          const border = /border:\s*1px\s+solid/.test(block.text)
          const shadow = /box-shadow:\s*[^;]*--shadow-(md|lg)\b/.test(block.text)
          if (!border || !shadow) continue
          if (INVERTED_SURFACE.test(block.text)) continue
          offenders.push(`${file.slice(ROOT.length + 1)}:${block.line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("--shadow-md-border 自带描边层", () => {
    const theme = readFileSync(join(import.meta.dir, "theme.css"), "utf8")
    const token = theme.slice(theme.indexOf("--shadow-md-border:"))
    expect(token).toContain("0 0 0 1px")
  })
})
