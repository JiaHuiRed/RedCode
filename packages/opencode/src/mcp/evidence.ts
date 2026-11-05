import stripAnsi from "strip-ansi"

// 261105 Red MCP 启动失败证据链：stdio server 起不来时错误只写 stderr，SDK 只回
// "Connection closed"，用户在状态面板看到一个无信息量的错误（「误配置要响」——
// 响了个寂寞）。这里从 transport.stderr 自收证据（SDK 错误对象不带 stderr），脱敏
// 截断后拼进 status.error。两条上限：原始缓冲 4000 字符、进错误的证据 512 字符；
// 脱敏在截断之前做，敏感值不会因截断丢前缀而漏遮。参考 ZCode adapters/mcp；
// 决策见 docs/notes/implemented/feature/2026-11-05-zcode-v3.17.2-absorption.md

// 证据只进用户可见的错误与日志，不该携带凭证：key 含这些词的 KEY=VALUE 一律遮值。
const SENSITIVE_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY)/i
const KEY_VALUE = /\b([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']*)/g

const RAW_KEEP = 4000
export const EVIDENCE_MAX_CHARS = 512

// 有界尾部缓冲：只留最近 4000 字符原始 stderr。失败的根因几乎总在最后几行
// （缺依赖的报错在进程退出前打出），头部的历史噪音可以丢。
export function createStderrEvidence() {
  let raw = ""
  return {
    push(chunk: string) {
      raw += chunk
      if (raw.length > RAW_KEEP) raw = raw.slice(raw.length - RAW_KEEP)
    },
    recent: () => raw,
  }
}

export function sanitizeEvidence(input: string) {
  const masked = stripAnsi(input).replace(KEY_VALUE, (match, key: string, sep: string) =>
    SENSITIVE_KEY.test(key) ? `${key}${sep}[redacted]` : match,
  )
  return masked.length > EVIDENCE_MAX_CHARS ? masked.slice(masked.length - EVIDENCE_MAX_CHARS) : masked
}

// 按 error message 分诊配一句排查建议；分类只看连接错误本身，不按 stderr 内容改判
// （stderr 只是证据，同一类失败可以有多种 stderr 形态）。
export function describeLocalFailure(message: string, evidence: string) {
  const advice = (() => {
    if (/ENOENT|EACCES|not (?:found|permitted)/i.test(message))
      return "The configured command could not be started — check the command path and permissions in the MCP config."
    if (/timed? out|timeout/i.test(message))
      return "Startup exceeded the timeout — raise `timeout` in the MCP config or check how long the server takes to start."
    if (/Connection closed/i.test(message))
      // Windows 上命令不存在也是这个形态（spawn 错误被 transport 吞掉），没证据时不能
      // 说「stderr below」——下面什么都没有，等于又一句空话。
      return evidence
        ? "The server process exited during startup — its stderr below usually names the missing dependency or config error."
        : "The server process exited during startup without writing anything to stderr — the command may have failed to start at all; check its path in the MCP config or run it manually."
    return "Check the server command, arguments, and environment in the MCP config."
  })()
  const stderr = sanitizeEvidence(evidence)
  return stderr ? `${message}\n${advice}\nstdio stderr (last ${EVIDENCE_MAX_CHARS} chars):\n${stderr}` : `${message}\n${advice}`
}

export * as McpEvidence from "./evidence"
