import { Effect, ScopedCache, Scope } from "effect"
import * as EffectLogger from "@redcode-ai/core/effect/logger"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { ProjectID } from "@/project/schema"
import type { Project } from "@/project/project"
import { Global } from "@redcode-ai/core/global"
import path from "node:path"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

const fallbackContext = (): InstanceContext => {
  const cwd = process.cwd()
  const now = Date.now()
  return {
    directory: cwd,
    worktree: cwd,
    project: {
      id: ProjectID.make(path.basename(cwd) || "fallback"),
      worktree: cwd,
      time: {
        created: now,
        updated: now,
        initialized: now,
      },
      sandboxes: [],
    } as Project.Info,
  }
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return fallbackContext()
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
  // 260916 Red 默认保持无限（既有行为不变）。**持有子进程树的服务必须显式传上限**：
  //   服务端实例只在客户端目录淘汰时才通过 /instance/dispose 回收（客户端上限 30 个、空闲 20 分钟），
  //   不设上限就等于「访问过的每个目录永久留一套 MCP/LSP/watcher」，实测 10 目录 × 6 MCP = 60 进程常驻。
  //   超出容量的按最久未用淘汰，淘汰会跑 finalizer（关子进程），下次 get 再重建。
  //   决策记录：docs/notes/implemented/bug-fix/2026-09-16-instance-cache-and-orphans.md
  capacity = Number.POSITIVE_INFINITY,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer((directory) =>
      Effect.runPromise(ScopedCache.invalidate(cache, directory).pipe(Effect.provide(EffectLogger.layer))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
