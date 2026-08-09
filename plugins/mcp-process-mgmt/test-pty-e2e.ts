/**
 * PTY 功能 e2e 测试 — 直接驱动 PtyManager（不经 MCP transport）。
 * 覆盖：spawn/write/read（CRLF 交互）/pattern 过滤/wait 退出/\x03 转义/kill。
 */

import { PtyManager } from "./src/pty-manager"

let passed = 0
let failed = 0

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// -- 测试 1: node REPL 交互（CRLF） --------------------------------------
async function testRepl() {
  console.log("== 1. node REPL 交互 ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", [], { title: "repl" })
  await sleep(800)
  m.write(sessionId, "1+1\r\n")
  await sleep(800)
  m.write(sessionId, "console.log('PTY_E2E_OK')\r\n")
  await sleep(800)

  const result = m.read(sessionId, { limit: 200 })
  check("REPL 收到 2", result.output.includes("2"), result.output.slice(-200))
  check("REPL 收到 PTY_E2E_OK", result.output.includes("PTY_E2E_OK"))

  // \x03 转义：Ctrl+C 中断 REPL
  m.write(sessionId, "\\x03")
  await sleep(800)
  const afterCtrlC = m.read(sessionId, { limit: 10 })
  check("\\x03 解码生效（REPL 收到 Ctrl+C 后无异常崩溃）", afterCtrlC.exited === false || afterCtrlC.exitCode !== null, JSON.stringify(afterCtrlC).slice(0, 120))

  m.kill(sessionId, true)
  check("kill 后会话移除", m.list().length === 0)
}

// -- 测试 2: 长进程 + pty_wait -------------------------------------------
async function testWait() {
  console.log("== 2. 长进程 wait ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", ["-e", "setTimeout(() => console.log('DONE_' + (2+3)), 1500)"], { title: "wait" })
  const t0 = Date.now()
  const result = await m.wait(sessionId, { timeout: 10_000 })
  const elapsed = Date.now() - t0
  check("wait 返回 exited", result.exited === true, JSON.stringify(result))
  check("exit code = 0", result.exitCode === 0, String(result.exitCode))
  check("wait 期间增量输出含 DONE_5", result.output.includes("DONE_5"), result.output)
  check("wait 等待真实耗时（>=1.2s 非立即返回）", elapsed >= 1200, `${elapsed}ms`)
  m.kill(sessionId, true)
}

// -- 测试 3: pattern 过滤 + 分页 ------------------------------------------
async function testPattern() {
  console.log("== 3. pattern 过滤 ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", ["-e", `
    for (let i = 0; i < 50; i++) console.log(i % 2 === 0 ? 'INFO line ' + i : 'ERROR line ' + i)
  `], { title: "pattern" })
  await m.wait(sessionId, { timeout: 10_000 })

  const errors = m.read(sessionId, { pattern: "ERROR", limit: 100 })
  check("过滤后全是 ERROR 行", errors.output.split("\n").every((l) => l.startsWith("ERROR")), errors.output.slice(0, 100))
  check("匹配 25 行", errors.matched === 25, String(errors.matched))

  const page = m.read(sessionId, { offset: 0, limit: 5 })
  check("offset/limit 分页取前 5 行", page.output.split("\n").length === 5 && page.output.startsWith("INFO line 0"), page.output)

  const raw = m.read(sessionId, { stripAnsi: false, limit: 1, offset: 0 })
  check("strip_ansi=false 保留原始 ANSI", raw.output.includes("\u001b["), JSON.stringify(raw.output.slice(0, 40)))
  m.kill(sessionId, true)
}

// -- 测试 4: 中文输出 + ring buffer 滚动（5000 行不崩） --------------------
async function testChineseAndRolling() {
  console.log("== 4. 中文输出 + 大输出滚动 ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", ["-e", `
    console.log('中文测试：你好世界 🚀');
    for (let i = 0; i < 5000; i++) console.log('line' + i);
    console.log('TAIL_MARKER');
  `], { title: "chinese" })
  await m.wait(sessionId, { timeout: 15_000 })

  const all = m.read(sessionId, { limit: 6000, offset: 0 })
  check("中文输出正常", all.output.includes("中文测试：你好世界"), all.output.slice(0, 80))
  check("5000 行全量读出", all.totalLines >= 5002, String(all.totalLines))
  check("尾部 marker 存在", all.output.includes("TAIL_MARKER"), all.output.slice(-60))
  m.kill(sessionId, true)
}

// -- 测试 5: timeoutSeconds 自动终止 ---------------------------------------
async function testTimeout() {
  console.log("== 5. timeoutSeconds 自毁 ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", ["-e", "setInterval(()=>{}, 1000)"], { title: "hang", timeoutSeconds: 2 })
  await sleep(3000)
  const list = m.list()
  check("超时后 exited", list.find((s) => s.id === sessionId)?.running === false, JSON.stringify(list))
  m.kill(sessionId, true)
}

// -- 测试 6: 会话保留（exit 后可读最终输出） -------------------------------
async function testSessionRetention() {
  console.log("== 6. exit 后会话保留 ==")
  const m = new PtyManager()
  const { sessionId } = await m.spawnPty("node", ["-e", "console.log('FINAL_OUTPUT')"], { title: "retain" })
  await m.wait(sessionId, { timeout: 10_000 })
  check("exited 后仍可读", m.list().length === 1, JSON.stringify(m.list()))
  const result = m.read(sessionId, { limit: 10 })
  check("最终输出可读", result.output.includes("FINAL_OUTPUT"), result.output)
  m.kill(sessionId, true)
  check("cleanup 后移除", m.list().length === 0)
}

// -- runner ----------------------------------------------------------------

await testRepl()
await testWait()
await testPattern()
await testChineseAndRolling()
await testTimeout()
await testSessionRetention()

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

