import { describe, expect, test } from "bun:test"
import { normalize, resolveFileDiff, text } from "./session-diff"

describe("session diff", () => {
  test("keeps unified patch content", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(view.fileDiff.name).toBe("a.ts")
    expect(text(view, "deletions")).toBe("one\ntwo\n")
    expect(text(view, "additions")).toBe("one\nthree\n")
  })

  test("keeps missing final newlines from unified patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(text(view, "deletions")).toBe("one\ntwo")
    expect(text(view, "additions")).toBe("one\nthree")
  })

  test("renders whole-file VCS patches as complete diffs", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-old\n+new\n",
    })

    expect(fileDiff.isPartial).toBe(false)
    expect(fileDiff.additionLines).toEqual(["one\n", "new\n"])
  })

  test("keeps ordinary leading tool patches partial", () => {
    const fileDiff = resolveFileDiff({
      file: "a.ts",
      patch:
        "Index: a.ts\n===================================================================\n--- a.ts\n+++ a.ts\n@@ -1,5 +1,5 @@\n-old\n+new\n two\n three\n four\n five\n",
    })

    expect(fileDiff.isPartial).toBe(true)
    expect(fileDiff.additionLines).toEqual(["new\n", "two\n", "three\n", "four\n", "five\n"])
  })

  test("converts legacy content into a patch", () => {
    const diff = {
      file: "a.ts",
      before: "one\n",
      after: "two\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toContain("@@ -1,1 +1,1 @@")
    expect(text(view, "deletions")).toBe("one\n")
    expect(text(view, "additions")).toBe("two\n")
  })

  test("ignores malformed persisted patches", () => {
    const diff = {
      file: "a.ts",
      patch:
        "diff --git a/a.ts b/a.ts\nindex ff4ceb2..65a1de0 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n keep\n+add\n same\r",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }
    const view = normalize(diff)

    expect(view.patch).toBe(diff.patch)
    expect(text(view, "deletions")).toBe("")
    expect(text(view, "additions")).toBe("")
  })
})
