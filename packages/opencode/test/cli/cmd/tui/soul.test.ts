import { describe, expect, test } from "bun:test"
import { parseSoulChoice, resolveNewSessionSoul, unknownSoulMessage } from "../../../../src/cli/cmd/tui/soul"

describe("TUI Soul choices", () => {
  test("opens the picker without an id and parses explicit ids", () => {
    expect(parseSoulChoice("/soul")).toEqual({ id: "", deprecated: false, selector: true })
    expect(parseSoulChoice("/soul chi")).toEqual({ id: "chi", deprecated: false, selector: false })
  })

  test("deprecated persona aliases open the picker without inferring identity", () => {
    expect(parseSoulChoice("/tui-persona")).toEqual({ id: "", deprecated: true, selector: true })
    expect(parseSoulChoice("/gui-persona")).toEqual({ id: "", deprecated: true, selector: true })
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
    expect(parseSoulChoice("/soul chi extra")).toEqual({ id: "chi extra", deprecated: false, selector: false })
  })
})
