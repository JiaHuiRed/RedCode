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
    // 原文只留在内存缓冲里，由失败时的 describeLocalFailure 统一脱敏。
    expect(evidence.recent()).toContain("supersecret123")
  })

  test("bounds an unterminated line without dropping the log", () => {
    const evidence = McpEvidence.createStderrEvidence()
    const lines = evidence.push("y".repeat(McpEvidence.EVIDENCE_MAX_CHARS + 1))
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
})
