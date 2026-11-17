/**
 * 261024 Red MCP prompt 命令的 template 是懒 Promise（mcp getPrompt 可能慢、失败、
 * 服务器下线时恒挂起），而 HTTP 响应体的 JSON 校验（Effect 4.0.5 起）把 Promise 拒成
 * "Expected JSON value at [14][\"template\"]" —— /command 整条 400，GUI 每个项目
 * bootstrap 都弹「无法重新加载」。OpenAPI 契约本就声明 template: string
 * （httpapi/public.ts 手工补的 `{ type: "string" }`），所以在 HTTP 边界统一落地成字符串。
 *
 * 提交路径（session/prompt.ts）仍直接 await 原始 Promise，可以慢慢等 MCP，不走这里。
 */

/** 单个模板的落地预算：健康 MCP 的 getPrompt 毫秒级返回，挂掉的服务器最多等这么久。 */
export const TEMPLATE_BUDGET_MS = 2000

export async function resolveTemplate(template: Promise<string> | string, budgetMs = TEMPLATE_BUDGET_MS): Promise<string> {
  if (typeof template === "string") return template
  return Promise.race([
    // 拒绝也当失败兜底：github 这类下线中的 remote MCP 的 getPrompt 会 reject。
    template.catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), budgetMs)),
  ])
}
