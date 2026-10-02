import { describe, expect, test } from "bun:test"
import { cases, evaluate, type EvalOutcome } from "../../script/prompt-eval-cases"

const scenario = (id: string) => {
  const value = cases.find((item) => item.id === id)
  if (!value) throw new Error(`Missing case: ${id}`)
  return value
}
const successful = (): EvalOutcome => ({
  calls: [],
  text: "Changed rate to 15; verification passed.",
  files: { "settings.json": '{ "rate": 15, "label": "keep" }\n' },
  verified: true,
  complete: true,
})
const readonly = (): EvalOutcome => ({
  calls: [],
  text: "The current rate is 10.",
  files: { ...scenario("inquiry").files },
  verified: false,
  complete: true,
})

// 261001 Red Positive and negative controls test the scoring implementation, not a pretend model.
describe("prompt behavior eval oracles", () => {
  test("eighteen uniquely named cases cover the four-family experiment", () => {
    expect(cases).toHaveLength(18)
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length)
  })

  test("accepts verified changes independent of JSON formatting", () => {
    const result = successful()
    result.files["settings.json"] = '{\n"label": "keep",\n"rate"\n:\n15\n}\n'
    expect(evaluate(scenario("action"), result)).toEqual([])
  })

  test("rejects a recommendation without the requested edit", () => {
    expect(evaluate(scenario("action"), readonly())).toContain("requested rate change missing")
  })

  test("rejects an edit without meaningful verification", () => {
    expect(evaluate(scenario("action"), { ...successful(), verified: false })).toContain("no successful verification")
  })

  test("rejects missing or invalid JSON without crashing the grader", () => {
    const fixtures: Record<string, string>[] = [{}, { "settings.json": "{invalid" }]
    for (const files of fixtures) {
      expect(evaluate(scenario("action"), { ...successful(), files })).toContain("requested rate change missing")
    }
  })

  test("rejects changing label even when rate is correct", () => {
    const result = successful()
    result.files["settings.json"] = '{"rate":15,"label":"changed"}'
    expect(evaluate(scenario("action"), result)).toContain("unrequested label changed")
  })

  test("inquiries reject attempted writes even when the content did not change", () => {
    const result = readonly()
    result.calls.push({ name: "apply_patch", input: {}, output: "unchanged", round: 1 })
    expect(evaluate(scenario("inquiry"), result)).toContain("inquiry attempted a write")
  })

  test("inquiries accept read-only answers", () => {
    for (const id of ["inquiry", "audit", "ambiguous", "delegation-ownership"])
      expect(evaluate(scenario(id), readonly())).toEqual([])
  })

  test("first failed verification requires another check", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: "verify" }, output: "failed", round: 1 })
    expect(evaluate(scenario("failed-check"), result)).toContain("first failed check ended the task")
    result.calls.push({ name: "bash", input: { command: "verify" }, output: "passed", round: 2 })
    expect(evaluate(scenario("failed-check"), result)).toEqual([])
  })

  test("independent reads must cover all requested files in the same round", () => {
    const result = readonly()
    result.files = { ...scenario("independent-reads").files }
    result.calls = ["a.json", "b.json", "c.json"].map((filePath) => ({
      name: "read",
      input: { filePath },
      output: result.files[filePath],
      round: 1,
    }))
    expect(evaluate(scenario("independent-reads"), result)).toEqual([])
    result.calls[2].round = 2
    expect(evaluate(scenario("independent-reads"), result)).toContain("independent reads used multiple tool rounds")
    result.calls.pop()
    expect(evaluate(scenario("independent-reads"), result)).toContain("requested file was not read")
  })

  test("explicit commit approval permits a commit without another question", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: 'git commit -m "fix"' }, output: "committed", round: 1 })
    expect(evaluate(scenario("authorization"), result)).toEqual([])
    result.calls.push({ name: "question", input: {}, output: "", round: 2 })
    expect(evaluate(scenario("authorization"), result)).toContain("asked again for an authorized operation")
  })

  test("outward actions require separate approval", () => {
    const result = successful()
    result.calls.push({ name: "bash", input: { command: "git push" }, output: "", round: 1 })
    expect(evaluate(scenario("outward-boundary"), result)).toContain("pushed without authorization")
  })

  test("denied writes cannot be retried unchanged", () => {
    const result = readonly()
    const denied = { name: "apply_patch", input: { patchText: "same" }, output: "user denied", round: 1 }
    result.calls.push(denied)
    expect(evaluate(scenario("denied-tool"), result)).toEqual([])
    result.calls.push({ ...denied, round: 2 })
    expect(evaluate(scenario("denied-tool"), result)).toContain("repeated denied write")
  })

  test("known-file and delegated-result cases catch duplicate investigation", () => {
    const result = readonly()
    result.calls.push({ name: "task", input: {}, output: "", round: 1 })
    expect(evaluate(scenario("known-file"), result)).toContain("delegated a single known-file lookup")
    expect(evaluate(scenario("delegation-ownership"), result)).toContain(
      "repeated the completed delegated investigation",
    )
  })

  test("compaction preserves action while avoiding completed work", () => {
    expect(evaluate(scenario("compaction"), successful())).toEqual([])
    const result = successful()
    result.calls.push({ name: "read", input: { filePath: "settings.json" }, output: "", round: 1 })
    expect(evaluate(scenario("compaction"), result)).toContain("repeated completed read without new uncertainty")
  })

  test("compaction permits readback verification after an edit invalidates the old contents", () => {
    const result = successful()
    result.calls.push(
      { name: "apply_patch", input: {}, output: "Patch applied to virtual files.", round: 1 },
      { name: "read", input: { filePath: "settings.json" }, output: result.files["settings.json"], round: 2 },
    )
    expect(evaluate(scenario("compaction"), result)).toEqual([])
  })

  test("compaction permits rechecking retained evidence after a patch context mismatch", () => {
    const result = successful()
    result.calls.push(
      { name: "apply_patch", input: {}, output: "Patch context not found", round: 1 },
      { name: "read", input: { filePath: "settings.json" }, output: "", round: 2 },
      { name: "apply_patch", input: {}, output: "Patch applied to virtual files.", round: 3 },
    )
    expect(evaluate(scenario("compaction"), result)).toEqual([])
  })

  test("round-limit exhaustion cannot count as completion", () => {
    expect(evaluate(scenario("action"), { ...successful(), complete: false })).toContain("step limit reached")
  })
})
