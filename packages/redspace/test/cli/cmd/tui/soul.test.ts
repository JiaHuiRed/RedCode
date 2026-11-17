import { describe, expect, test } from "bun:test"
import { parseSoulChoice, resolveNewSessionSoul, unknownSoulMessage } from "../../../../src/cli/cmd/tui/soul"
import { soulOptions } from "../../../../src/cli/cmd/tui/component/dialog-soul"

describe("TUI Soul choices", () => {
  test("opens the picker without an id and parses explicit ids", () => {
    expect(parseSoulChoice("/soul")).toEqual({ id: "", selector: true })
    expect(parseSoulChoice("/soul chi")).toEqual({ id: "chi", selector: false })
  })

  test("does not turn unknown ids into a different Soul", () => {
    expect(unknownSoulMessage("missing", ["karina", "chi"])).toBe("Unknown Soul: missing. Available: karina, chi")
    expect(resolveNewSessionSoul("missing")).toBe("missing")
  })

  test("preserves the saved id while Registry loading is pending or failed", () => {
    expect(resolveNewSessionSoul("wonyoung")).toBe("wonyoung")
  })

  test("omits an unset preference so the server inherits its default", () => {
    expect(resolveNewSessionSoul(undefined)).toBeUndefined()
    expect(resolveNewSessionSoul("chi")).toBe("chi")
  })

  test("passes the client default explicitly when sharing a different-client server", () => {
    expect(resolveNewSessionSoul(undefined, "karina")).toBe("karina")
    expect(resolveNewSessionSoul("wonyoung", "karina")).toBe("wonyoung")
  })

  test("does not interpret unrelated slash commands as Soul changes", () => {
    expect(parseSoulChoice("/help")).toBeUndefined()
    expect(parseSoulChoice("/soul chi extra")).toEqual({ id: "chi extra", selector: false })
  })

  test("Soul selector displays descriptions and searches by Chinese text or ID", () => {
    const options = soulOptions([
      { id: "chi", name: "赤", displayName: "小赤", description: "擅长简洁分析" },
      { id: "legacy", name: "旧助手" },
    ])
    expect(options).toEqual([
      { value: "chi", title: "小赤", description: "擅长简洁分析" },
      { value: "legacy", title: "旧助手", description: "legacy" },
    ])
    expect(soulOptions([{ id: "chi", name: "赤", description: "擅长简洁分析" }], "简洁")).toHaveLength(1)
    expect(soulOptions([{ id: "chi", name: "赤", description: "擅长简洁分析" }], "chi")).toHaveLength(1)
    expect(soulOptions([{ id: "chi", name: "赤", description: "擅长简洁分析" }], "不存在")).toEqual([])
  })
})
