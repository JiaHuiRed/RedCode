import type { JSX } from "solid-js"
import { createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getFilename } from "@redcode-ai/core/util/path"
import { Icon } from "@redcode-ai/ui/icon"
import { Select } from "@redcode-ai/ui/select"
import { WordmarkV2 } from "@redcode-ai/ui/v2/components/wordmark-v2.jsx"

const MAIN_WORKTREE = "main"

export function NewSessionDesignView(props: { worktree: string; children: JSX.Element }) {
  const globalSync = useServerSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()

  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const projects = createMemo(() => {
    const roots = globalSync.data.project.map((project) => project.worktree)
    if (roots.includes(projectRoot())) return roots
    return [projectRoot(), ...roots]
  })
  const branch = createMemo(() => sync.data.vcs?.branch ?? MAIN_WORKTREE)

  const openProject = (directory: string | undefined) => {
    if (!directory) return
    if (directory === projectRoot()) return
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}/session`)
  }

  // 260814 Red 毛玻璃 B 遗漏点：下面这层的实色底盖住了整窗壁纸，新建会话页黑成一块
  // （会话页 #session-root / #session-chat-panel 已于 260813 清底，独漏这个容器）。
  // 清底交给 index.css 的 [data-app-frost] [data-component="session-new-design"] 规则，
  // 无壁纸时这里的实色照常生效。
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class="w-full max-w-[720px]">
          <div class="text-center">
            <WordmarkV2 class="text-[72px] leading-none" />
          </div>
          <div class="mt-8">
            {props.children}
            <div class="mt-3 flex h-7 items-center gap-0 pl-2">
              <Select
                size="normal"
                variant="ghost"
                options={projects()}
                current={projectRoot()}
                label={getFilename}
                onSelect={openProject}
                class="max-w-[203px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
                valueClass="truncate text-[length:13px] font-[440] text-v2-text-text-faint"
              />
              <div class="relative">
                <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
                  <Icon name="branch" size="small" />
                </div>
                <Select
                  size="normal"
                  variant="ghost"
                  options={[branch()]}
                  current={branch()}
                  class="max-w-[240px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
                  valueClass="truncate pl-5 font-[440] text-v2-text-text-faint"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
