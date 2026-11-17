import path from "path"
import type { InstanceContext } from "./instance-context"

export interface ProjectRootInput {
  readonly worktree: string
  readonly directory: string
}

// 260913 Red 非 Git 项目 ctx.worktree 是文件系统根（"/" 或 "D:\"），
// 不能直接用作项目根构造 .redcode/ 或指令路径——否则会落到盘符根。
// 此时退回 ctx.directory 作为项目根。
export function projectRoot(ctx: ProjectRootInput): string {
  return ctx.worktree && ctx.worktree !== path.parse(ctx.worktree).root ? ctx.worktree : ctx.directory
}
