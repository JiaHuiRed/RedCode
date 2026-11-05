import stripAnsi from "strip-ansi"

// 261105 Red MCP 启动失败证据链：stdio server 起不来时错误只写 stderr，SDK 只回
// "Connection closed"，用户在状态面板看到一个无信息量的错误（「误配置要响」——
// 响了个寂寞）。这里从 transport.stderr 自收证据（SDK 错误对象不带 stderr），脱敏
// 截断后拼进 status.error。两条上限：原始缓冲 4000 字符、进错误的证据 512 字符；
// 脱敏在截断之前做，敏感值不会因截断丢前缀而漏遮。参考 ZCode adapters/mcp；
// 决策见 docs/notes/implemented/feature/2026-11-05-zcode-v3.17.2-absorption.md
//
// 261105 Red 审计 RC-015-02：KEY=VALUE 之外还有三类常见泄露形态——Authorization/
// Bearer、JSON 键值、token 类 header；原始 stderr 也不再进普通日志。脱敏逻辑见
// docs/notes/implemented/bug-fix/2026-11-05-mcp-stderr-redaction.md

// 证据只进用户可见的错误与日志，不该携带凭证：key 含这些词的赋值/键值一律遮值。
const SENSITIVE_NAME = "(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|COOKIE)"
const SENSITIVE_KEY = new RegExp(SENSITIVE_NAME, "i")
// KEY=VALUE 与 header 形态的 KEY: VALUE；key 允许连字符（x-api-key）。
const KEY_VALUE = /\b([A-Za-z_][A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',}]*)/g
// JSON 键值：键名带引号，KEY_VALUE 的裸 key 匹配不到，单独处理。
const JSON_FIELD = new RegExp(`("(?:[A-Za-z0-9_-]*${SENSITIVE_NAME}[A-Za-z0-9_-]*)"\\s*:\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,}]+)`, "gi")
// Authorization 头整行遮值（Bearer/Basic/自定义 scheme 都覆盖），避免只遮 scheme
// 把后面的凭证留在原地。
const AUTH_HEADER = /\b((?:proxy-)?authorization)\s*:\s*[^\n]*/gi
// 正文里的 Bearer 凭证（非 header 形态）。只认 Bearer：Basic 后面常跟普通英文词
// （"Basic authentication failed"），按长度猜会大面积误遮。
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi

const RAW_KEEP = 4000
export const EVIDENCE_MAX_CHARS = 512

// 有界尾部缓冲：只留最近 4000 字符原始 stderr。失败的根因几乎总在最后几行
// （缺依赖的报错在进程退出前打出），头部的历史噪音可以丢。
export function createStderrEvidence() {
  let raw = ""
  // 日志 sink 按行补齐后再脱敏：跨 chunk 拆开的 KEY=值 在同一行内会被整段遮住。
  let pending = ""
  return {
    // 返回本次补齐的完整行（已脱敏），供普通日志使用；未换行的尾行留到下一次。
    push(chunk: string) {
      raw += chunk
      if (raw.length > RAW_KEEP) raw = raw.slice(raw.length - RAW_KEEP)
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      // 无换行的超长输出不能无限攒着；到上限就按一段处理（截断仍按证据上限）。
      if (pending.length > EVIDENCE_MAX_CHARS) {
        lines.push(pending)
        pending = ""
      }
      return lines.map(redactLine).filter((line) => line.trim().length > 0)
    },
    recent: () => raw,
  }
}

function redactLine(input: string) {
  return redact(input).slice(0, EVIDENCE_MAX_CHARS)
}

// 脱敏（不截断）：证据与日志共用同一套规则，避免两个出口各自漏一种形态。
export function redact(input: string) {
  return stripAnsi(input)
    .replace(AUTH_HEADER, (_match, header: string) => `${header}: [redacted]`)
    .replace(JSON_FIELD, (_match, head: string) => `${head}"[redacted]"`)
    .replace(BEARER, "Bearer [redacted]")
    .replace(KEY_VALUE, (match, key: string, sep: string) =>
      SENSITIVE_KEY.test(key) ? `${key}${sep}[redacted]` : match,
    )
}

export function sanitizeEvidence(input: string) {
  const masked = redact(input)
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
