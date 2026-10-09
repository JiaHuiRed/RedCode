import { beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"
import { formatSdkSource, generateSdk } from "../../../sdk/js/script/codegen"
import { tmpdir } from "../fixture/fixture"

const specFile = fileURLToPath(new URL("../../../sdk/openapi.json", import.meta.url))
const generated = fileURLToPath(new URL("../../../sdk/js/src/v2/gen/", import.meta.url))

function differences(expected: ReadonlyMap<string, string>, actual: ReadonlyMap<string, string>) {
  return [...new Set([...expected.keys(), ...actual.keys()])].sort().flatMap((file) => {
    if (!expected.has(file)) return [`unexpected ${file}`]
    if (!actual.has(file)) return [`missing ${file}`]
    return expected.get(file) === actual.get(file) ? [] : [`changed ${file}`]
  })
}

async function sources(directory: string) {
  const result = new Map<string, string>()
  for await (const file of new Bun.Glob("**/*.ts").scan(directory)) {
    result.set(file.replaceAll("\\", "/"), await Bun.file(path.join(directory, file)).text())
  }
  return result
}

describe("API / OpenAPI / generated SDK contract", () => {
  let expected: Map<string, string>
  let actual: Map<string, string>

  beforeAll(async () => {
    await using tmp = await tmpdir({ bare: true })
    const output = path.join(tmp.path, "gen")
    await generateSdk(specFile, output)
    expected = await sources(output)
    actual = await sources(generated)
    for (const [file, source] of expected) {
      const filepath = path.join(generated, file)
      expected.set(file, await formatSdkSource(source, filepath))
    }
  })

  test("committed OpenAPI matches the actual CLI API entry including code samples", async () => {
    // 261009 Red Event schema registration depends on import order; compare the real CLI entry, not a partial graph.
    const proc = Bun.spawn(["bun", "run", "--conditions=browser", "./src/index.ts", "generate"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25_000,
    })
    const [fresh, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect({ code, error: code === 0 ? "" : error }).toEqual({ code: 0, error: "" })
    const committed: unknown = await Bun.file(specFile).json()
    expect(committed).toEqual(JSON.parse(fresh))
  })

  test("all generated SDK files match the committed spec, including field types and SSE patch", () => {
    expect(expected.size).toBeGreaterThan(10)
    expect(differences(expected, actual)).toEqual([])
  })

  test("the gate detects field-only drift even when endpoint and schema names are unchanged", () => {
    const changed = new Map(actual)
    const source = changed.get("types.gen.ts") ?? ""
    const drift = source.replace("max_events?: number", "max_events?: string")
    expect(drift).not.toBe(source)
    changed.set("types.gen.ts", drift)
    expect(differences(expected, changed)).toEqual(["changed types.gen.ts"])
  })

  test("the gate detects missing, unexpected and changed endpoint/transport files", () => {
    const changed = new Map(actual)
    changed.delete("client.gen.ts")
    changed.set("unexpected.gen.ts", "export type Unexpected = string\n")
    const source = changed.get("sdk.gen.ts") ?? ""
    const drift = source.replace('"/global/health"', '"/global/stale-health"')
    expect(drift).not.toBe(source)
    changed.set("sdk.gen.ts", drift)
    expect(differences(expected, changed)).toEqual([
      "missing client.gen.ts",
      "changed sdk.gen.ts",
      "unexpected unexpected.gen.ts",
    ])
  })

  test("the gate detects an incorrect SSE iterator return type", () => {
    const changed = new Map(actual)
    const source = changed.get("client/types.gen.ts") ?? ""
    const drift = source.replace("ServerSentEventsResult<TData>", "ServerSentEventsResult<TData, TError>")
    expect(drift).not.toBe(source)
    changed.set("client/types.gen.ts", drift)
    expect(differences(expected, changed)).toEqual(["changed client/types.gen.ts"])
  })
})
