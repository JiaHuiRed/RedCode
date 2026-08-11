import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool, fileLockCount } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Hash } from "@redcode-ai/core/util/hash"
import * as Bom from "@/util/bom"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { FileWatcher } from "../../src/file/watcher"
import { FileTime } from "@/file/time"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Format.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
  // 260810 cc: edit 现在有"写前已读"守卫（FileTime），测试铺的文件视同已读
  yield* FileTime.record(ctx.sessionID, p)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof FileWatcher.Event.Updated) {
  const bus = yield* Bus.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* bus.subscribeCallback(def, () => Effect.runSync(Deferred.succeed(deferred, undefined)))
  yield* Effect.addFinalizer(() => Effect.sync(unsub))
  return deferred
})

describe("tool.edit", () => {
  // 260810 cc audit R2: 写前已读守卫（FileTime）
  describe("写前已读守卫", () => {
    it.instance("拒绝编辑本会话从未 read 过的文件", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unread.txt")
        // 绕过 put()（它会记录已读），模拟外部落盘的文件
        yield* Effect.promise(() => fs.writeFile(filepath, "content", "utf-8"))

        const err = yield* fail({ filePath: filepath, oldString: "content", newString: "changed" })
        expect(err.message).toContain("read tool")

        // 空 oldString 的整文件覆写路径同样被拦
        const err2 = yield* fail({ filePath: filepath, oldString: "", newString: "changed" })
        expect(err2.message).toContain("read tool")
        expect(yield* load(filepath)).toBe("content")
      }),
    )

    it.instance("拒绝编辑读后被外部改动过的文件", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "stale.txt")
        yield* put(filepath, "original")
        // 模拟外部改动：mtime 拨到过去，保证与记录值不等（不依赖时钟精度，
        // 也不在磁盘上留未来时间戳）
        const past = new Date(Date.now() - 5000)
        yield* Effect.promise(() => fs.utimes(filepath, past, past))

        const err = yield* fail({ filePath: filepath, oldString: "original", newString: "changed" })
        expect(err.message).toContain("modified externally")
        expect(yield* load(filepath)).toBe("original")
      }),
    )

    it.instance("工具自己的写入会刷新记录，连续编辑不误报", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "twice.txt")
        yield* put(filepath, "one")
        yield* run({ filePath: filepath, oldString: "one", newString: "two" })
        yield* run({ filePath: filepath, oldString: "two", newString: "three" })
        expect(yield* load(filepath)).toBe("three")
      }),
    )
  })

  // 260811 cc: 文件锁表引用计数回收——此前每碰一个新文件永久泄漏一个 Semaphore
  describe("文件锁回收", () => {
    it.instance("编辑结束后锁表清空", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "lock-a.txt")
        const b = path.join(test.directory, "lock-b.txt")
        yield* put(a, "aa")
        yield* put(b, "bb")
        yield* run({ filePath: a, oldString: "aa", newString: "a2" })
        yield* run({ filePath: b, oldString: "bb", newString: "b2" })
        // 失败路径同样要回收
        yield* fail({ filePath: a, oldString: "不存在的内容", newString: "x" })
        expect(fileLockCount()).toBe(0)
      }),
    )
  })

  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("preserves BOM when oldString is empty on existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\n`)

        const result = yield* run({ filePath: filepath, oldString: "", newString: "using Up;\n" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(FileWatcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(FileWatcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("hashline", () => {
    const patch = (filepath: string, content: string, ...ops: string[]) =>
      [`[${filepath}#${Hash.fileTag(content)}]`, ...ops].join("\n")

    const lines = ["<html>", "  <body>", "    <p>hi</p>", "  </body>", "</html>"]

    // 物理行数 —— .NET/Get-Content/编辑器的口径，裸 \r 也算换行。
    // 只按 \n 数是发现不了 \r\r\n 膨胀的（工具自己当初就是这么瞎的）。
    const physicalLines = (content: string) => content.split(/\r\n|\r|\n/).length

    it.instance("CRLF 文件编辑后不产生 \\r\\r\\n，物理行数不翻倍", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "page.txt")
        const content = lines.join("\r\n")
        yield* put(filepath, content)

        yield* run({ input: patch(filepath, content, "replace 3..3:", "+     <p>hello</p>") })

        const after = yield* loadRaw(filepath)
        expect(after).not.toContain("\r\r")
        expect(physicalLines(after)).toBe(lines.length)
        expect(after).toBe(["<html>", "  <body>", "    <p>hello</p>", "  </body>", "</html>"].join("\r\n"))
      }),
    )

    it.instance("CRLF 文件连续编辑三次仍不膨胀", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "page.txt")
        yield* put(filepath, lines.join("\r\n"))

        for (const n of [1, 2, 3]) {
          const current = yield* loadRaw(filepath)
          yield* run({ input: patch(filepath, current, "replace 3..3:", `+     <p>v${n}</p>`) })
        }

        const after = yield* loadRaw(filepath)
        expect(after).not.toContain("\r\r")
        expect(physicalLines(after)).toBe(lines.length)
        expect(after).toBe(["<html>", "  <body>", "    <p>v3</p>", "  </body>", "</html>"].join("\r\n"))
      }),
    )

    it.instance("LF 文件保持 LF", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "page.txt")
        const content = lines.join("\n")
        yield* put(filepath, content)

        yield* run({ input: patch(filepath, content, "replace 3..3:", "+     <p>hello</p>") })

        const after = yield* loadRaw(filepath)
        expect(after).not.toContain("\r")
        expect(after).toBe(["<html>", "  <body>", "    <p>hello</p>", "  </body>", "</html>"].join("\n"))
      }),
    )

    it.instance("`+ ` 前缀只吃掉分隔空格，不给内容加前导空格", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "code.txt")
        const content = "function a() {\n  return 1\n}\n"
        yield* put(filepath, content)

        yield* run({ input: patch(filepath, content, "replace 2..2:", "+   return 2") })

        expect(yield* load(filepath)).toBe("function a() {\n  return 2\n}\n")
      }),
    )

    it.instance("`+` 后不带空格也照样接受，空的 `+` 就是空行", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "code.txt")
        const content = "a\nb\nc\n"
        yield* put(filepath, content)

        yield* run({ input: patch(filepath, content, "replace 2..2:", "+B", "+", "+B2") })

        expect(yield* load(filepath)).toBe("a\nB\n\nB2\nc\n")
      }),
    )

    it.instance("CRLF 文件上的 insert/delete 同样不膨胀", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "page.txt")
        const content = ["a", "b", "c"].join("\r\n")
        yield* put(filepath, content)

        yield* run({
          input: patch(
            filepath,
            content,
            "insert head:",
            "+ head",
            "insert after 2:",
            "+ after-b",
            "delete 3..3",
            "insert tail:",
            "+ tail",
          ),
        })

        const after = yield* loadRaw(filepath)
        expect(after).not.toContain("\r\r")
        expect(after).toBe(["head", "a", "b", "after-b", "tail"].join("\r\n"))
      }),
    )

    it.instance("hash 不匹配时报错且一个字节都不写", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "page.txt")
        const content = lines.join("\r\n")
        yield* put(filepath, content)

        const err = yield* fail({ input: `[${filepath}#0000]\nreplace 3..3:\n+ nope` })

        expect(err.message).toContain("Hash mismatch")
        expect(yield* loadRaw(filepath)).toBe(content)
      }),
    )
  })

  // 260730 Karina read 侧加了编码检测之后，GBK 文件读出来是干净中文，detectGarbled
  // 那道墙（满屏 FFFD → 拒写）就自动失效了。不补这道就成了「悄悄把用户的 GBK 文件
  // 转成 UTF-8」—— 我们只有解码能力没有编码能力，所以拒绝而不是往回转。
  describe("编码护栏", () => {
    // GBK 编码的两行：「中文测试内容」「第二行：项目报表」
    const GBK = new Uint8Array([
      0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xb5, 0xda,
      0xb6, 0xfe, 0xd0, 0xd0, 0xa3, 0xba, 0xcf, 0xee, 0xc4, 0xbf, 0xb1, 0xa8, 0xb1, 0xed, 0x0a,
    ])

    const putBytes = Effect.fn("EditToolTest.putBytes")(function* (p: string, bytes: Uint8Array) {
      const afs = yield* AppFileSystem.Service
      yield* afs.writeWithDirs(p, bytes)
      yield* FileTime.record(ctx.sessionID, p)
    })

    it.instance("拒绝把 GBK 文件写回成 UTF-8（经典路径），且原文一字节未动", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "gbk.txt")
        yield* putBytes(filepath, GBK)

        const err = yield* fail({ filePath: filepath, oldString: "中文测试内容", newString: "改过的内容" })

        expect(err.message).toContain("不是 UTF-8")
        const after = yield* Effect.promise(() => fs.readFile(filepath))
        expect(new Uint8Array(after)).toEqual(GBK)
      }),
    )

    it.instance("拒绝把 GBK 文件写回成 UTF-8（hashline 路径）", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "gbk.txt")
        yield* putBytes(filepath, GBK)

        // tag 用检测后的文本算 —— 与 read 产出的一致，所以不会先撞上 hash mismatch，
        // 能真正走到编码护栏这一步
        const tag = Hash.fileTag(Bom.decode(GBK).text)
        const err = yield* fail({ input: `[${filepath}#${tag}]\nreplace 1..1:\n+ 改过的内容` })

        expect(err.message).toContain("不是 UTF-8")
        const after = yield* Effect.promise(() => fs.readFile(filepath))
        expect(new Uint8Array(after)).toEqual(GBK)
      }),
    )

    it.instance("UTF-8 文件不受影响", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "utf8.txt")
        yield* put(filepath, "中文测试内容\n")

        yield* run({ filePath: filepath, oldString: "中文测试内容", newString: "改过的内容" })

        expect(yield* load(filepath)).toBe("改过的内容\n")
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})


  // 260808 Red UnicodeNormalizedReplacer：模型写的 oldString 常与文件实际字符有细微
  // 差异（智能引号/全角字符/特殊空格/Unicode 破折号），精确匹配失败后应归一化降级命中。
  // 与 Pi 的 contentForReplacement 不同：只替换匹配区，匹配区外的字符保持原样。
  describe("unicode fuzzy matching", () => {
    it.instance("matches smart double quotes against ASCII quotes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "quotes.txt")
        yield* put(filepath, 'const s = "it\'s fine";')

        yield* run({ filePath: filepath, oldString: "\u201Cit\u2019s fine\u201D", newString: "\u201Cit\u2019s ok\u201D" })

        expect(yield* load(filepath)).toBe('const s = \u201Cit\u2019s ok\u201D;')
      }),
    )

    it.instance("matches smart single quotes against ASCII quotes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "quotes.txt")
        yield* put(filepath, "const s = 'it's fine';")

        yield* run({ filePath: filepath, oldString: "\u2018it\u2019s fine\u2019", newString: "ok" })

        expect(yield* load(filepath)).toBe("const s = ok;")
      }),
    )

    it.instance("matches full-width chars (Chinese scene) against half-width", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cn.txt")
        yield* put(filepath, "console.log\uFF08\u4E2D\u6587\uFF09")

        yield* run({ filePath: filepath, oldString: "(\u4E2D\u6587)", newString: "(CN)" })

        expect(yield* load(filepath)).toBe("console.log(CN)")
      }),
    )

    it.instance("matches NBSP against regular space", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nbsp.txt")
        yield* put(filepath, "const a = 1\u00A0+ 2;")

        yield* run({ filePath: filepath, oldString: "1 + 2", newString: "3" })

        expect(yield* load(filepath)).toBe("const a = 3;")
      }),
    )

    it.instance("matches unicode dash against ASCII hyphen", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "dash.txt")
        yield* put(filepath, "const b = a\u2014b;")

        yield* run({ filePath: filepath, oldString: "a-b", newString: "ab" })

        expect(yield* load(filepath)).toBe("const b = ab;")
      }),
    )

    it.instance("replaceAll replaces every unicode-equivalent occurrence", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multi.txt")
        yield* put(filepath, 'const x = "a" + "a";')

        yield* run({ filePath: filepath, oldString: "\u201Ca\u201D", newString: "Q", replaceAll: true })

        expect(yield* load(filepath)).toBe("const x = Q + Q;")
      }),
    )

    it.instance("only replaces the matched region, leaves other chars untouched", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "preserve.txt")
        yield* put(filepath, "'keep' \"target\" 'keep'")

        yield* run({ filePath: filepath, oldString: "\u201Ctarget\u201D", newString: "TARGET" })

        expect(yield* load(filepath)).toBe("'keep' TARGET 'keep'")
      }),
    )
  })