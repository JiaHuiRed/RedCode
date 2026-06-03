import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import path from "path"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree OR worktree's parent.
 * Trusting the parent directory allows sibling projects (e.g. D:\AI\RedStudio)
 * to be accessed without permission prompts.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (AppFileSystem.contains(ctx.directory, filepath)) return true
  if (ctx.worktree === "/") return false
  if (AppFileSystem.contains(ctx.worktree, filepath)) return true
  // 260603 Red Trust sibling directories
  const parent = path.dirname(ctx.worktree)
  if (parent !== ctx.worktree && AppFileSystem.contains(parent, filepath)) return true
  return false
}
