import { SessionID } from "@/session/schema"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/experimental/workspace", action: "local" },
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

export function isLocalWorkspaceRoute(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

// 260811 cc：`/session/` 下并非只有 `/session/:sessionID`，还有静态子路径
// （/session/status、/session/tts……）。此前对 status 做了特例、对其余一律
// SessionID.make()，而 make 对不以 "ses" 开头的段**抛异常**——异常在
// workspace-routing 中间件里冒泡成 500，handler 根本没机会跑。实测 POST /session/tts
// 因此全线 500（门禁 session.tts.emptyText 期望 400 得 500 就是这个）。
// 改成按 SessionID 的前缀规则判定：不像会话 id 就返回 null（= 这不是会话路由），
// 新增静态子路径不必再回来加特例。
// 判定用字面前缀而不是 Schema.is(SessionID)：后者会让 tsgo 在本仓类型实例化爆内存
// （实测直接 OOM 崩溃）。前缀与 core/session.ts 的 `Schema.isStartsWith("ses")` 一致，
// 改那边的话这里要跟着改。
export function getWorkspaceRouteSessionID(url: URL) {
  const id = url.pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1]
  if (!id || !id.startsWith("ses")) return null

  return SessionID.make(id)
}

export function workspaceProxyURL(target: string | URL, requestURL: URL) {
  const proxyURL = new URL(target)
  proxyURL.pathname = `${proxyURL.pathname.replace(/\/$/, "")}${requestURL.pathname}`
  proxyURL.search = requestURL.search
  proxyURL.hash = requestURL.hash
  proxyURL.searchParams.delete("workspace")
  return proxyURL
}
