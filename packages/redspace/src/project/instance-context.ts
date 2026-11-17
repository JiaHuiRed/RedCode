import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 *
 * 260728 Karina 此前这里还无条件信任 worktree 的父目录（"Trust sibling directories"，
 * 9dfcde5 / 260603）。那等于把整个父目录连同里面的一切都划进项目内 —— repo 在
 * C:\Users\you\project 就静默信任整个 C:\Users\you，.ssh / .aws / 浏览器数据全在里面，
 * 而且因为判定成"项目内"，external_directory 授权根本不会触发，用户看不到任何提示。
 *
 * 改成显式白名单。要让相邻项目免授权，在 redcode.jsonc 里写：
 *   "permission": { "external_directory": { "E:/AI/RedMon/**": "allow" } }
 * permission.external_directory 本来就是 pattern → action 的规则表（见
 * config/permission.ts 的 Rule，匹配走 Wildcard.match），机制是现成的，
 * 区别只是从"默认全信"变成"写了才信"。
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (AppFileSystem.contains(ctx.directory, filepath)) return true
  if (ctx.worktree === "/") return false
  return AppFileSystem.contains(ctx.worktree, filepath)
}
