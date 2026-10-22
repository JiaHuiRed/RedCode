import { describe, expect, spyOn, test } from "bun:test"
import { disposeInstance, registerDisposer } from "../../src/effect/instance-registry"

describe("instance registry", () => {
  test("clears the dispose timeout after registered disposers settle", async () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout")
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout")
    const off = registerDisposer(async () => {})

    try {
      await disposeInstance("/project")

      expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[0]?.value)
    } finally {
      off()
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })
})
