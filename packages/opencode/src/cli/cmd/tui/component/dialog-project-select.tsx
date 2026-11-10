import path from "path"
import { createMemo, createSignal, onMount } from "solid-js"
import { useProjectNavigation, projectDirectoryKey } from "../context/project-navigation"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"

export function DialogProjectSelect() {
  const navigation = useProjectNavigation()!
  const dialog = useDialog()
  const toast = useToast()
  const [query, setQuery] = createSignal("")
  const [toDelete, setToDelete] = createSignal<string>()
  const [projects, setProjects] = createSignal<{ worktree: string; name: string }[]>([])
  onMount(() => setProjects(navigation.projects()))

  const options = createMemo(() => {
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
      title={navigation.switching() ? "正在切换工作区…" : "切换工作区"}
      placeholder="搜索名称或路径"
      options={options()}
      current={navigation.directory()}
      skipFilter
      onFilter={setQuery}
      onSelect={(entry) => {
        if (!entry.value) {
          dialog.replace(() => <DialogProjectAdd />)
          return
        }
        void navigation
          .switchTo(entry.value, navigation.waitingSession(entry.value))
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

function DialogProjectAdd() {
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
        void navigation
          .switchTo(value)
          .catch((error) => setError(error instanceof Error ? error.message : String(error)))
      }}
    />
  )
}
