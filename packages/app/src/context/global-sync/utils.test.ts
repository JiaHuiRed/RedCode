import { describe, expect, test } from "bun:test"
import type { Agent, Provider } from "@redcode-ai/sdk/v2/client"
import { directoryKey, mergeProviderMaps, normalizeAgentList } from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

const provider = (id: string, models: Record<string, object>) =>
  ({
    id,
    name: id,
    env: [],
    source: "custom",
    options: {},
    models,
  }) as Provider

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\RedCode"))).toBe("C:/Repos/sst/RedCode")
    expect(String(directoryKey("C:/Repos/sst/RedCode"))).toBe("C:/Repos/sst/RedCode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/RedCode/"))).toBe("C:/Repos/sst/RedCode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

describe("mergeProviderMaps", () => {
  test("keeps catalog models when connected data is older", () => {
    const result = mergeProviderMaps(
      new Map([["opencode-go", provider("opencode-go", { "omen-alpha": { name: "Omen Alpha" } })]]),
      new Map([["opencode-go", provider("opencode-go", { "deepseek-v4-flash": { name: "DeepSeek V4 Flash" } })]]),
    )

    expect(Object.keys(result.get("opencode-go")?.models ?? {})).toEqual(["omen-alpha", "deepseek-v4-flash"])
  })

  test("lets connected provider fields and models override catalog data", () => {
    const result = mergeProviderMaps(
      new Map([["provider", provider("provider", { model: { name: "catalog" } })]]),
      new Map([["provider", provider("provider", { model: { name: "connected" } })]]),
    )

    expect(result.get("provider")?.models.model?.name).toBe("connected")
  })
})
