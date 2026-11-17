import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../..")
const probe = path.join(root, "test/fixture/soul-restart.ts")
const persona = (version: string) =>
  [
    "---",
    "id: restart-persona",
    "name: Restart Persona",
    `display_name: Display ${version}`,
    `commit_prefix: Commit${version}`,
    "---",
    "",
    `# Original body ${version}`,
    "",
  ].join("\n")

test("Soul freezes at creation and survives a real process restart, file edits, removal and descendants", async () => {
  await using tmp = await tmpdir()
  for (const dir of ["home", "workspace", "souls"]) await fs.mkdir(path.join(tmp.path, dir))
  const source = path.join(tmp.path, "souls/persona.md")
  await fs.writeFile(source, persona("V1"))
  const env = {
    REDCODE_TEST_HOME: path.join(tmp.path, "home"),
    REDCODE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
    HOME: path.join(tmp.path, "home"),
    XDG_DATA_HOME: path.join(tmp.path, "data"),
    XDG_CONFIG_HOME: path.join(tmp.path, "config"),
    XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    XDG_STATE_HOME: path.join(tmp.path, "state"),
    REDCODE_DB: path.join(tmp.path, "sessions.db"),
    REDCODE_CONFIG_CONTENT: "{}",
    REDCODE_DISABLE_PROJECT_CONFIG: "1",
    REDCODE_DISABLE_MODELS_FETCH: "1",
    REDCODE_DISABLE_PLUGIN_DEP_INSTALL: "1",
    REDCODE_DISABLE_AUTOUPDATE: "1",
    REDCODE_AUTH_CONTENT: "{}",
    REDCODE_PURE: "1",
  }
  const run = async (mode: string, id?: string) => {
    const result = await Process.run([process.execPath, "run", probe, mode, tmp.path, ...(id ? [id] : [])], {
      cwd: root,
      env,
      timeout: 20_000,
      nothrow: true,
      maxOutputBytes: 20_000,
      maxErrorBytes: 20_000,
    })
    expect(result.code, result.stderr.toString()).toBe(0)
    return result.stdout.toString()
  }
  const created: { id: string; pid: number } = JSON.parse(await run("create"))
  await fs.writeFile(source, persona("V2"))
  const edited: { pid: number; prompt: string; forkPrompt: string; childPrompt: string; newPrompt?: string } = JSON.parse(
    await run("read", created.id),
  )
  expect(edited.pid).not.toBe(created.pid)
  for (const prompt of [edited.prompt, edited.forkPrompt, edited.childPrompt]) {
    expect(prompt).toContain("Original body V1")
    expect(prompt).toContain("Display V1")
    expect(prompt).toContain("[CommitV1]")
    expect(prompt).not.toContain("V2")
  }
  expect(edited.newPrompt).toContain("Original body V2")
  expect(edited.newPrompt).toContain("Display V2")
  expect(edited.newPrompt).toContain("[CommitV2]")
  await fs.unlink(source)
  const removed: typeof edited = JSON.parse(await run("read", created.id))
  expect(removed.pid).not.toBe(edited.pid)
  expect(removed.prompt).toBe(edited.prompt)
  expect(removed.forkPrompt).toBe(edited.prompt)
  expect(removed.childPrompt).toBe(edited.prompt)
}, 60_000)
