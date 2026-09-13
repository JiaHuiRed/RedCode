import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@redcode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { IsolationBoundaryRef } from "@/effect/instance-ref"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
  /** 260913 Red 写操作标记：隔离 run 中边界外目标直接拒绝，不接受 external_directory 授权突破隔离。 */
  write?: boolean
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  if (options?.bypass) return

  const ins = yield* InstanceState.context
  // 260810 cc: 先以 instance.directory 为基准 resolve 再 normalize —— 否则
  // "/users/foo" 这类有根无盘符路径会被 normalizePath 兜底的 pathResolve 按
  // process.cwd() 补盘符，仓库与目标不同盘（仓库 E:、temp C:）时补错盘，
  // containsPath 与授权 glob 都会落在错误的盘上。
  const resolved = AppFileSystem.resolveFrom(ins.directory, target)
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(resolved) : resolved
  if (containsPath(full, ins)) return

  // 260913 Red 隔离 run 的硬边界：写操作越界直接拒绝，不再走 external_directory 询问。
  // 事故：子代理拿到父工作区的绝对路径，写穿了被分配的 worktree、把改动提交进主仓库。
  // 读操作不拦（子代理仍可参考父工作区代码），保持原有询问语义。
  if (options?.write) {
    const boundary = yield* IsolationBoundaryRef
    if (boundary !== undefined) {
      return yield* Effect.die(
        new Error(
          `Blocked: this subagent runs in an isolated worktree (${boundary}); refusing to write outside it: ${full}`,
        ),
      )
    }
  }

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}
