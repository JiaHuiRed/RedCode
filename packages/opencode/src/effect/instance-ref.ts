import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceID } from "@/control-plane/schema"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~opencode/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceID | undefined>("~opencode/WorkspaceRef", {
  defaultValue: () => undefined,
})

// 260913 Red 隔离 worktree 的写入边界（绝对路径）。普通会话为 undefined；task 的
// isolation:"worktree" 分支在子代理运行期间把它设成 worktree 根。写文件工具据此拒绝越界写入，
// shell 据此把 git 命令钉在 worktree 上——否则模型只要拿到父工作区的绝对路径就能绕开隔离
// （事故：并行子代理写穿 worktree、直接在主仓库提交，产出互相污染的 commit）。
export const IsolationBoundaryRef = Context.Reference<string | undefined>("~opencode/IsolationBoundary", {
  defaultValue: () => undefined,
})
