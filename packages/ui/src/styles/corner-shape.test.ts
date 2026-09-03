import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 全圆形必须成对写 `corner-shape: round`。
 *
 * 260903 cc styles/corner-shape.css 用通配选择器把超椭圆铺满全树，全圆形（正圆、胶囊）
 * 必须自己退回去：超椭圆会把正圆压成 squircle —— 用 border 画的 spinner 转起来会晃 ——
 * 也会把胶囊两头削方。这条约定只靠人记会烂，所以扫源码把关。
 *
 * 扫的是**字面量**：本仓的全圆写法只有 `50%` / `100%` / 999px 以上三种，加上 Tailwind
 * 的 `.rounded-full`（在 utilities.css 里一条盖掉）。半径走 `--radius-*` 变量的那些值
 * 全都远低于胶囊阈值，扫不到也不需要扫。
 */
const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const PACKAGES = ["ui/src", "app/src"]
const FULL_ROUND = /border-radius:\s*(50%|100%|9{3,}px)\s*;/g

function stylesheets(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...stylesheets(path))
    else if (entry.endsWith(".css")) out.push(path)
  }
  return out
}

describe("corner-shape", () => {
  test("每个全圆半径都成对写了 corner-shape: round", () => {
    const offenders: string[] = []
    for (const pkg of PACKAGES) {
      for (const file of stylesheets(join(ROOT, "packages", pkg))) {
        const source = readFileSync(file, "utf8")
        const lines = source.split("\n")
        lines.forEach((line, index) => {
          FULL_ROUND.lastIndex = 0
          if (!FULL_ROUND.test(line)) return
          // 成对声明允许写在前一行或后一行
          const neighbours = [lines[index - 1], lines[index + 1]].join("\n")
          if (neighbours.includes("corner-shape:")) return
          offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1} ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  test("通配规则包在 @supports 里，不支持的引擎读不到", () => {
    const source = readFileSync(join(import.meta.dir, "corner-shape.css"), "utf8")
    expect(source).toContain("@supports (corner-shape: superellipse(1.5))")
    const guard = source.indexOf("@supports")
    expect(source.indexOf("corner-shape: superellipse(1.5);")).toBeGreaterThan(guard)
  })
})
