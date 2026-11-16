import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, ToolPart } from "@redcode-ai/sdk/v2"
import { collectTurnDeliverables } from "./turn-deliverables"

const message = (id: string, parentID = "user_1") => ({ id, parentID }) as AssistantMessage
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  status = "completed",
) =>
  ({
    id,
    messageID: "assistant_1",
    type: "tool",
    tool: name,
    state: { status, input, metadata },
  }) as ToolPart
const collect = (parts: Part[], directory = "/project") =>
  collectTurnDeliverables({
    userMessageID: "user_1",
    directory,
    messages: [message("assistant_1")],
    parts: () => parts,
  })

describe("turn deliverables", () => {
  test("only completed writes from this parent turn become outputs", () => {
    const parts = [
      tool("read", "read", { filePath: "/project/old.md" }),
      tool("pending", "write", { filePath: "/project/pending.md" }, {}, "running"),
      tool("failed", "write", { filePath: "/project/failed.md" }, {}, "error"),
      tool("write", "write", { filePath: "/project/brief.md" }, { exists: false }),
      tool("shell", "bash", { command: "echo generated > output.html" }),
    ]
    const result = collectTurnDeliverables({
      userMessageID: "user_1",
      directory: "/project",
      messages: [message("assistant_1"), message("other", "steering_receipt")],
      parts: (id) => (id === "assistant_1" ? parts : [tool("other", "write", { filePath: "/project/other.md" })]),
    })
    expect(result.map((file) => file.path)).toEqual(["brief.md"])
    expect(result[0]?.change).toBe("created")
  })

  test("keeps one card for repeated edits, points to the latest operation and preserves creation", () => {
    const result = collect([
      tool("write", "write", { filePath: "plan.md" }, { exists: false, filepath: "/project/plan.md" }),
      tool("edit", "edit", {}, { filediff: { file: "/project/plan.md" } }),
    ])
    expect(result).toEqual([
      { path: "plan.md", kind: "document", change: "created", messageID: "assistant_1", partID: "edit" },
    ])
  })

  test("patch deletions and moves remove obsolete targets, while later recreation remains visible", () => {
    const result = collect([
      tool("old", "write", { filePath: "old.html" }, { exists: false }),
      tool("gone", "write", { filePath: "gone.md" }, { exists: false }),
      tool(
        "patch",
        "apply_patch",
        {},
        {
          files: [
            { filePath: "/project/old.html", movePath: "/project/site/index.html", type: "move" },
            { filePath: "/project/gone.md", type: "delete" },
            { filePath: "/project/added.ts", type: "add" },
          ],
        },
      ),
      tool("again", "write", { filePath: "gone.md" }, { exists: false }),
    ])
    expect(result.map((file) => [file.path, file.change])).toEqual([
      ["site/index.html", "moved"],
      ["gone.md", "created"],
      ["added.ts", "created"],
    ])
    expect(result.find((file) => file.path === "site/index.html")?.partID).toBe("patch")
  })

  test("Windows separators and casing deduplicate without corrupting literal filename characters", () => {
    const result = collect(
      [
        tool("a", "write", { filePath: "c:\\Work\\docs\\100%#1.md" }),
        tool("b", "edit", { filePath: "C:/WORK/docs/100%#1.md" }),
      ],
      "C:\\Work",
    )
    expect(result.map((file) => file.path)).toEqual(["docs/100%#1.md"])
    expect(result[0]?.partID).toBe("b")
  })

  test("does not misroute external or escaping paths into the workspace preview", () => {
    expect(
      collect([
        tool("a", "write", { filePath: "/project-other/a.md" }),
        tool("b", "write", { filePath: "../outside.md" }),
        tool("c", "write", { filePath: "docs/../../outside.md" }),
        tool("d", "write", { filePath: "docs/../report.md" }),
        tool("e", "write", { filePath: "literal\\name.md" }),
      ]).map((file) => file.path),
    ).toEqual(["report.md", "literal\\name.md"])
  })

  test("readable results come before code, and write alone never invents a creation claim", () => {
    const result = collect([
      tool("code", "edit", { filePath: "src/index.ts" }),
      tool("doc", "write", { filePath: "brief.md" }),
      tool("page", "write", { filePath: "index.HTML" }),
      tool("image", "write", { filePath: "diagram.svg" }),
    ])
    expect(result.map((file) => file.kind)).toEqual(["document", "page", "image", "file"])
    expect(result.every((file) => file.change === "updated")).toBe(true)
  })
})
