import { expect, test } from "bun:test"
import { soulBudgetCheck, soulRegistryCheck, soulRenderCheck } from "@/cli/cmd/doctor"
import { MAX_SOUL_BYTES } from "@/soul/schema"

test("doctor warns about Soul registry issues", () => {
  expect(soulRegistryCheck(2, 1)).toEqual({
    name: "registry",
    status: "warn",
    detail: "2 valid Soul(s), 1 issue(s)",
  })
  expect(soulRegistryCheck(2, 0).status).toBe("ok")
})

test("doctor checks the independent Soul source budget", () => {
  expect(soulBudgetCheck("C:/souls/custom-id.md", MAX_SOUL_BYTES)).toMatchObject({
    name: "soul-source",
    status: "ok",
  })
  expect(soulBudgetCheck("C:/souls/custom-id.md", MAX_SOUL_BYTES + 1).status).toBe("warn")
  expect(soulRenderCheck(MAX_SOUL_BYTES + 1).status).toBe("ok")
  expect(soulRenderCheck(MAX_SOUL_BYTES + 1079).status).toBe("warn")
})
