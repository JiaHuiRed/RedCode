import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"

// 260613 Red unified all XDG dirs into ~/.redcode
// 260811 cc audit Y8 根因：root/config/data/state 此前在模块加载时用 os.homedir()
// 硬算成常量，只有 home getter 认 REDCODE_TEST_HOME——test/preload.ts 明明第一步
// 就设了隔离变量，其余路径却全部落在真实 ~/.redcode 上（07-30、08-10 两次洗掉
// live 配置的根源）。改为访问时从 env-aware 的 home 派生：live 进程 env 恒定，
// 行为与常量等价；测试进程 preload 先设 env 再 import src，天然拿到隔离目录。
const home = () => process.env["REDCODE_TEST_HOME"] ?? os.homedir()
const root = () => path.join(home(), ".redcode")

type DerivedKey = "data" | "bin" | "log" | "repos" | "cache" | "config" | "state"

const derive: Record<DerivedKey, () => string> = {
  data: () => path.join(root(), "data"),
  bin: () => path.join(root(), "cache", "bin"),
  log: () => path.join(root(), "data", "log"),
  repos: () => path.join(root(), "data", "repos"),
  cache: () => path.join(root(), "cache"),
  config: () => root(),
  state: () => path.join(root(), "state"),
}

// 若干测试（config.test.ts / log.test.ts / sync.test.tsx / dialog-prompt.test.tsx）以直接
// 赋值做 per-test 目录切换，保留这条通路；未赋值时一律按 home 实时派生，所以隔离变量
// 一设就全线生效，不再有"只有 home 认变量、其余是常量"的分叉。
const overrides: Partial<Record<DerivedKey, string>> = {}

const paths = {
  get home() {
    return home()
  },
  tmp: path.join(os.tmpdir(), "redcode"),
} as { home: string; tmp: string } & Record<DerivedKey, string>

for (const key of Object.keys(derive) as DerivedKey[]) {
  Object.defineProperty(paths, key, {
    enumerable: true,
    get: () => overrides[key] ?? derive[key](),
    set: (dir: string) => {
      overrides[key] = dir
    },
  })
}

export const Path = paths

Flock.setGlobal({ state: paths.state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@RedCode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.REDCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
