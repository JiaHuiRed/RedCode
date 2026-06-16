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
