import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@redcode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { AppFileSystem } from "@redcode-ai/core/filesystem"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
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
