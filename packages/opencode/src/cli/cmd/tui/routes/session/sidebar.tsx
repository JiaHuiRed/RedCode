import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@redcode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "@tui/ui/toast"
import { useRenderer } from "@opentui/solid"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const renderer = useRenderer()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={0}
        paddingBottom={0}
        paddingLeft={1}
        paddingRight={1}
        position={props.overlay ? "absolute" : "relative"}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle ?? theme.border}
        bottomTitle={` RedCode ${InstallationVersion} `}
        bottomTitleAlignment="center"
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  {/* 261106 Red UX-08：共享 URL 此前只是纯文本，点击复制沿用 TUI 剪贴板封装；
                      鼠标正在选择文本时不触发，保留终端原生复制行为。 */}
                  <text
                    fg={theme.textMuted}
                    onMouseUp={() => {
                      if (renderer.getSelection()?.getSelectedText()) return
                      const url = session()!.share?.url
                      if (!url) return
                      void Clipboard.copy(url)
                        .then(() => toast.show({ message: "链接已复制", variant: "success" }))
                        .catch((error) => toast.show({ message: `复制失败：${String(error)}`, variant: "error" }))
                    }}
                  >
                    {session()!.share!.url}
                  </text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        {/* 260615 Red sidebar_footer slot kept for plugin extensibility */}
        <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID} />
      </box>
    </Show>
  )
}
