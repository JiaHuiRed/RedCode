export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@redcode-ai/core/flag/flag"
import { Global } from "@redcode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@redcode-ai/core/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  return unique([
    Global.Path.config,
    ...(!Flag.REDCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".redcode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".redcode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.REDCODE_CONFIG_DIR ? [Flag.REDCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
