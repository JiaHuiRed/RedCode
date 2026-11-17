import { describe, expect, test } from "bun:test"
import { escapeHtml, renderAuthErrorPage, renderAuthSuccessPage } from "../../src/plugin/auth-page"

// 261106 Red 审计 P1-01：error 页文本现由模板内部统一转义，调用方传入 URL 参数原文
// 也不得产出可执行 HTML。恶意载荷回归钉死在这里，防止未来有人把 errorHtml 加回来。
describe("plugin.auth-page", () => {
  test("error page escapes untrusted error text instead of injecting it as HTML", () => {
    const payload = '</div><script>alert(1)</script><img src=x onerror="alert(2)">'
    const html = renderAuthErrorPage({ title: "RedCode", error: payload })
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;")
  })

  test("escapeHtml covers the HTML-sensitive character set", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;")
    expect(escapeHtml("invalid_grant")).toBe("invalid_grant")
    expect(escapeHtml("")).toBe("")
  })

  test("success page stays static and closes itself", () => {
    const html = renderAuthSuccessPage({ title: "ok" })
    expect(html).toContain("Authorization Successful")
    expect(html).toContain("window.close()")
  })
})
