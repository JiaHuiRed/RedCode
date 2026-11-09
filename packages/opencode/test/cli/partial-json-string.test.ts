import { expect, test } from "bun:test"
import { extractPartialJsonString, PartialJsonStringReader } from "@/cli/cmd/tui/util/partial-json-string"

const json = (value: string) => `{"filePath":"a.md","content":${JSON.stringify(value)}}`

test("reader matches the one-shot extractor on complete input", () => {
  const text = "line one\nline two\ttabbed \"quoted\" 中文 \\ backslash"
  const raw = json(text)
  expect(new PartialJsonStringReader("content").read(raw)).toEqual(extractPartialJsonString(raw, "content"))
  expect(new PartialJsonStringReader("content").read(raw)).toEqual({ value: text, complete: true })
})

// 引擎按 delta 累积 raw，可能停在半个转义上（`\` 或 `\u12`）。分片喂入的结果必须
// 和一次性解析完全一致，否则预览会在中途丢字符或卡住。
test("reader is stable across arbitrary chunk boundaries", () => {
  const text = "第一行\n第二行\u00e9\ttab \"quote\"\n第三行"
  const raw = json(text)
  for (const size of [1, 2, 3, 7, 16, 64]) {
    const reader = new PartialJsonStringReader("content")
    let last: { value: string; complete: boolean } | undefined
    for (let end = size; end < raw.length; end += size) last = reader.read(raw.slice(0, end))
    last = reader.read(raw)
    expect(last).toEqual({ value: text, complete: true })
  }
})

test("reader keeps the preview window bounded on long documents", () => {
  const reader = new PartialJsonStringReader("content", 128)
  const line = "x".repeat(200) + "\n"
  let raw = '{"content":"'
  for (let i = 0; i < 200; i++) {
    raw += line
    reader.read(raw)
  }
  const value = (reader.read(raw) as { value: string }).value
  expect(value.length).toBeLessThanOrEqual(256)
  // 行数统计不受裁剪影响：200 行 + 结尾换行
  expect(reader.lines).toBe(201)
})

test("reader restarts when raw is replaced by a shorter string", () => {
  const reader = new PartialJsonStringReader("content")
  reader.read(json("a much longer first attempt"))
  const second = json("ok")
  expect(reader.read(second)).toEqual({ value: "ok", complete: true })
})

test("reader returns undefined until the value actually starts", () => {
  const reader = new PartialJsonStringReader("content")
  expect(reader.read('{"content"')).toBeUndefined()
  expect(reader.read('{"content":')).toBeUndefined()
  expect(reader.read('{"content": ')).toBeUndefined()
  expect(reader.read('{"content": "')).toEqual({ value: "", complete: false })
})

test("reader finds a later key split across chunks and resets its search", () => {
  const reader = new PartialJsonStringReader("filePath")
  const prefix = `{"content":"${"x".repeat(10000)}",`
  for (let end = 1; end < prefix.length; end += 137) expect(reader.read(prefix.slice(0, end))).toBeUndefined()
  expect(reader.read(prefix + '"file')).toBeUndefined()
  expect(reader.read(prefix + '"filePath"')).toBeUndefined()
  expect(reader.read(prefix + '"filePath":')).toBeUndefined()
  expect(reader.read(prefix + '"filePath":"a.md"}')).toEqual({ value: "a.md", complete: true })
  expect(reader.read('{"filePath":"b"}')).toEqual({ value: "b", complete: true })
})
