import type { Event, GlobalEvent } from "@redcode-ai/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"
import { projectDirectoryKey } from "./project-navigation"

type EventMetadata = {
  workspace: string | undefined
}

export function isProjectEvent(
  event: Pick<GlobalEvent, "directory" | "project" | "workspace">,
  scope: { directory?: string; project?: string; workspace?: string; workspaces: readonly string[] },
) {
  if (event.directory === "global") return true
  if (!scope.directory) return event.project === scope.project
  if (projectDirectoryKey(event.directory) === projectDirectoryKey(scope.directory)) return true
  return (
    !!event.workspace &&
    event.project === scope.project &&
    (event.workspace === scope.workspace || scope.workspaces.includes(event.workspace))
  )
}

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      // 261110 Red 独立目录不共享事件；显式 Workspace 仍保留原来的跨 worktree 确认归属。
      if (
        isProjectEvent(event, {
          directory: sdk.directory,
          project: project.project(),
          workspace: project.workspace.current(),
          workspaces: project.workspace.list().map((item) => item.id),
        })
      ) {
        handler(event.payload, { workspace: event.workspace })
      }
    })
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    on,
  }
}
