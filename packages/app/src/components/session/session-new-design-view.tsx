import type { JSX } from "solid-js"
import { createMemo, createSignal } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { pickGreetingKey } from "./session-new-greeting"
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
  const language = useLanguage()
  const [greetingKey] = createSignal(pickGreetingKey(new Date().getHours()))

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
      {/* 260828 cc 原来是 `absolute inset-x-0 top-[25.375%]` —— 一个精确到小数点后三位的
          百分比，像是照着某个特定窗口高度的设计稿量出来的。它把整块钉死在上四分之一：
          1100px 高的窗口里内容到 500px 就结束，下面 600px 全空，而且窗口越高空白越大。
          改成 flex 垂直居中、再用 pb 往上偏一点（输入框略高于正中读起来更稳），跟窗口
          高度走。 */}
      <div class="flex size-full flex-col items-center justify-center px-6 pb-[10vh]">
        <div class="w-full max-w-[720px]">
          {/* 260828 cc 容器宽度保持 720 —— 试过拓到 820 让模型芯片少截断一点，结果输入框
              有它自己的宽度约束、没跟着变宽，底下的项目/分支那行按外层宽度起头就顶到输入框
              左边去了（哥哥的原话是「冒出头了」）。要放宽得先改输入框自己的约束，不在这一层。 */}
          <div class="text-center">
            {/* 260828 cc 72 → 88px。字标是这一屏的视觉中心，之前偏小、又被钉在上方，
                两头不靠。逐字母升起与流光见 wordmark-v2.css。 */}
            <WordmarkV2 class="text-[88px] leading-none" />
          </div>
          {/* 260828 cc 问候语。字标是品牌、输入框是功能，中间这一句是唯一说人话的地方，
              所以放这儿。字号刻意压在 15px：它是陪衬，抢了输入框的注意力就本末倒置了。 */}
          <div class="mt-5 text-center text-[15px] font-[440] text-v2-text-text-muted">
            {language.t(greetingKey())}
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
              {/* 260828 cc 原来这里是个 <Select>，但 options 只有 `[branch()]` 一个元素、
                  也没有 onSelect —— 渲染出下拉箭头、看起来能点，点开只有它自己、选了没反应。
                  vcs 数据里根本没有分支列表（sync.data.vcs 只有当前 branch），所以它不可能
                  是"待接线"，就是个假控件。退成静态标签：图标 + 文字，不再摆出可交互的样子。
                  副作用是好的 —— 上面那个 worktree 芯片仍有箭头，两者一眼就分得开了。 */}
              <div class="flex h-7 max-w-[240px] items-center gap-1.5 px-2 text-v2-text-text-faint">
                <Icon name="branch" size="small" />
                <span class="truncate text-[13px] font-[440]">{branch()}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
