// 261024 Red RC-A05 负测试：门禁必须校验 git index 里的内容，不是工作区。
// 场景：暂存了锚点失效的坏版本 → 工作区修好但忘了重新 add → 提交前门禁必须红。
// 若实现退回 readFileSync（工作区视角），该测试失败——假通过会放进坏提交。
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dir, "..")
const scriptPath = path.join(projectRoot, "script", "check-injection-registry.ts")
const scratchRoot = path.join(projectRoot, ".redcode", "temp")

const GOOD_REGISTRY = `{
  "items": [
    {
      "id": "test-anchor",
      "file": "src/prompt.ts",
      "match": "TOKEN_ANCHOR",
      "channel": "prefix",
      "cap": "bounded-by:test",
      "stability": "stable"
    }
  ]
}`
const BROKEN_REGISTRY = GOOD_REGISTRY.replace("TOKEN_ANCHOR", "GONE_ANCHOR")
const PROMPT = "export const x = 1 // TOKEN_ANCHOR\n"
// 脚本里 PROMPT_TS 写死为 packages/opencode/src/session/prompt.ts，fixture 必须镜像该布局
const SESSION_PROMPT_REL = path.join("packages", "opencode", "src", "session", "prompt.ts")

let fixtureRoot: string

function git(args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: fixtureRoot })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function runGate() {
  return Bun.spawnSync(["bun", "run", scriptPath], {
    cwd: fixtureRoot,
    env: { ...process.env, NODE_ENV: "test", RC_GATE_TEST_ROOT: fixtureRoot },
  })
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(scratchRoot, "injection-gate-test-"))
  await mkdir(path.join(fixtureRoot, "src"), { recursive: true })
  await mkdir(path.join(fixtureRoot, "docs"), { recursive: true })
  await mkdir(path.join(fixtureRoot, "packages", "opencode", "src", "session"), { recursive: true })
  await writeFile(path.join(fixtureRoot, "src", "prompt.ts"), PROMPT)
  await writeFile(path.join(fixtureRoot, SESSION_PROMPT_REL), "// no system.push in fixture\n")
  await writeFile(path.join(fixtureRoot, "docs", "injection-registry.jsonc"), GOOD_REGISTRY)
  git(["init", "-q"])
  git(["config", "user.email", "gate@test"])
  git(["config", "user.name", "gate-test"])
  git(["add", "-A"])
  git(["commit", "-q", "-m", "base"])
})

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

test("干净基线：staged=HEAD=工作区 一致时通过", () => {
  const r = runGate()
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toContain("1 个登记项")
})

test("RC-A05 部分暂存假通过：工作区修好但 index 是坏的，必须红", async () => {
  // ① 暂存坏版本（锚点失效）
  await writeFile(path.join(fixtureRoot, "docs", "injection-registry.jsonc"), BROKEN_REGISTRY)
  git(["add", "docs/injection-registry.jsonc"])
  // ② 工作区修回好版本——旧实现（readFileSync）在这里会假通过
  await writeFile(path.join(fixtureRoot, "docs", "injection-registry.jsonc"), GOOD_REGISTRY)

  const r = runGate()
  expect(r.exitCode).toBe(1)
  expect(r.stdout.toString()).toContain("锚点失效")

  // 复位：重新暂存好版本
  git(["add", "docs/injection-registry.jsonc"])
  expect(runGate().exitCode).toBe(0)
})

test("RC-A05 反向假通过：登记表暂存新锚点、源码只改工作区不暂存，必须红", async () => {
  // ① 暂存新登记表（锚点指向 NEW_ANCHOR）
  await writeFile(
    path.join(fixtureRoot, "docs", "injection-registry.jsonc"),
    GOOD_REGISTRY.replace("TOKEN_ANCHOR", "NEW_ANCHOR"),
  )
  git(["add", "docs/injection-registry.jsonc"])
  // ② 源码加了 NEW_ANCHOR 但**不暂存**——contentFor 若回退读工作区就会假通过，
  //    提交后锚点失效（index 登记表 × 工作区源码 的错配组合）
  await writeFile(path.join(fixtureRoot, "src", "prompt.ts"), PROMPT.replace("TOKEN_ANCHOR", "NEW_ANCHOR"))

  const r = runGate()
  expect(r.exitCode).toBe(1)
  expect(r.stdout.toString()).toContain("锚点失效")

  // 复位
  git(["checkout", "-q", "HEAD", "--", "docs/injection-registry.jsonc"])
  git(["checkout", "-q", "HEAD", "--", "src/prompt.ts"])
  expect(runGate().exitCode).toBe(0)
})

test("staged 删除登记面文件时红，不留静默缺口", async () => {
  git(["rm", "-q", "src/prompt.ts"])
  const r = runGate()
  expect(r.exitCode).toBe(1)
  expect(r.stdout.toString()).toContain("file 不存在")
  // 复位
  git(["checkout", "-q", "HEAD", "--", "src/prompt.ts"])
})