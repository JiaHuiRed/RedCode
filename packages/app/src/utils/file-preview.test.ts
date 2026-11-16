import { describe, expect, test } from "bun:test"
import { htmlPreviewDocument } from "./file-preview"

describe("HTML browser preview", () => {
  test("keeps the original document inside an opaque-origin sandbox", () => {
    const source = '<h1>中文表格 & "源码"</h1><script>window.parent.injected=true</script>'
    const document = new DOMParser().parseFromString(htmlPreviewDocument(source), "text/html")
    const iframe = document.querySelector("iframe")!
    expect(iframe.getAttribute("srcdoc")).toBe(source)
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(document.querySelectorAll("script")).toHaveLength(0)
  })

  test("source cannot escape the iframe attribute or enable same-origin privileges", () => {
    const source = '" sandbox="allow-same-origin" srcdoc=""><script>evil()</script></iframe>'
    const document = new DOMParser().parseFromString(htmlPreviewDocument(source), "text/html")
    expect(document.querySelectorAll("iframe")).toHaveLength(1)
    expect(document.querySelectorAll("script")).toHaveLength(0)
    expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toBe(source)
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts")
  })
})
