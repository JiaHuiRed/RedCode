import path from "path"
import { createMemo, createSignal, onMount } from "solid-js"
import { useProjectNavigation, projectDirectoryKey } from "../context/project-navigation"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { createStore } from "solid-js/store"

export function DialogProjectSelect(props: { codeOnly?: boolean } = {}) {
  const navigation = useProjectNavigation()!
  const dialog = useDialog()
  const toast = useToast()
  const route = useRoute()
  const [query, setQuery] = createSignal("")
  const [toDelete, setToDelete] = createSignal<string>()
  const [projects, setProjects] = createSignal<{ worktree: string; name: string }[]>([])
  const sdk = props.codeOnly ? useSDK() : undefined
  const [personal, setPersonal] = createStore({
    directories: [] as string[],
    loading: props.codeOnly === true,
    error: "",
  })
  onMount(() => {
    setProjects(navigation.projects())
    if (!sdk) return
    void sdk.client.companion.list({ throwOnError: true }).then(
      (result) =>
        setPersonal({
          directories: result.data.map((profile) => projectDirectoryKey(profile.directory)),
          loading: false,
        }),
      (error) => setPersonal({ error: error instanceof Error ? error.message : String(error), loading: false }),
    )
  })

  const options = createMemo(() => {
    if (personal.loading || personal.error) return []
    const seen = new Set<string>()
    // 261110 Red 「已删除」的工作区要从最近记录和项目表两处一起隐藏，否则删完立刻又冒出来。
    const ignored = navigation.ignoredKeys()
    const entries = [
      ...(navigation.directory()
        ? [{ directory: navigation.directory()!, name: path.basename(navigation.directory()!) }]
        : []),
      ...navigation.recent(),
      ...projects().map((entry) => ({ directory: entry.worktree, name: entry.name })),
    ].filter((entry) => {
      const key = projectDirectoryKey(entry.directory)
      if (props.codeOnly && personal.directories.includes(key)) return false
      if (seen.has(key)) return false
      seen.add(key)
      return !ignored.has(key)
    })
    const needle = query().toLowerCase()
    // 261110 Red 搜索命不中「添加工作区」时不能留在首位：列表始终从第 0 项起步，
    // 用户输入路径片段后回车会打开添加面板而不是切到真正的目标工作区。
    const add: DialogSelectOption<string>[] = "添加工作区… 打开已有目录".toLowerCase().includes(needle)
      ? [{ title: "添加工作区…", value: "", description: "打开已有目录" }]
      : []
    return [
      ...add,
      ...entries
        .filter((entry) => `${entry.name ?? ""} ${entry.directory}`.toLowerCase().includes(needle))
        .map((entry): DialogSelectOption<string> => {
          const status = navigation.summary(entry.directory)
          const state = status.waiting
            ? `${status.waiting} 项等待确认`
            : status.busy
              ? `${status.busy} 项运行中`
              : undefined
          return {
            title: entry.name ?? path.basename(entry.directory),
            value: entry.directory,
            description: entry.directory,
            footer: state,
            category:
              projectDirectoryKey(entry.directory) === projectDirectoryKey(navigation.directory())
                ? "当前工作区"
                : "工作区",
          }
        }),
    ]
  })

  return (
    <DialogSelect
      title={navigation.switching() ? "正在切换工作区…" : props.codeOnly ? "Code · 选择开发工作区" : "切换工作区"}
      placeholder="搜索名称或路径"
      emptyContent={personal.loading ? "正在读取工作区…" : personal.error || undefined}
      options={options()}
      current={navigation.directory()}
      skipFilter
      onFilter={setQuery}
      onSelect={(entry) => {
        if (!entry.value) {
          dialog.replace(() => (
            <DialogProjectAdd codeOnly={props.codeOnly} personalDirectories={personal.directories} />
          ))
          return
        }
        // 261114 Red 选当前工作区不再走 switchTo——那会重跑插件清理和 setCurrent，
        // 把整个 ProjectScreen 推倒重建。同目录时短路在一切清理之前：
        // 有等待确认的会话只做会话导航（已在该会话上则不动），否则只关弹窗。
        if (projectDirectoryKey(entry.value) === projectDirectoryKey(navigation.directory())) {
          if (props.codeOnly) {
            route.navigate({ type: "home" })
            dialog.clear()
            return
          }
          const target = navigation.waitingSession(entry.value)
          const alreadyThere = route.data.type === "session" && route.data.sessionID === target
          if (target && !alreadyThere) route.navigate({ type: "session", sessionID: target })
          dialog.clear()
          return
        }
        void navigation
          .switchTo(
            entry.value,
            props.codeOnly ? undefined : navigation.waitingSession(entry.value),
            props.codeOnly ? "code" : undefined,
          )
          .catch((error) =>
            toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) }),
          )
      }}
      actions={[
        {
          command: "project.delete",
          title: "delete",
          // 261110 Red 与会话列表同款两段式确认：第一次标记，第二次才真的移除。
          onTrigger: async (entry) => {
            if (!entry.value) return
            if (projectDirectoryKey(entry.value) === projectDirectoryKey(navigation.directory())) {
              toast.show({ variant: "warning", message: "当前工作区不能删除，先切到别的工作区" })
              return
            }
            if (toDelete() !== entry.value) {
              setToDelete(entry.value)
              toast.show({ variant: "warning", message: "再按一次删除该工作区记录（不会删除目录和会话）" })
              return
            }
            setToDelete(undefined)
            try {
              await navigation.forget(entry.value)
              toast.show({ variant: "info", message: "已从工作区列表移除" })
            } catch (error) {
              toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
            }
          },
        },
      ]}
    />
  )
}

function DialogProjectAdd(props: { codeOnly?: boolean; personalDirectories: string[] }) {
  const navigation = useProjectNavigation()!
  const { theme } = useTheme()
  const [error, setError] = createSignal("")
  return (
    <DialogPrompt
      title="添加工作区"
      placeholder="已有目录的完整路径"
      busy={navigation.switching()}
      busyText="正在准备目标工作区…"
      description={() => (
        <text fg={error() ? theme.error : theme.textMuted}>{error() || "只打开目录，不创建文件或 Git 仓库"}</text>
      )}
      onConfirm={(value) => {
        setError("")
        const directory = path.resolve(navigation.directory() ?? process.cwd(), value.trim().replace(/^"(.*)"$/, "$1"))
        if (props.codeOnly && props.personalDirectories.includes(projectDirectoryKey(directory))) {
          setError("这是伙伴的个人工作区，请用 /chat 打开。Code 请选择开发工作区。")
          return
        }
        void navigation
          .switchTo(value, undefined, props.codeOnly ? "code" : undefined)
          .catch((error) => setError(error instanceof Error ? error.message : String(error)))
      }}
    />
  )
}
