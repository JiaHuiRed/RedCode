import { describe, expect, test } from "bun:test"
import { Hash } from "@redcode-ai/core/util/hash"

// 260616 Red 回归测试：read/edit 共用的跨运行时文件指纹。原 Bun.hash.xxHash32 在
// GUI 的 Node sidecar 里 undefined 导致读文件崩，改用 node:crypto sha1 取前 16bit。
// 这套测试锁住"4 位大写 hex / 确定性 / 行尾空白归一化"，保 read 产 tag 与 edit 校验一致。
describe("Hash.fileTag (跨运行时文件指纹)", () => {
  test("返回 4 位大写 hex", () => {
    expect(Hash.fileTag("hello world")).toMatch(/^[0-9A-F]{4}$/)
  })

  test("确定性：同输入同输出", () => {
    expect(Hash.fileTag("foo bar baz")).toBe(Hash.fileTag("foo bar baz"))
  })

  test("不同输入不同输出", () => {
    expect(Hash.fileTag("aaaaaa")).not.toBe(Hash.fileTag("bbbbbb"))
  })

  test("行尾空白归一化 —— read 产 tag 与 edit 校验一致的关键", () => {
    // 内部 normalize 去除行尾空白，确保有无行尾空格算出同一指纹
    expect(Hash.fileTag("line\n")).toBe(Hash.fileTag("line  \n"))
    expect(Hash.fileTag("a\nb")).toBe(Hash.fileTag("a \t\nb"))
  })

  test("空字符串也返回合法 4 位 hex", () => {
    expect(Hash.fileTag("")).toMatch(/^[0-9A-F]{4}$/)
  })
})

// 260728 Karina 流式版本的回归测试。read 改成边流边算指纹（不再把整个文件读进内存），
// 摘要必须和 fileTag(全文) 逐字节一致 —— 否则 edit 用全文算的 currentHash 对不上，
// 每次 edit 都会报 hash mismatch。风险全在分块边界：行尾空白连续段被切成两半时，
// 到底该删还是该留，要等下一块才知道。
describe("Hash.fileTagStream (流式文件指纹)", () => {
  const chunked = (chunks: string[]) => {
    const hasher = Hash.fileTagStream()
    for (const chunk of chunks) hasher.update(chunk)
    return hasher.digest()
  }

  test("整块喂入等价于 fileTag", () => {
    for (const text of ["", "hello", "a\nb\nc\n", "line  \n", "trailing   "]) {
      expect(chunked([text])).toBe(Hash.fileTag(text))
    }
  })

  test("任意切分点都等价于 fileTag —— 覆盖行尾空白被切断的所有情况", () => {
    const samples = [
      "a  \n  b",
      "a  b",
      "a   ",
      "  \n",
      "x\t \r\ny  \t\nz",
      "行尾空白\t \n中文\r\n下一行  ",
      "\r\n\r\n",
      "no-whitespace-at-all",
    ]
    for (const text of samples) {
      const expected = Hash.fileTag(text)
      for (let i = 0; i <= text.length; i++) {
        expect(chunked([text.slice(0, i), text.slice(i)])).toBe(expected)
      }
    }
  })

  test("逐字符喂入仍等价", () => {
    const text = "a  \nb \t\r\nc   "
    const chars = Array.from({ length: text.length }, (_, i) => text.slice(i, i + 1))
    expect(chunked(chars)).toBe(Hash.fileTag(text))
  })

  test("空块不影响结果", () => {
    const text = "a  \nb"
    expect(chunked(["a ", "", " \n", "", "b"])).toBe(Hash.fileTag(text))
  })
})
