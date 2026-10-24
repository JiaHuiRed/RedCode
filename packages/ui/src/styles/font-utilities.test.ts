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

describe("font utility classes", () => {
  test("every used text-N-style class is defined in utilities.css", () => {
    expect(defined.size).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const root of roots) {
      for (const file of collectFiles(root)) {
        const text = readFileSync(file, "utf8")
        for (const match of text.matchAll(/\btext-\d+-(?:regular|medium|mono|bold)\b/g)) {
          const name = match[0]
          if (defined.has(name)) continue
          const line = text.slice(0, match.index).split("\n").length
          offenders.push(`${file.split(/packages/).pop()}:${line} ${name}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
