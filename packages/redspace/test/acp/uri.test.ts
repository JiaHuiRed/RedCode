import { describe, expect, test } from "bun:test"
import { getNewContent, parseUri } from "../../src/acp/uri"

describe("acp.uri", () => {
  describe("parseUri", () => {
    test("file:// URI maps to a file content with basename and text/plain mime", () => {
      expect(parseUri("file:///home/user/project/src/main.rs")).toEqual({
        type: "file",
        url: "file:///home/user/project/src/main.rs",
        filename: "main.rs",
        mime: "text/plain",
      })
    })

    test("file:// URI without slashes keeps the raw string as filename", () => {
      expect(parseUri("file://nopath")).toEqual({
        type: "file",
        url: "file://nopath",
        filename: "nopath",
        mime: "text/plain",
      })
    })

    test("zed:// URI resolves the path search param to a file URL", () => {
      const parsed = parseUri("zed://editor?path=/repo/notes/todo.md")
      expect(parsed.type).toBe("file")
      if (parsed.type !== "file") return
      expect(parsed.filename).toBe("todo.md")
      expect(parsed.mime).toBe("text/plain")
      expect(parsed.url).toContain("todo.md")
      expect(parsed.url.startsWith("file:")).toBe(true)
    })

    test("zed:// URI without a path param falls back to text", () => {
      expect(parseUri("zed://editor")).toEqual({ type: "text", text: "zed://editor" })
    })

    test("plain strings stay text without touching the filesystem", () => {
      expect(parseUri("just some context")).toEqual({ type: "text", text: "just some context" })
      expect(parseUri("")).toEqual({ type: "text", text: "" })
    })

    test("unparseable URIs degrade to text instead of throwing", () => {
      // new URL() 对非法协议抛错 → catch 分支必须兜住
      expect(parseUri("zed://%%%invalid")).toEqual({ type: "text", text: "zed://%%%invalid" })
    })
  })

  describe("getNewContent", () => {
    test("applies a unified diff to the original content", () => {
      const original = "line one\nline two\n"
      const diff = ["--- a", "+++ b", "@@ -1,2 +1,2 @@", "-line one", "-line two", "+line ONE", "+line TWO", ""].join(
        "\n",
      )
      expect(getNewContent(original, diff)).toBe("line ONE\nline TWO\n")
    })

    test("returns undefined when the diff context does not match", () => {
      const original = "actual content\n"
      const diff = ["--- a", "+++ b", "@@ -1,1 +1,1 @@", "-expected context", "+replacement", ""].join("\n")
      expect(getNewContent(original, diff)).toBeUndefined()
    })
  })
})
