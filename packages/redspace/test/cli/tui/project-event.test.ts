import { describe, expect, test } from "bun:test"
import { isProjectEvent } from "../../../src/cli/cmd/tui/context/event"

const scope = { directory: "E:/projects/A", project: "same-git-root", workspaces: ["child-A"] }

describe("TUI project events", () => {
  test("does not mix separate directories even when git project IDs match", () => {
    expect(isProjectEvent({ directory: "E:/projects/B", project: "same-git-root" }, scope)).toBe(false)
    expect(isProjectEvent({ directory: "E:/projects/A", project: "same-git-root" }, scope)).toBe(true)
  })

  test("keeps global events and known child workspace requests", () => {
    expect(isProjectEvent({ directory: "global" }, scope)).toBe(true)
    expect(
      isProjectEvent(
        {
          directory: "E:/tasks/child-A",
          project: "same-git-root",
          workspace: "child-A",
        },
        scope,
      ),
    ).toBe(true)
    expect(
      isProjectEvent(
        {
          directory: "E:/tasks/child-B",
          project: "same-git-root",
          workspace: "child-B",
        },
        scope,
      ),
    ).toBe(false)
  })

  test("keeps directory-less attach project filtering", () => {
    expect(isProjectEvent({ directory: "/remote/A", project: "A" }, { project: "A", workspaces: [] })).toBe(true)
    expect(isProjectEvent({ directory: "/remote/B", project: "B" }, { project: "A", workspaces: [] })).toBe(false)
  })
})
