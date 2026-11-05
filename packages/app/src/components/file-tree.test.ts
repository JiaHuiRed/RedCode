import { beforeAll, describe, expect, mock, test } from "bun:test"
import * as solidJsRouter from "@solidjs/router"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand
let listLevelNodes: typeof import("./file-tree").listLevelNodes
let visibleTreeNodes: typeof import("./file-tree").visibleTreeNodes
let moveTreeCursor: typeof import("./file-tree").moveTreeCursor
let resolveTreeCursor: typeof import("./file-tree").resolveTreeCursor

beforeAll(async () => {
  // 261013 Red 残缺 mock 会被同进程后加载的测试文件消费（261003、261012 两犯）；
  // factory 的 original 实参是 undefined，必须静态 import 真模块展开。
  mock.module("@solidjs/router", () => ({
    ...solidJsRouter,
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tree: {
        state: () => undefined,
        list: () => Promise.resolve(),
        children: () => [],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  mock.module("@redcode-ai/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  mock.module("@redcode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
  mock.module("@redcode-ai/ui/icon", () => ({ Icon: () => null }))
  mock.module("@redcode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
  listLevelNodes = mod.listLevelNodes
  visibleTreeNodes = mod.visibleTreeNodes
  moveTreeCursor = mod.moveTreeCursor
  resolveTreeCursor = mod.resolveTreeCursor
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})

// 261106 Red 树键盘导航纯函数：单层切片、可见平铺、光标决策
describe("file tree keyboard navigation", () => {
  type FileNodeLike = import("@redcode-ai/sdk/v2").FileNode
  // 真实 FileNode 的 name 是叶子名（basename），不是完整路径——排序按 name 走
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
  const dir = (path: string): FileNodeLike => ({
    name: nameOf(path),
    path,
    absolute: path,
    type: "directory",
    ignored: false,
  })
  const file = (path: string): FileNodeLike => ({
    name: nameOf(path),
    path,
    absolute: path,
    type: "file",
    ignored: false,
  })

  test("listLevelNodes synthesizes filtered entries and sorts dirs first", () => {
    const nodes = listLevelNodes({
      children: [file("/r/b.ts")],
      filter: { files: new Set(["/r/a.ts", "/r/b.ts"]), dirs: new Set(["/r/src"]) },
      parentPath: "/r",
    })
    expect(nodes.map((node) => node.path)).toEqual(["/r/src", "/r/a.ts", "/r/b.ts"])
  })

  test("listLevelNodes passes through unfiltered children", () => {
    const children = [dir("/r/src"), file("/r/a.ts")]
    expect(listLevelNodes({ children, parentPath: "/r" })).toBe(children)
  })

  test("visibleTreeNodes walks expanded dirs in DFS order and respects chain guard", () => {
    const tree: Record<string, FileNodeLike[]> = {
      "/r": [dir("/r/src"), file("/r/readme.md")],
      "/r/src": [dir("/r/src/nested"), file("/r/src/a.ts")],
      "/r/src/nested": [file("/r/src/nested/deep.ts")],
    }
    const visible = visibleTreeNodes({
      path: "/r",
      chain: ["/r"],
      level: 0,
      children: (dir) => tree[dir] ?? [],
      expanded: (dir) => dir === "/r/src" || dir === "/r/src/nested",
    })
    expect(visible.map((node) => node.path)).toEqual([
      "/r/src",
      "/r/src/nested",
      "/r/src/nested/deep.ts",
      "/r/src/a.ts",
      "/r/readme.md",
    ])

    // chain 环路：nested 已在链上时不深入（与渲染 "..." fallback 一致）
    const guarded = visibleTreeNodes({
      path: "/r/src/nested",
      chain: ["/r", "/r/src", "/r/src/nested"],
      level: 2,
      children: (dir) => tree[dir] ?? [],
      expanded: () => true,
    })
    expect(guarded.map((node) => node.path)).toEqual(["/r/src/nested/deep.ts"])
  })

  test("moveTreeCursor arrows/home/end", () => {
    const visible = [dir("/a"), dir("/a/b"), file("/a/b/c.ts"), file("/a/d.ts")]
    const input = { visible, expanded: () => false, rootPath: "/a" }

    expect(moveTreeCursor({ ...input, key: "arrowdown", current: "/a" })).toBe("/a/b")
    expect(moveTreeCursor({ ...input, key: "arrowdown", current: "/a/d.ts" })).toBe("/a/d.ts")
    expect(moveTreeCursor({ ...input, key: "arrowup", current: "/a/b" })).toBe("/a")
    expect(moveTreeCursor({ ...input, key: "arrowup", current: "/a" })).toBe("/a")
    expect(moveTreeCursor({ ...input, key: "home", current: "/a/d.ts" })).toBe("/a")
    expect(moveTreeCursor({ ...input, key: "end", current: "/a" })).toBe("/a/d.ts")
    expect(moveTreeCursor({ ...input, key: "arrowdown", current: undefined })).toBe("/a")
  })

  test("moveTreeCursor right expands collapsed and enters expanded; left collapses or walks to parent", () => {
    const expanded = new Set<string>(["/a"])
    const visible = [dir("/a"), dir("/a/b"), file("/a/b/c.ts"), file("/a/d.ts")]
    const expandCalls: string[] = []
    const collapseCalls: string[] = []
    const input = {
      visible,
      expanded: (path: string) => expanded.has(path),
      expand: (path: string) => {
        expandCalls.push(path)
        expanded.add(path)
      },
      collapse: (path: string) => {
        collapseCalls.push(path)
        expanded.delete(path)
      },
      rootPath: "/a",
    }

    // 折叠目录 Right = 展开、光标不动
    expect(moveTreeCursor({ ...input, key: "arrowright", current: "/a/b" })).toBe("/a/b")
    expect(expandCalls).toEqual(["/a/b"])
    // 展开目录 Right = 进入首个子项
    expect(moveTreeCursor({ ...input, key: "arrowright", current: "/a" })).toBe("/a/b")
    // 文件 Right 不动
    expect(moveTreeCursor({ ...input, key: "arrowright", current: "/a/b/c.ts" })).toBe("/a/b/c.ts")
    // 展开目录 Left = 折叠、光标不动
    expect(moveTreeCursor({ ...input, key: "arrowleft", current: "/a/b" })).toBe("/a/b")
    expect(collapseCalls).toEqual(["/a/b"])
    // 非展开项 Left = 走到父目录
    expect(moveTreeCursor({ ...input, key: "arrowleft", current: "/a/b/c.ts" })).toBe("/a/b")
    // 根层节点的父是 rootPath，不动
    expect(moveTreeCursor({ ...input, key: "arrowleft", current: "/a/d.ts" })).toBe("/a/d.ts")
  })

  // 261106 Red 审计 P2-01：Windows 原生反斜杠路径（服务端 file.list 的 path.relative
  // 在 win32 返回反斜杠），父子查找必须双分隔符，否则 Left 无法返回父目录
  test("arrowleft walks to the parent on Windows backslash paths", () => {
    const visible = [dir("src"), dir("src\\lib"), file("src\\lib\\main.tsx")]
    const input = { visible, expanded: () => false, rootPath: "src" }
    expect(moveTreeCursor({ ...input, key: "arrowleft", current: "src\\lib\\main.tsx" })).toBe("src\\lib")
    // 首层节点的父即根，原地不动
    expect(moveTreeCursor({ ...input, key: "arrowleft", current: "src\\lib" })).toBe("src\\lib")
  })

  test("listLevelNodes places filtered entries under backslash parents", () => {
    const nodes = listLevelNodes({
      children: [],
      filter: { files: new Set(["src\\main.tsx"]), dirs: new Set(["src\\lib"]) },
      parentPath: "src",
    })
    expect(nodes.map((node) => node.path)).toEqual(["src\\lib", "src\\main.tsx"])
  })

  // 261106 Red 审计 P2-02：展开但没有可见子项（空目录/过滤后无子项）时，
  // 下一个可见节点是兄弟，Right 不得越级跳到兄弟
  test("arrowright on an expanded directory without visible children stays put", () => {
    const expanded = new Set<string>(["src", "src/empty"])
    const input = {
      visible: [dir("src"), dir("src/empty"), file("src/main.ts")],
      expanded: (path: string) => expanded.has(path),
      rootPath: "src",
    }
    expect(moveTreeCursor({ ...input, key: "arrowright", current: "src/empty" })).toBe("src/empty")
    // 对照：有可见子项时仍进入首子项
    const withChild = [dir("src"), dir("src/empty"), file("src/empty/child.ts"), file("src/main.ts")]
    expect(
      moveTreeCursor({ ...input, visible: withChild, key: "arrowright", current: "src/empty" }),
    ).toBe("src/empty/child.ts")
  })

  // 261106 Red 审计 P2-03：光标节点从可见集合消失（过滤/折叠/刷新）时回退，
  // 根层把 Tab 停靠点让给首个可见节点，不再整树 tabindex=-1 无入口
  test("resolveTreeCursor drops a cursor that left the visible set", () => {
    const visible = [dir("/a"), file("/a/b.ts")]
    expect(resolveTreeCursor({ cursor: "/a", visible })).toBe("/a")
    expect(resolveTreeCursor({ cursor: "/a/removed.ts", visible })).toBeUndefined()
    expect(resolveTreeCursor({ cursor: undefined, visible })).toBeUndefined()
  })
})
