import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { useLanguage } from "@/context/language"
import { Collapsible } from "@redcode-ai/ui/collapsible"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { Icon } from "@redcode-ai/ui/icon"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type ParentProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@redcode-ai/sdk/v2"

const MAX_DEPTH = 128

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

// 261106 Red 树键盘导航（WAI-ARIA treeview）：三个纯函数支撑——单层列表（渲染与
// 漫游共用同一口径）、可见节点平铺（沿展开目录 DFS）、光标移动决策（不落 DOM，
// 组件层只负责 focus 与 expand/collapse 副作用）。

// 261106 Red 审计 P2-01：file.normalize 刻意保留 Windows 原生分隔符（服务端
// file.list 的 path.relative 在 win32 返回反斜杠），父子/叶子查找必须同时
// 识别 / 与 \，lastIndexOf("/") 在 Windows 下找不到分隔符。
const parentPathOf = (path: string) => {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx === -1 ? "" : path.slice(0, idx)
}
const leafNameOf = (path: string) => {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return idx === -1 ? path : path.slice(idx + 1)
}

/** 单层节点列表：store children + filter 合成 + 排序，渲染 memo 与漫游 walker 共用。 */
export function listLevelNodes(input: { children: FileNode[]; filter?: Filter; parentPath: string }): FileNode[] {
  const current = input.filter
  if (!current) return input.children

  const out = input.children.filter((node) => {
    if (node.type === "file") return current.files.has(node.path)
    return current.dirs.has(node.path)
  })

  const seen = new Set(out.map((node) => node.path))

  for (const dir of current.dirs) {
    if (parentPathOf(dir) !== input.parentPath) continue
    if (seen.has(dir)) continue
    out.push({
      name: leafNameOf(dir),
      path: dir,
      absolute: dir,
      type: "directory",
      ignored: false,
    })
    seen.add(dir)
  }

  for (const item of current.files) {
    if (parentPathOf(item) !== input.parentPath) continue
    if (seen.has(item)) continue
    out.push({
      name: leafNameOf(item),
      path: item,
      absolute: item,
      type: "file",
      ignored: false,
    })
    seen.add(item)
  }

  out.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return out
}

/** 可见节点平铺：沿展开目录 DFS，chain 环路与 MAX_DEPTH 守卫与渲染 fallback（"..."）一致。 */
export function visibleTreeNodes(input: {
  path: string
  filter?: Filter
  chain: readonly string[]
  level: number
  children: (dir: string) => FileNode[]
  expanded: (dir: string) => boolean
}): FileNode[] {
  const out: FileNode[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number) => {
    if (depth >= MAX_DEPTH) return
    for (const node of listLevelNodes({ children: input.children(dir), filter: input.filter, parentPath: dir })) {
      out.push(node)
      if (node.type !== "directory") continue
      if (!input.expanded(node.path)) continue
      const id = node.path.replace(/[\\/]+$/, "").replaceAll("\\", "/")
      if (seen.has(id) || input.chain.includes(id)) continue
      seen.add(id)
      walk(node.path, depth + 1)
    }
  }
  walk(input.path, input.level)
  return out
}

export type TreeNavKey = "arrowdown" | "arrowup" | "arrowright" | "arrowleft" | "home" | "end"

/** 光标移动决策：返回新的光标 path；expand/collapse 副作用经 hooks 回调，方便单测。 */
export function moveTreeCursor(input: {
  key: TreeNavKey
  visible: FileNode[]
  current: string | undefined
  expanded: (dir: string) => boolean
  expand?: (dir: string) => void
  collapse?: (dir: string) => void
  rootPath: string
}): string | undefined {
  const { visible, current } = input
  if (visible.length === 0) return current
  const index = current ? visible.findIndex((node) => node.path === current) : -1

  switch (input.key) {
    case "arrowdown":
      return visible[Math.min(visible.length - 1, index + 1)]?.path ?? current
    case "arrowup":
      return visible[Math.max(0, index <= 0 ? 0 : index - 1)]?.path ?? current
    case "home":
      return visible[0]?.path
    case "end":
      return visible[visible.length - 1]?.path
    case "arrowright": {
      const node = visible[index]
      if (!node || node.type !== "directory") return current
      if (!input.expanded(node.path)) {
        input.expand?.(node.path)
        return current
      }
      // 已展开：下一个可见节点是首个子项才进入（DFS 序）；空目录/过滤后无可见
      // 子项时下一个是兄弟节点，不得越级（审计 P2-02），保持光标原位。
      const next = visible[Math.min(visible.length - 1, index + 1)]?.path
      return next !== undefined && parentPathOf(next) === node.path ? next : current
    }
    case "arrowleft": {
      const node = visible[index]
      if (!node) return current
      if (node.type === "directory" && input.expanded(node.path)) {
        input.collapse?.(node.path)
        return current
      }
      const parent = parentPathOf(node.path)
      if (!parent || parent === input.rootPath) return current
      return visible.some((item) => item.path === parent) ? parent : current
    }
  }
}

/**
 * 261106 Red 审计 P2-03：roving tabindex 失效光标恢复——光标节点因过滤、目录折叠或
 * 刷新从可见集合消失时返回 undefined，根层把 Tab 停靠点让给首个可见节点，
 * 整棵树始终有且只有一个有效 Tab 入口，不再出现全 -1 无入口的死角。
 */
export function resolveTreeCursor(input: { cursor: string | undefined; visible: FileNode[] }): string | undefined {
  if (!input.cursor) return undefined
  return input.visible.some((node) => node.path === input.cursor) ? input.cursor : undefined
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      nodeClass?: string
      draggable: boolean
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "nodeClass",
    "draggable",
    "kinds",
    "marks",
    "as",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => !!kind() && !local.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <Dynamic
      component={local.as ?? "div"}
      classList={{
        "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.children}
      <span
        classList={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weaker": local.node.ignored,
          "text-text-weak": !local.node.ignored && !active(),
        }}
        style={active() ? color() : undefined}
      >
        {local.node.name}
      </span>
      {(() => {
        const value = kind()
        if (!value) return null
        if (local.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
    </Dynamic>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
  /** 261106 Red 树键盘导航：光标 path，根实例持有、经此透传给嵌套层（与 _chain 同模式） */
  _cursor?: () => string | undefined
}) {
  const file = useFile()
  const language = useLanguage()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]
  const isRoot = !props._chain

  // 261106 Red 键盘漫游（roving tabindex）：光标落在哪个节点，哪个节点 tabindex=0，
  // 其余全部 -1——深层目录不再需要按 N 次 Tab 穿透。光标未初始化时首层第一个节点可 Tab。
  const [cursor, setCursor] = createSignal<string | undefined>(undefined)
  const rovingCursor = props._cursor ?? cursor

  // 261106 Red 审计 P2-03：整树可见平铺只在根实例求值（嵌套实例的 tabStop 不经过它，
  // memo 惰性创建零成本），用于失效光标恢复判定。
  const allVisible = createMemo(() =>
    visibleTreeNodes({
      path: props.path,
      filter: filter(),
      chain,
      level,
      children: (dir) => file.tree.children(dir),
      expanded: (dir) => file.tree.state(dir)?.expanded ?? false,
    }),
  )

  const tabStop = (path: string) => {
    const current = rovingCursor()
    // 261106 Red 审计 P2-03：根层做失效光标恢复；嵌套层只做精确匹配——恢复出的
    // 唯一停靠点由根层首个可见节点承担，嵌套层不得补第二个入口。
    const effective = isRoot ? resolveTreeCursor({ cursor: current, visible: allVisible() }) : current
    if (effective) return effective === path
    return isRoot && nodes()[0]?.path === path
  }

  let rootRef: HTMLDivElement | undefined

  const handleTreeFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement
    const path = target.closest?.("[data-tree-node]")?.getAttribute("data-tree-node")
    if (path) setCursor(path)
  }

  const handleTreeKeydown = (event: KeyboardEvent) => {
    const navKeys: Record<string, TreeNavKey> = {
      ArrowDown: "arrowdown",
      ArrowUp: "arrowup",
      ArrowRight: "arrowright",
      ArrowLeft: "arrowleft",
      Home: "home",
      End: "end",
    }
    const nav = navKeys[event.key]
    if (!nav) return
    const visible = visibleTreeNodes({
      path: props.path,
      filter: filter(),
      chain,
      level,
      children: (dir) => file.tree.children(dir),
      expanded: (dir) => file.tree.state(dir)?.expanded ?? false,
    })
    if (visible.length === 0) return
    const next = moveTreeCursor({
      key: nav,
      visible,
      current: rovingCursor(),
      expanded: (dir) => file.tree.state(dir)?.expanded ?? false,
      expand: (dir) => file.tree.expand(dir),
      collapse: (dir) => file.tree.collapse(dir),
      rootPath: props.path,
    })
    event.preventDefault()
    if (!next || next === rovingCursor()) return
    setCursor(next)
    rootRef?.querySelector<HTMLElement>(`[data-tree-node="${CSS.escape(next)}"]`)?.focus()
  }

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      // 260923 Red 逐段累加父路径，替代每个父级 slice+join 的 O(depth²) 字符串构造；
      // 首段为空（绝对路径）时保持 join 语义：第二段起得到 "/foo" 而不是 "foo"
      let dir = ""
      for (let i = 0; i < parts.length - 1; i++) {
        dir = i === 0 ? parts[0]! : `${dir}/${parts[i]}`
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    // 261106 Red 切片逻辑抽到 listLevelNodes：键盘漫游 walker 与渲染共用同一口径
    return listLevelNodes({ children: file.tree.children(props.path), filter: filter(), parentPath: props.path })
  })

  return (
    <div
      data-component="filetree"
      class={`flex flex-col gap-0.5 ${props.class ?? ""}`}
      // 261106 Red treeview 语义：根容器 role=tree，键盘与焦点同步只在根实例挂（嵌套实例
      // 的事件会冒泡上来，避免同一按键被处理两次）。
      ref={rootRef}
      role={isRoot ? "tree" : undefined}
      aria-label={isRoot ? language.t("home.shortcuts.fileTree") : undefined}
      onKeyDown={isRoot ? handleTreeKeydown : undefined}
      onFocusIn={isRoot ? handleTreeFocusIn : undefined}
    >
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => !!kind() && !node.ignored

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <Collapsible
                  variant="ghost"
                  class="w-full"
                  data-scope="filetree"
                  forceMount={false}
                  open={expanded()}
                  onOpenChange={(open) => (open ? file.tree.expand(node.path) : file.tree.collapse(node.path))}
                >
                  <Collapsible.Trigger
                    role="treeitem"
                    aria-level={level + 1}
                    tabindex={tabStop(node.path) ? 0 : -1}
                    data-tree-node={node.path}
                  >
                    <FileTreeNode
                      node={node}
                      level={level}
                      active={props.active}
                      nodeClass={props.nodeClass}
                      draggable={draggable()}
                      kinds={kinds()}
                      marks={marks()}
                    >
                      <div class="size-4 flex items-center justify-center text-icon-weak">
                        <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                      </div>
                    </FileTreeNode>
                  </Collapsible.Trigger>
                  <Collapsible.Content class="relative pt-0.5" role="group">
                    <div
                      classList={{
                        "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                        "group-hover/filetree:opacity-100": expanded() && deep() === level,
                        "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                      }}
                      style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                    />
                    <Show
                      when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                      fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                    >
                      <FileTree
                        path={node.path}
                        level={level + 1}
                        allowed={props.allowed}
                        modified={props.modified}
                        kinds={props.kinds}
                        active={props.active}
                        draggable={props.draggable}
                        onFileClick={props.onFileClick}
                        _filter={filter()}
                        _marks={marks()}
                        _deeps={deeps()}
                        _kinds={kinds()}
                        _chain={chain}
                        _cursor={rovingCursor}
                      />
                    </Show>
                  </Collapsible.Content>
                </Collapsible>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  nodeClass={props.nodeClass}
                  draggable={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  as="button"
                  type="button"
                  onClick={() => props.onFileClick?.(node)}
                  role="treeitem"
                  aria-level={level + 1}
                  aria-selected={node.path === props.active}
                  tabindex={tabStop(node.path) ? 0 : -1}
                  data-tree-node={node.path}
                >
                  <div class="w-4 shrink-0" />
                  <Switch>
                    <Match when={node.ignored}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style="color: var(--icon-weak-base)"
                        mono
                      />
                    </Match>
                    <Match when={active()}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style={kindTextColor(kind()!)}
                        mono
                      />
                    </Match>
                    <Match when={!node.ignored}>
                      <span class="filetree-iconpair size-4">
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--color opacity-0 group-hover/filetree:opacity-100"
                        />
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--mono group-hover/filetree:opacity-0"
                          mono
                        />
                      </span>
                    </Match>
                  </Switch>
                </FileTreeNode>
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )
}
