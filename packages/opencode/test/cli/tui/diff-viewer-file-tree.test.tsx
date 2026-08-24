/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { DiffViewerFileTree } from "../../../src/cli/cmd/tui/feature-plugins/system/diff-viewer-file-tree"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
} from "../../../src/cli/cmd/tui/feature-plugins/system/diff-viewer-file-tree-utils"

const theme = {
  background: RGBA.fromHex("#000000"),
  backgroundPanel: RGBA.fromHex("#111111"),
  backgroundElement: RGBA.fromHex("#333333"),
  primary: RGBA.fromHex("#00ffff"),
  secondary: RGBA.fromHex("#0088ff"),
  selectedListItemText: RGBA.fromHex("#ffffff"),
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
}

describe("DiffViewerFileTree", () => {
  test("renders sorted hierarchical file rows", async () => {
    const app = await testRender(
      () =>
        withTheme(() => (
          <DiffViewerFileTree
            width={32}
            files={[
              { file: "z-file.ts" },
              { file: "b/file.ts" },
              { file: "a/zeta.ts" },
              { file: "b/alpha.ts" },
              { file: "a/alpha.ts" },
            ]}
            loading={false}
            error={undefined}
            theme={theme}
            focused={true}
          />
        )),
      { width: 40, height: 20 },
    )

    try {
      await renderOnceSettled(app)
      const lines = visibleLines(app.captureCharFrame())

      expect(lines).toEqual([
        "▾ a",
        "│  ├─ alpha.ts               ?",
        "│  └─ zeta.ts                ?",
        "├─ ▾ b",
        "│  ├─ alpha.ts               ?",
        "│  └─ file.ts                ?",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps loading and error quiet while rendering an empty settled state", async () => {
    const loading = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={true} error={undefined} theme={theme} />
    ))
    const failed = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={new Error("nope")} theme={theme} />
    ))
    const empty = await renderFrame(() => (
      <DiffViewerFileTree width={32} files={[]} loading={false} error={undefined} theme={theme} />
    ))

    expect(loading).not.toContain("Loading diff...")
    expect(loading).not.toContain("No files")
    expect(failed).not.toContain("Failed to load diff")
    expect(failed).not.toContain("No files")
    expect(empty).toContain("No files")
  })

  test("does not render text markers for highlighted rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const src = buildFileTree(files).nodes.find((node) => node.kind === "directory" && node.name === "src")!

    const focused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree
          width={32}
          files={files}
          loading={false}
          error={undefined}
          theme={theme}
          focused
          highlightedNode={src.id}
        />
      )),
    )
    const unfocused = visibleLines(
      await renderFrame(() => (
        <DiffViewerFileTree width={32} files={files} loading={false} error={undefined} theme={theme} />
      )),
    )

    expect(focused).toContain("▾ src/config")
    expect(unfocused).toContain("▾ src/config")
    expect(focused.some((line) => line.includes("*"))).toBe(false)
    expect(unfocused.some((line) => line.includes("*"))).toBe(false)
  })

  test("renders collapsed and expanded directory rows", async () => {
    const files = [{ file: "src/config/tui.ts" }, { file: "README.md" }]
    const tree = buildFileTree(files)
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const collapsed = allExpandedFileTreeDirectories(tree)
    collapsed.delete(src.id)

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            width={32}
            files={files}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={collapsed}
          />
        )),
      ),
    ).toEqual(["▸ src/config"])

    expect(
      visibleLines(
        await renderFrame(() => (
          <DiffViewerFileTree
            files={files}
            width={32}
            loading={false}
            error={undefined}
            theme={theme}
            expandedNodes={allExpandedFileTreeDirectories(tree)}
          />
        )),
      ),
    ).toEqual(["▾ src/config", "│  └─ tui.ts                 ?"])
  })
})

async function renderFrame(component: () => JSX.Element) {
  const app = await testRender(() => withTheme(component), { width: 40, height: 10 })
  try {
    await renderOnceSettled(app)
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

// 260824 cc 沉降判据，不是固定帧预算。
//
// 原写法是 renderOnce → setTimeout(25) → renderOnce。实测（20 轮探针，量"渲染出
// 可见内容"的耗时）：min 15ms / p50 18ms / p90 26ms / max 47ms —— **25ms 正好压在
// p90 上**，约每 10 次渲染输一次；本文件一轮跑 3~4 次渲染，于是三成多的运行会挂，
// 且挂哪一条随机（实测 3/1→4/0→4/0→3/1 交替）。失败形态是断言收到 []：画面还没
// 渲出来就被 captureCharFrame 抓走了。
//
// 根因是 KVProvider 要异步读盘（测试 temp home 里 kv.json 通常不存在、走 ENOENT
// 回落，日志里那串 "Failed to read KV state" 在通过的轮次里同样刷屏，是噪音不是
// 原因），这段延迟随机器负载浮动，任何固定值都是赌。
//
// 三条腿：① 出现可见内容即停——tests 1/3/4 与 "No files" 走这条，约 20ms 返回；
// ② loading/error 分支渲染的是空 <text/>、本就没有可见内容，靠画面连续 STABLE_MS
// 不变收尾（250ms，远高于实测 max 47ms，不会误判成"还没渲完"）；③ 两者都不满足
// 时由 BUDGET_MS 兜底，避免无限等。
async function renderOnceSettled(app: Awaited<ReturnType<typeof testRender>>) {
  const BUDGET_MS = 2000
  const STABLE_MS = 250
  const POLL_MS = 2

  const deadline = performance.now() + BUDGET_MS
  await app.renderOnce()
  let last = app.captureCharFrame()
  let stableSince = performance.now()

  while (performance.now() < deadline) {
    if (visibleLines(last).length > 0) break
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame !== last) {
      last = frame
      stableSince = performance.now()
      continue
    }
    if (performance.now() - stableSince >= STABLE_MS) break
  }

  await app.renderOnce()
}

function withTheme(component: () => JSX.Element) {
  return (
    <TuiConfigProvider config={createTuiResolvedConfig()}>
      <KVProvider>
        <ThemeProvider mode="dark">{component()}</ThemeProvider>
      </KVProvider>
    </TuiConfigProvider>
  )
}

function visibleLines(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) => line.replace(/^ ?│ ?/, "").replace(/[ │]*$/, ""))
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .filter((line) => line.length > 0 && !/^┌|^└|^─+$/.test(line))
}
