import { describe, expect, test } from "bun:test"
import { NamedError } from "@redcode-ai/core/util/error"
import { errorChain, errorData, errorFormat, errorMessage } from "../../src/util/error"
import { MessageError } from "../../src/session/message-error"

describe("util.error", () => {
  test("formats native Error instances", () => {
    const err = new Error("boom")
    expect(errorMessage(err)).toBe("boom")
    expect(errorFormat(err)).toContain("boom")

    const data = errorData(err)
    expect(data.type).toBe("Error")
    expect(data.message).toBe("boom")
    expect(String(data.formatted)).toContain("boom")
  })

  test("extracts message from record-like values", () => {
    const err = { message: "bad input", code: "E_BAD" }
    expect(errorMessage(err)).toBe("bad input")

    const data = errorData(err)
    expect(data.message).toBe("bad input")
    expect(data.code).toBe("E_BAD")
  })

  test("never returns bare {} for opaque object errors", () => {
    // Plain empty object — what the SDK threw before we wrapped it.
    expect(errorFormat({})).not.toBe("{}")
    expect(errorFormat({})).toContain("no message")

    // Object with only non-enumerable own properties (JSON.stringify drops them).
    class OpaqueError {}
    const opaque = new OpaqueError()
    Object.defineProperty(opaque, "secret", { value: "hidden", enumerable: false })
    expect(errorFormat(opaque)).not.toBe("{}")
    expect(errorFormat(opaque)).toContain("OpaqueError")
  })

  test("handles opaque throwables with custom toString", () => {
    const err = {
      toString() {
        return "ResolveMessage: Cannot resolve module"
      },
    }

    expect(errorMessage(err)).toBe("ResolveMessage: Cannot resolve module")

    const data = errorData(err)
    expect(data.message).toBe("ResolveMessage: Cannot resolve module")
    expect(String(data.formatted)).toContain("ResolveMessage")
  })

  test("schema-backed named errors are real NamedError instances", () => {
    const error = new MessageError.AuthError({ providerID: "anthropic", message: "boom" })

    expect(error).toBeInstanceOf(NamedError)
    expect(error.toObject()).toEqual({ name: "ProviderAuthError", data: { providerID: "anthropic", message: "boom" } })
  })

  test("named errors without fields serialize data", () => {
    expect(new MessageError.OutputLengthError({}).toObject()).toEqual({ name: "MessageOutputLengthError", data: {} })
  })

  test("errorChain exposes cause codes hidden behind SDK error wrappers", () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    const terminated = new TypeError("terminated", { cause: socket })
    const wrapped = new Error("Failed to process successful response", { cause: terminated })

    expect(errorChain(wrapped)).toEqual([
      { type: "Error", message: "Failed to process successful response" },
      { type: "TypeError", message: "terminated" },
      { type: "Error", message: "other side closed", code: "UND_ERR_SOCKET" },
    ])
  })

  test("errorChain stops at the depth limit", () => {
    const root = new Error("root")
    let current = root
    for (let i = 0; i < 6; i++) current = new Error(`layer ${i}`, { cause: current })
    expect(errorChain(current)).toHaveLength(4)
  })
})
