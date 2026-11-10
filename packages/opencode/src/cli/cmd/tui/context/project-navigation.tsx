import path from "path"
import fs from "fs/promises"
import { createSignal, onCleanup, onMount, useContext } from "solid-js"
import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import { Filesystem } from "@/util/filesystem"
import { ProjectSelector } from "@/cli/project-selector"
import { TuiConfig } from "../config/tui"
import { TuiPluginRuntime } from "../plugin/runtime"
import {
  readProjectHistory,
  readIgnoredProjects,
  forgetProjectVisit,
  recordProjectVisit,
  type ProjectVisit,
} from "../project-history"
import type { PromptInfo } from "../component/prompt/history"
import type { Args } from "./args"
import type { Route } from "./route"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useToast } from "../ui/toast"
import { unwrap } from "solid-js/store"

export type ProjectDraft = { prompt: PromptInfo; cursor: number; mode: "normal" | "shell" }
type Reading = { messageID?: string; scrollTop?: number }
type View = { route: Route; workspace?: string }
export type ProjectScope = {
  directory?: string
  config: TuiConfig.Resolved
  args: Args
  view: View
}
type Activity = { busy: Set<string>; requests: Map<string, { sessionID: string; workspace?: string }> }

// 261110 Red 目录是导航身份，project ID / worktree ID 不能替代它（同仓可有多个目录）。
export function projectDirectoryKey(directory?: string) {
  if (!directory) return ""
  const resolved = path.resolve(directory).replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

const navigation = createSimpleContext({
  name: "ProjectNavigation",
  init: (props: { directory?: string; config: TuiConfig.Resolved; args: Args; local?: boolean }) => {
    const sdk = useSDK()
    const toast = useToast()
    const [current, setCurrent] = createSignal<ProjectScope>({
      directory: props.directory,
      config: props.config,
      args: props.args,
      view: {
        route:
          props.args.continue && (!props.local || props.directory)
            ? { type: "session", sessionID: "dummy" }
            : { type: "home" },
      },
    })
    const [switching, setSwitching] = createSignal(false)
    const [recent, setRecent] = createSignal<ProjectVisit[]>([])
    // 261110 Red 「已删除」的工作区只在导航里隐藏，目录和服务端会话都不动。
    const [ignored, setIgnored] = createSignal<string[]>([])
    const [revision, setRevision] = createSignal(0)
    const views = new Map<string, View>()
    const drafts = new Map<string, ProjectDraft>()
    const readings = new Map<string, Reading>()
    const activity = new Map<string, Activity>()
    const workspaceOwners = new Map<string, string>()
    let opener: (() => void) | undefined
    let capture: (() => View) | undefined
    let close: (() => void) | undefined
    let generation = 0
    let live = true
    let committing = Promise.resolve()
    const startup = { promptConsumed: false }
    const key = (directory: string | undefined, sessionID?: string) =>
      JSON.stringify([sdk.url, projectDirectoryKey(directory), sessionID ?? ""])

    async function refreshRecent() {
      const [records, hidden] = await Promise.all([readProjectHistory(), readIgnoredProjects()])
      if (!live) return
      setRecent(records)
      setIgnored(hidden)
    }

    function saveView(directory: string | undefined, view: View) {
      views.set(projectDirectoryKey(directory), structuredClone(unwrap(view)))
    }

    async function visit(directory: string, view: View) {
      await recordProjectVisit({
        directory,
        sessionID: view.route.type === "session" ? view.route.sessionID : undefined,
      })
      await refreshRecent()
    }

    onMount(() => {
      void refreshRecent().catch((error) => console.error("读取最近工作区失败", error))
      if (props.local && props.directory) {
        // 261110 Red 启动进入首页，最近会话只用于主动切换恢复。
        void recordProjectVisit({ directory: props.directory }).catch((error) => console.error("记录工作区失败", error))
      }
    })
    onCleanup(() => {
      live = false
      generation++
    })

    const off = sdk.event.on("event", (event) => {
      if (!props.local || event.directory === "global") return
      const owner = (event.workspace && workspaceOwners.get(event.workspace)) || projectDirectoryKey(event.directory)
      if (!views.has(owner) && owner !== projectDirectoryKey(current().directory)) return
      const state = activity.get(owner) ?? { busy: new Set<string>(), requests: new Map() }
      activity.set(owner, state)
      const payload = event.payload
      if (payload.type === "session.status") {
        if (payload.properties.status.type === "idle") state.busy.delete(payload.properties.sessionID)
        if (payload.properties.status.type !== "idle") state.busy.add(payload.properties.sessionID)
      }
      if (payload.type === "permission.asked" || payload.type === "question.asked") {
        state.requests.set(payload.properties.id, {
          sessionID: payload.properties.sessionID,
          workspace: event.workspace,
        })
        if (owner !== projectDirectoryKey(current().directory)) {
          toast.show({
            title: `${path.basename(event.directory)} 等待确认`,
            message: "通过工作区入口返回处理",
            variant: "warning",
          })
        }
      }
      if (
        payload.type === "permission.replied" ||
        payload.type === "question.replied" ||
        payload.type === "question.rejected"
      ) {
        state.requests.delete(payload.properties.requestID)
      }
      setRevision((x) => x + 1)
    })
    onCleanup(off)

    return {
      enabled: props.local === true,
      current,
      directory: () => current().directory,
      switching,
      recent,
      startup,
      canSend: () => !switching() && (!props.local || current().directory !== undefined),
      open() {
        if (props.local) opener?.()
      },
      bind(open: () => void, read: () => View, clear: () => void) {
        opener = open
        capture = read
        close = clear
        return () => {
          if (opener !== open) return
          opener = undefined
          capture = undefined
          close = undefined
        }
      },
      trackWorkspaces(directory: string | undefined, ids: string[]) {
        for (const id of ids) workspaceOwners.set(id, projectDirectoryKey(directory))
      },
      rememberView(directory: string | undefined, view: View) {
        saveView(directory, view)
        if (!props.local || !directory || (view.route.type === "session" && view.route.sessionID === "dummy")) return
        void visit(directory, view).catch((error) => console.error("保存工作区视图失败", error))
      },
      finishSubmission(directory: string | undefined, sessionID: string) {
        if (!directory || projectDirectoryKey(directory) === projectDirectoryKey(current().directory)) return
        if (views.get(projectDirectoryKey(directory))?.route.type !== "home") return
        const view: View = { route: { type: "session", sessionID } }
        saveView(directory, view)
        void visit(directory, view).catch((error) => console.error("保存工作区视图失败", error))
      },
      summary(directory: string) {
        revision()
        const state = activity.get(projectDirectoryKey(directory))
        return { busy: state?.busy.size ?? 0, waiting: state?.requests.size ?? 0 }
      },
      waitingSession(directory: string) {
        return activity.get(projectDirectoryKey(directory))?.requests.values().next().value?.sessionID
      },
      draft(directory: string | undefined, sessionID?: string) {
        return drafts.get(key(directory, sessionID))
      },
      saveDraft(directory: string | undefined, sessionID: string | undefined, draft: ProjectDraft) {
        drafts.set(key(directory, sessionID), structuredClone(unwrap(draft)))
      },
      reading(directory: string | undefined, sessionID: string) {
        return readings.get(key(directory, sessionID))
      },
      saveReading(directory: string | undefined, sessionID: string, value: Reading) {
        readings.set(key(directory, sessionID), value)
      },
      projects() {
        return ProjectSelector.loadProjects()
      },
      ignoredKeys() {
        return new Set(ignored().map((item) => projectDirectoryKey(item)))
      },
      async forget(directory: string) {
        if (projectDirectoryKey(directory) === projectDirectoryKey(current().directory)) {
          throw new Error("当前工作区不能删除，先切到别的工作区")
        }
        await forgetProjectVisit(directory)
        await refreshRecent()
      },
      async switchTo(input: string, sessionID?: string) {
        if (!props.local) throw new Error("远程连接暂不支持添加本地工作区")
        const attempt = ++generation
        setSwitching(true)
        try {
          const target = path.resolve(current().directory ?? process.cwd(), input.trim().replace(/^"(.*)"$/, "$1"))
          if (!input.trim()) throw new Error("请输入已有目录的路径")
          const stat = await fs.stat(target)
          if (!stat.isDirectory()) throw new Error(`不是目录：${target}`)
          await fs.access(target, fs.constants.R_OK)
          const directory = Filesystem.resolve(await fs.realpath(target))
          const client = createOpencodeClient({
            baseUrl: sdk.url,
            directory,
            fetch: sdk.fetch,
            signal: sdk.signal,
            headers: sdk.headers,
          })
          // 261110 Red 先准备必要配置，失败不卸载源视图；绝不 reload / shutdown Worker。
          const [config] = await Promise.all([
            TuiConfig.get(directory),
            client.path.get({}, { throwOnError: true }),
            client.config.get({}, { throwOnError: true }),
            client.config.providers({}, { throwOnError: true }),
            client.app.agents({}, { throwOnError: true }),
          ])
          if (attempt !== generation || !live) return false
          const source = current()
          const sourceView = capture?.() ?? source.view
          saveView(source.directory, sourceView)
          const saved = views.get(projectDirectoryKey(directory))
          const history = recent().find(
            (entry) => projectDirectoryKey(entry.directory) === projectDirectoryKey(directory),
          )
          const nextSession =
            sessionID ?? (saved?.route.type === "session" ? saved.route.sessionID : history?.sessionID)
          const view: View = saved
            ? structuredClone(saved)
            : {
                route: nextSession ? { type: "session", sessionID: nextSession } : { type: "home" },
              }
          const initialDraft = !source.directory ? drafts.get(key(undefined)) : undefined
          if (initialDraft && (initialDraft.prompt.input || initialDraft.prompt.parts.length)) {
            view.route = { type: "home" }
          }
          if (!source.directory && props.args.continue) view.route = { type: "session", sessionID: "dummy" }
          if (sessionID) view.route = { type: "session", sessionID }
          if (view.route.type === "session" && view.route.sessionID !== "dummy") {
            const session = await client.session.get({ sessionID: view.route.sessionID })
            if (!session.data) view.route = { type: "home" }
          }
          if (attempt !== generation || !live) return false
          // 261110 Red 准备可并发，插件清理与视图提交串行，旧清理不能擦掉新目标。
          const commit = committing.then(async () => {
            if (attempt !== generation || !live) return false
            close?.()
            await TuiPluginRuntime.dispose()
            if (attempt !== generation || !live) return false
            if (initialDraft) drafts.set(key(directory), initialDraft)
            setCurrent({ directory, config, args: source.directory ? {} : props.args, view })
            return true
          })
          committing = commit.then(
            () => undefined,
            () => undefined,
          )
          if (!(await commit)) return false
          void (async () => {
            if (source.directory) await visit(source.directory, sourceView)
            await visit(directory, view)
          })().catch((error) => console.error("记录工作区失败", error))
          return true
        } catch (error) {
          if (attempt !== generation || !live) return false
          throw error
        } finally {
          if (attempt === generation && live) setSwitching(false)
        }
      },
    }
  },
})

export const ProjectNavigationProvider = navigation.provider
export const useProjectNavigation = () => useContext(navigation.context)
