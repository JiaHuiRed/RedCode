#!/usr/bin/env bun
// 260811 cc：typecheck 兜底包装。catalog 钉的 typescript 7.0.2（tsgo，Go 版）在本仓
// 会 OOM 崩溃——packages/opencode 上是稳定复现，可用内存 5.8GB 时照崩，且不带任何本地
// 改动的基线同样崩，与改了什么无关。崩溃表现是 Go runtime panic 而非类型错误，于是
// pre-push 的全仓 typecheck 门禁被它一格拖红，正常改动也推不上去。
//
// 策略：先跑 tsgo（快）；只有在**识别为崩溃**时才回退到 node_modules 里的 TypeScript 5.x
// 重跑一遍，并以后者的结论为准。真正的类型错误不触发回退，直接原样透出——回退只用来
// 兜"编译器自己挂了"，不用来掩盖代码问题。
import { spawnSync } from "child_process"
import { existsSync, readdirSync } from "fs"
import path from "path"

const CRASH = /panic\(|runtime\.goexit|MemoryExhaustion|out of memory|fatal error: /i

function repoRoot(start: string) {
  let dir = start
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", ".bun"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const root = repoRoot(process.cwd())
const exe = process.platform === "win32" ? ".exe" : ""
const args = ["--noEmit", "--pretty", "false", ...process.argv.slice(2)]

const primaryBin = root ? path.join(root, "node_modules", ".bin", `tsc${exe}`) : `tsc${exe}`
const primary = spawnSync(primaryBin, args, { encoding: "utf8", shell: false })
const primaryOut = `${primary.stdout ?? ""}${primary.stderr ?? ""}`

if (primary.status === 0) process.exit(0)

if (!CRASH.test(primaryOut) && primary.error === undefined) {
  // 真类型错误：原样输出，别回退
  process.stdout.write(primaryOut)
  process.exit(primary.status ?? 1)
}

// 崩溃了 —— 找一份 5.x 重跑
const fallback = (() => {
  if (!root) return undefined
  const dir = path.join(root, "node_modules", ".bun")
  const candidates = readdirSync(dir)
    .filter((name) => /^typescript@5\./.test(name))
    .sort()
    .reverse()
  for (const name of candidates) {
    const bin = path.join(dir, name, "node_modules", "typescript", "bin", "tsc")
    if (existsSync(bin)) return bin
  }
  return undefined
})()

if (!fallback) {
  process.stderr.write(`tsgo 崩溃且找不到可用的 TypeScript 5.x 兜底：\n${primaryOut}`)
  process.exit(primary.status ?? 2)
}

// 用 node 跑，不用 process.execPath —— 在 bun 下那是 bun.exe，跑 tsc 的 CLI 会异常退出
console.warn(`[typecheck] tsgo 崩溃，回退到 ${path.relative(root!, fallback)} 重跑`)
const second = spawnSync("node", [fallback, ...args], { encoding: "utf8", shell: false })
process.stdout.write(`${second.stdout ?? ""}`)
process.stderr.write(`${second.stderr ?? ""}`)
process.exit(second.status ?? 1)
