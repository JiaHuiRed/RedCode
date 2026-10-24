import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

// 261024 Red utilities.css 只定义了 text-12/14/16 档，而代码里用了 text-11-regular×46、
// text-13-*×17、text-16-regular×1 等从未定义的类——死类不报错，文字默默回落继承值，
// 字号档位名存实亡（text-10-regular 就是这么漏进来的）。与 v2/token-refs.test.ts 同理：
// 类名消费与定义分属两批文件、写错不报错，只能靠这条测试钉死：凡在 tsx/ts 里出现的
// text-N-style 字号类，必须在 utilities.css 有定义。新增字号档时先加定义再 usage。
const defined = new Set(
  [...readFileSync(join(import.meta.dir, "utilities.css"), "utf8").matchAll(/\.((?:text)-[\w-]+)/g)].map(
    (match) => match[1],
  ),
)

const roots = [join(import.meta.dir, "../../../app/src"), join(import.meta.dir, "..")]

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(path, acc)
    } else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.includes(".test.")) {
      acc.push(path)
    }
  }
  return acc
}

// 261024 Red 注释免疫：扫描前把注释替换成**等长**空白——行号靠 match.index 回算，长度
//   变了就指错行。行注释的 (^|[^:]) 前缀挡掉 URL 的 `://`；字符串里被误吞的 `//` 后半段
//   不会出现字号类名，可接受。注释里提旧类名（如本文件说明文字里的 text-10-regular）
//   不是 usage，不该判负——为修注释而删有用说明是本末倒置。
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, " "))
}

function offendersIn(text: string): Array<{ name: string; line: number }> {
  const stripped = stripComments(text)
  const found: Array<{ name: string; line: number }> = []
  for (const match of stripped.matchAll(/\btext-\d+-(?:regular|medium|mono|bold)\b/g)) {
    if (defined.has(match[0])) continue
    found.push({ name: match[0], line: stripped.slice(0, match.index).split("\n").length })
  }
  return found
}

describe("font utility classes", () => {
  test("every used text-N-style class is defined in utilities.css", () => {
    expect(defined.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const root of roots) {
      for (const file of collectFiles(root)) {
        for (const { name, line } of offendersIn(readFileSync(file, "utf8"))) {
          offenders.push(`${file.split(/packages/).pop()}:${line} ${name}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  test("class names inside comments do not count as usage", () => {
    expect(offendersIn("// 旧档 text-10-regular 已删，别再用")).toEqual([])
    expect(offendersIn("/* 261024 Red text-9-bold 当年漏定义 */")).toEqual([])
    expect(offendersIn('const url = "https://example.com" // text-9-medium 注释')).toEqual([])
  })

  test("real usage of an undefined class is still flagged with its line", () => {
    const text = ['const a = "text-14-regular"', 'const b = `text-9-bold`'].join("\n")
    expect(offendersIn(text)).toEqual([{ name: "text-9-bold", line: 2 }])
  })
})
