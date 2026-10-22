import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const projectRoot = path.resolve(import.meta.dir, "..")
const scratchRoot = path.join(projectRoot, ".redcode", "temp")
const fixtureRoot = await mkdtemp(path.join(scratchRoot, "install-test-"))
const binaryPath = path.join(fixtureRoot, "fixture-binary")
const bashEnvPath = path.join(fixtureRoot, "bash-env")
const installScript = path.join(projectRoot, "install")
const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe") : "bash"
const bashEnv = process.platform === "win32" ? `/${fixtureRoot[0]?.toLowerCase()}${fixtureRoot.slice(2).replaceAll("\\", "/")}/bash-env` : bashEnvPath

beforeAll(async () => {
  await writeFile(binaryPath, "offline binary fixture")
  await writeFile(
    bashEnvPath,
    `function uname() {
  if [[ "$1" == "-m" ]]; then echo x86_64; else echo "$MOCK_OS"; fi
}
function curl() {
  if [[ "$*" == *"%{http_code}"* ]]; then printf 200; return 0; fi
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-o" ]]; then shift; printf 'offline archive fixture' > "$1"; fi
    shift
  done
}
function unzip() {
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-d" ]]; then shift; cp "$MOCK_BINARY" "$1/redcode.exe"; fi
    shift
  done
}
function tar() {
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-C" ]]; then shift; cp "$MOCK_BINARY" "$1/redcode"; fi
    shift
  done
}
function powershell.exe() { echo True; }
`,
  )
})

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe("install binary filename", () => {
  test("loads local shell fixtures", () => {
    const result = Bun.spawnSync([bash, "-c", "type curl"], { env: { ...process.env, BASH_ENV: bashEnv } })
    expect(result.stdout.toString()).toContain("curl is a function")
  })

  test("uses redcode.exe for Windows local binaries", async () => {
    await expectInstalledName("MINGW64_NT", "--binary", "redcode.exe")
  })

  test("uses redcode.exe for Windows zip contents", async () => {
    await expectInstalledName("MINGW64_NT", "download", "redcode.exe")
  })

  test("keeps redcode for non-Windows local binaries", async () => {
    await expectInstalledName("Linux", "--binary", "redcode")
  })

  test("keeps redcode for non-Windows archive contents", async () => {
    await expectInstalledName("Linux", "download", "redcode")
  })
})

async function expectInstalledName(os: string, mode: "--binary" | "download", name: string) {
  const home = path.join(fixtureRoot, `${os}-${mode}`)
  const bin = path.join(home, ".redcode", "bin")
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/bash",
    BASH_ENV: bashEnv,
    MOCK_OS: os,
    MOCK_BINARY: binaryPath,
    VERSION: "0.0.0",
    GITHUB_ACTIONS: "false",
  }
  const args = mode === "--binary" ? [installScript, "--binary", binaryPath, "--no-modify-path"] : [installScript, "--no-modify-path"]
  const result = Bun.spawnSync([bash, ...args], { cwd: projectRoot, env })
  expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0)
  expect(await Bun.file(path.join(bin, name)).exists()).toBe(true)
  expect(await Bun.file(path.join(bin, name === "redcode" ? "redcode.exe" : "redcode")).exists()).toBe(false)
  const command = Bun.spawnSync([bash, "-c", "PATH=\"$HOME/.redcode/bin:$PATH\"; command -v redcode"], { cwd: projectRoot, env })
  expect(command.exitCode, command.stderr.toString()).toBe(0)
}
