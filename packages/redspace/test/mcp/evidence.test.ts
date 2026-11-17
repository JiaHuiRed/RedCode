import { describe, expect, test } from "bun:test"
import { McpEvidence } from "@/mcp/evidence"

// 261105 Red 审计 RC-015-02：证据脱敏要覆盖 KEY=VALUE 之外的常见形态，
// 且原始 stderr 不得进入普通日志（日志侧拿到的是 push() 返回的已脱敏行）。
describe("mcp.evidence", () => {
  const redacted = [
    ["API_TOKEN=supersecret123", "supersecret123"],
    ["Authorization: Bearer supersecret123", "supersecret123"],
    ['{"apiKey":"supersecret123","name":"demo"}', "supersecret123"],
    ["x-api-key: supersecret123", "supersecret123"],
    ["Cookie: session=supersecret123", "supersecret123"],
    ["proxy-authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["retrying with Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig", "eyJhbGciOiJIUzI1NiJ9"],
  ] as const

  for (const [input, secret] of redacted) {
    test(`redacts ${input.slice(0, 28)}`, () => {
      const output = McpEvidence.sanitizeEvidence(input)
      expect(output).toContain("[redacted]")
      expect(output).not.toContain(secret)
    })
  }

  test("keeps ordinary assignments and prose intact", () => {
    const input = "PATH=/usr/bin\nError: file not found\nBasic authentication failed"
    expect(McpEvidence.sanitizeEvidence(input)).toBe(input)
  })

  test("holds an incomplete trailing line until the next chunk", () => {
    const evidence = McpEvidence.createStderrEvidence()
    expect(evidence.push("TOKEN=supersecret123")).toEqual([])
    expect(evidence.push("\n")).toEqual(["TOKEN=[redacted]"])
  })

  test("masks assignments split across chunks at the log sink", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const lines = [...evidence.push("starting\nAPI_TO"), ...evidence.push("KEN=supersecret123\nready\n")]
    expect(lines).toEqual(["starting", "API_TOKEN=[redacted]", "ready"])
    // 261105 Red 原始缓冲也脱敏：超长密钥值的字段名可能被挤出 4000 窗口，留存原值
    // 等于给裸值留后门。出口的 redact 幂等，再遮一次无副作用。
    expect(evidence.recent()).not.toContain("supersecret123")
    expect(evidence.recent()).toContain("[redacted]")
  })

  // 261105 Red 验收漏洞：512 硬切 + 逐段脱敏时，键名跨切点会被拆成两段，两段都
  // 识别不到敏感字段。切分改为「先脱敏再切 + 回退窗口」后不得再漏。
  test("redacts a key split across the early-cut boundary", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const lines = [...evidence.push("x".repeat(508) + "API_TO"), ...evidence.push("KEN=supersecret123\n")]
    // 508 前缀正好把值推到 512 证据上限之外：截断会切掉 [redacted] 标记本身，
    // 但密钥值不能以任何形式出现——安全优先于标记可读性。
    expect(lines.join("\n")).not.toContain("supersecret123")
  })

  test("does not leak a key that straddles the backoff cut", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const first = "x".repeat(McpEvidence.EVIDENCE_MAX_CHARS + 40) + "API_TOKEN="
    const lines = [...evidence.push(first + "s".repeat(20)), ...evidence.push("ecretvalue\n")]
    expect(lines.join("\n")).not.toContain("ecretvalue")
  })

  // 261105 Red 验收补洞：CUT_BACKOFF 只降低概率，不构成保证——键名恰好跨在回退后的
  // 切点上时，第一段没有 "="、第二段 key 只剩尾字母（不敏感），下一次补齐成完整行后
  // 值以明文进日志。
  test("redacts a key split across the cut on an unterminated line", () => {
    const evidence = McpEvidence.createStderrEvidence()
    // 总长 599，切点 599 - 64 = 535，落在 API_TOKEN 的键名中间（API_T|OKEN=...）。
    const chunk = "x".repeat(530) + "API_TOKEN=supersecret123" + "y".repeat(45)
    const lines = [...evidence.push(chunk), ...evidence.push("\n")]
    const output = [...lines, evidence.recent()].join("\n")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("supersecret123")
  })

  // 261105 Red 验收补洞：进程 startup 失败常只输出一行没有结尾换行的错误就退出，
  // 只读完整行会让 recent() 为空，用户仍看不到任何 stderr 证据。
  test("recent keeps an unterminated final line as evidence", () => {
    const evidence = McpEvidence.createStderrEvidence()
    expect(evidence.push("Error: missing config")).toEqual([])
    expect(evidence.recent()).toContain("Error: missing config")
  })

  test("recent redacts an unterminated final line", () => {
    const evidence = McpEvidence.createStderrEvidence()
    evidence.push("API_TOKEN=supersecret123")
    expect(evidence.recent()).toContain("API_TOKEN=[redacted]")
    expect(evidence.recent()).not.toContain("supersecret123")
  })

  // 261105 Red 验收补洞：整行都被脱敏成短串时（超长 Authorization 行、始终没有
  // 换行），切分点算不出来；旧实现一直保留原文，pending 随 chunk 无限增长。
  test("bounds an unterminated line that is entirely redacted", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const chunk = "Authorization: Bearer " + "A".repeat(9000)
    const lines = [...evidence.push(chunk), ...evidence.push("A".repeat(5000))]
    const output = [...lines, evidence.recent()].join("\n")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("AAAAAAAA")
    expect(evidence.pendingSize()).toBeLessThanOrEqual(64)
  })

  test("resumes after the newline following a truncated line", () => {
    const evidence = McpEvidence.createStderrEvidence()
    evidence.push("Authorization: Bearer " + "A".repeat(9000))
    expect(evidence.push("B".repeat(5000))).toEqual([])
    expect(evidence.push("\nnext error line\n")).toEqual(["next error line"])
  })

  test("does not truncate an ordinary long line at the hard cap", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const lines = evidence.push("x".repeat(9000))
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThanOrEqual(McpEvidence.EVIDENCE_MAX_CHARS)
    expect(evidence.pendingSize()).toBe(64)
  })

  test("bounds an unterminated line without dropping the log", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const lines = evidence.push("y".repeat(McpEvidence.EVIDENCE_MAX_CHARS * 2))
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThanOrEqual(McpEvidence.EVIDENCE_MAX_CHARS)
  })

  test("truncates after redaction so the tail never exposes a secret", () => {
    const output = McpEvidence.sanitizeEvidence("x".repeat(600) + " API_TOKEN=supersecret123")
    expect(output.length).toBeLessThanOrEqual(McpEvidence.EVIDENCE_MAX_CHARS)
    expect(output).not.toContain("supersecret123")
  })

  test("startup failure advice carries only redacted evidence", () => {
    const output = McpEvidence.describeLocalFailure("Connection closed", "Authorization: Bearer supersecret123")
    expect(output).toContain("stdio stderr")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("supersecret123")
  })

  // 261105 Red 启动失败日志同样不能带凭据：--api-key 的下一个参数、--token=xxx、
  // -H "Authorization: ..." 三种形态都要遮。
  test("redacts credentials in command arguments", () => {
    expect(
      McpEvidence.redactCommand([
        "npx",
        "server",
        "--api-key",
        "supersecret123",
        "--token=supersecret456",
        "-H",
        "Authorization: Bearer supersecret789",
      ]),
    ).toEqual([
      "npx",
      "server",
      "--api-key",
      "[redacted]",
      "--token=[redacted]",
      "-H",
      "Authorization: [redacted]",
    ])
  })

  test("keeps ordinary command arguments intact", () => {
    expect(McpEvidence.redactCommand(["npx", "-y", "@scope/server", "--port", "8080"])).toEqual([
      "npx",
      "-y",
      "@scope/server",
      "--port",
      "8080",
    ])
  })
})
