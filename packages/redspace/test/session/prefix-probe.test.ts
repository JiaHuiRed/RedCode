import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { ModelMessage } from "ai"
import { PrefixProbe } from "../../src/session/prefix-probe"

// 260819 cc audit：探针原本是 prompt.ts runLoop 里的临时块（注释写着「诊断完成后整块删除」），
// 活了半个月还在长功能，且带着无界 Map、同步写盘、无轮转、无开关。抽出来转正后钉住这四件。
//
// 注意：日志路径必须改到用例自己的临时文件。默认路径下那份是哥哥正在用的前缀缓存排查数据，
// reset() 会把它删掉。
const logFile = path.join(os.tmpdir(), "redcode-prefix-probe-test.log")

const msg = (text: string): ModelMessage => ({ role: "user", content: text })
const base = (over: Partial<Parameters<typeof PrefixProbe.record>[0]> = {}) => ({
  sessionID: "ses_a",
  modelKey: "deepseek/v4-flash",
  system: ["sys"],
  messages: [msg("hello"), msg("world")],
  reminderLength: 0,
  ...over,
})
const readLog = async () => fs.readFile(logFile, "utf8").catch(() => "")

beforeEach(async () => {
  process.env["REDCODE_PREFIX_PROBE_LOG"] = logFile
  delete process.env["REDCODE_DISABLE_PREFIX_PROBE"]
  // 写盘是异步链，不先排空的话上一条用例的追加会在 reset 删完文件之后落下来，
  // 把日志重新创出来污染下一条（实测踩到）
  await PrefixProbe.flush()
  PrefixProbe.reset()
})

afterAll(async () => {
  PrefixProbe.reset()
  delete process.env["REDCODE_PREFIX_PROBE_LOG"]
  await fs.rm(logFile, { force: true })
  await fs.rm(logFile + ".1", { force: true })
})

describe("prefix-probe", () => {
  test("健康轮次只写一行，不输出明细", async () => {
    PrefixProbe.record(base())
    PrefixProbe.record(base())
    await PrefixProbe.flush()
    const log = await readLog()
    expect(log.split("\n").filter(Boolean).length).toBe(2)
    expect(log).not.toContain("断裂")
  })

  test("真断裂时报出断点位置", async () => {
    PrefixProbe.record(base())
    PrefixProbe.record(base({ messages: [msg("hello"), msg("CHANGED")] }))
    await PrefixProbe.flush()
    const log = await readLog()
    expect(log).toContain("前缀在第 1 条断裂")
  })

  // 5670d86 修的就是这个：指纹按 sessionID 存时，同会话切模型必然逐条不等 → 报「第 0 条断裂」，
  // 而两个模型各自的 provider 前缀缓存其实都没断。实测那段日志 161 处断裂里 37 处是这么来的。
  test("同会话切模型不报假断裂", async () => {
    PrefixProbe.record(base({ modelKey: "deepseek/v4-flash", messages: [msg("a"), msg("b")] }))
    PrefixProbe.record(base({ modelKey: "anthropic/claude", messages: [msg("x"), msg("y")] }))
    PrefixProbe.record(base({ modelKey: "deepseek/v4-flash", messages: [msg("a"), msg("b")] }))
    await PrefixProbe.flush()
    expect(await readLog()).not.toContain("断裂")
  })

  test("指纹表有界，最冷的被挤掉", async () => {
    for (let i = 0; i < 40; i++) PrefixProbe.record(base({ sessionID: `ses_${i}` }))
    expect(PrefixProbe.size()).toBe(32)
  })

  test("开关关掉后既不写盘也不记指纹", async () => {
    process.env["REDCODE_DISABLE_PREFIX_PROBE"] = "1"
    PrefixProbe.record(base())
    await PrefixProbe.flush()
    expect(PrefixProbe.size()).toBe(0)
    expect(await readLog()).toBe("")
  })

  test("日志超过上限时轮转，不再无限追加", async () => {
    // 稀疏文件撑到上限，避免真写 8MB
    const fh = await fs.open(logFile, "w")
    await fh.truncate(PrefixProbe.MAX_BYTES + 1)
    await fh.close()
    PrefixProbe.record(base())
    await PrefixProbe.flush()
    const rotated = await fs.stat(logFile + ".1").catch(() => undefined)
    expect(rotated).toBeDefined()
    const current = await fs.stat(logFile)
    expect(current.size).toBeLessThan(PrefixProbe.MAX_BYTES)
  })
})
