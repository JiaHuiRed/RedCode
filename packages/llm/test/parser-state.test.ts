import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// A parser-state field that is seeded once by `Protocol.stream.initial` and
// then never written again can only ever be read as its seed value, which
// silently turns every branch behind it into dead code. `openai-responses`
// shipped exactly that: `store` was declared, seeded as `undefined`, read in
// two places, and assigned nowhere, so `state.store !== false` was a constant
// `true` and the `store: false` reasoning lifecycle never ran.
//
// The scanner below is deliberately small: it blanks comments and string or
// template contents, then matches brackets. That is enough for the one shape
// it has to understand — the object literal returned by `stream.initial` — and
// keeps the guard free of a compiler dependency, since the pinned typescript
// 7.x package ships no JavaScript compiler API. Regex literals are not
// tokenised; no protocol source contains one.

const PROTOCOLS_DIR = join(import.meta.dir, "../src/protocols")

// Protocols that own a streaming parser state. Listed rather than discovered
// so a scanner that silently stops matching fails this file instead of quietly
// guarding nothing.
const PROTOCOLS_WITH_PARSER_STATE = [
  "anthropic-messages.ts",
  "bedrock-converse.ts",
  "gemini.ts",
  "openai-chat.ts",
  "openai-responses.ts",
]

const QUOTES = new Set(['"', "'", "`"])

const blankLiterals = (source: string): string => {
  const out = source.split("")
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " "
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (QUOTES.has(ch)) {
      let k = i + 1
      while (k < source.length && source[k] !== ch) k += source[k] === "\\" ? 2 : 1
      blank(i + 1, k)
      i = k + 1
      continue
    }
    i += 1
  }
  return out.join("")
}

const CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" }

/** Index of the bracket closing the one at `open`, or -1 when unbalanced. */
const matchBracket = (source: string, open: number): number => {
  const stack: string[] = []
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{" || ch === "(" || ch === "[") stack.push(CLOSERS[ch])
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

interface Entry {
  /** Property name, or undefined for spreads, computed keys, and methods. */
  readonly name: string | undefined
  readonly value: string
  readonly spread: boolean
}

/** Top-level entries of the object literal spanning `open`..`close`. */
const entriesOf = (source: string, open: number, close: number): ReadonlyArray<Entry> => {
  const parts: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i += 1) {
    const ch = source[i]
    if (ch === "{" || ch === "(" || ch === "[") depth += 1
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i))
      start = i + 1
    }
  }
  parts.push(source.slice(start, close))
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part): Entry => {
      if (part.startsWith("...")) return { name: undefined, value: part, spread: true }
      const named = /^([A-Za-z_$][\w$]*)\s*:([\S\s]*)$/.exec(part)
      if (named) return { name: named[1], value: named[2], spread: false }
      const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(part)
      if (shorthand) return { name: shorthand[1], value: part, spread: false }
      return { name: undefined, value: part, spread: false }
    })
}

interface InitialState {
  readonly params: ReadonlyArray<string>
  readonly open: number
  readonly close: number
  readonly fields: ReadonlyArray<Entry>
}

const findInitialState = (blanked: string): InitialState | undefined => {
  const match = /\binitial:\s*\(([^)]*)\)\s*=>\s*\(\s*\{/.exec(blanked)
  if (!match) return undefined
  const open = match.index + match[0].length - 1
  const close = matchBracket(blanked, open)
  if (close === -1) return undefined
  const params = (match[1] ?? "")
    .split(",")
    .map((param) => param.split(":")[0].trim())
    .filter((param) => /^[A-Za-z_$][\w$]*$/.test(param))
  return { params, open, close, fields: entriesOf(blanked, open, close).filter((entry) => entry.name !== undefined) }
}

/**
 * Names written by the object literals that produce a next parser state: the
 * `{ ...state, field: next }` shape most step handlers use, plus the full
 * rebuild `openai-chat` writes, recognised by naming every seeded field.
 * Scoping to those two shapes is what keeps unrelated keys from passing a dead
 * field off as live — a request body schema also has a `store` field.
 */
const stateUpdateKeys = (blanked: string, initial: InitialState): ReadonlySet<string> => {
  const seeded = initial.fields.map((field) => field.name!)
  const keys = new Set<string>()
  for (let i = 0; i < blanked.length; i += 1) {
    if (blanked[i] !== "{") continue
    if (i >= initial.open && i <= initial.close) continue
    const close = matchBracket(blanked, i)
    if (close === -1) continue
    // `const { a, ...rest } = value` is a pattern, not an update.
    if (/^\s*=[^=>]/.test(blanked.slice(close + 1))) continue
    const entries = entriesOf(blanked, i, close)
    const names = new Set(entries.flatMap((entry) => (entry.name === undefined ? [] : [entry.name])))
    const rebuild = seeded.length > 1 && seeded.every((name) => names.has(name))
    if (!rebuild && !entries.some((entry) => entry.spread)) continue
    for (const name of names) keys.add(name)
  }
  return keys
}

/**
 * Fields of a `stream.initial` literal that are neither derived from the
 * request nor written by any state update — constants masquerading as state.
 */
const deadInitialStateFields = (source: string): ReadonlyArray<string> => {
  const blanked = blankLiterals(source)
  const initial = findInitialState(blanked)
  if (!initial) return []
  const written = stateUpdateKeys(blanked, initial)
  return initial.fields
    .filter((field) => !written.has(field.name!))
    .filter((field) => !initial.params.some((param) => new RegExp(`\\b${param}\\b`).test(field.value)))
    .map((field) => field.name!)
}

const readProtocol = (file: string) => readFileSync(join(PROTOCOLS_DIR, file), "utf8")

describe("protocol parser state", () => {
  test("covers every protocol that keeps parser state", () => {
    const found = readdirSync(PROTOCOLS_DIR)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => findInitialState(blankLiterals(readProtocol(file))) !== undefined)
    expect(found.sort()).toEqual([...PROTOCOLS_WITH_PARSER_STATE].sort())
  })

  for (const file of PROTOCOLS_WITH_PARSER_STATE) {
    test(`${file} seeds no field that nothing can change`, () => {
      // A field listed here is read as its seed forever: derive it from the
      // request inside `initial`, write it from a step handler, or delete it
      // along with the branches that read it.
      expect(deadInitialStateFields(readProtocol(file))).toEqual([])
    })
  }
})

// The scanner is load-bearing, so pin what it must and must not report. The
// `Body` schema and the destructuring in `step` are the two shapes that made
// naive "does the name appear anywhere else" checks miss the real bug.
const fixture = (initial: string, update: string) => `
const Body = Schema.Struct({ store: Schema.optional(Schema.Boolean) })
interface ParserState {
  readonly lifecycle: number
  readonly store: boolean | undefined
}
const step = (state: ParserState) => {
  const { lifecycle: _lifecycle, ...rest } = state
  return [{ ...rest, ${update} }, state.store !== false ? [] : ["closed"]]
}
export const protocol = {
  stream: {
    initial: ${initial},
    step,
  },
}
`

describe("dead parser state scan", () => {
  test("reports a field that is only ever seeded", () => {
    expect(deadInitialStateFields(fixture("() => ({ lifecycle: 0, store: undefined })", "lifecycle: 1"))).toEqual([
      "store",
    ])
  })

  test("accepts a field seeded from the request", () => {
    expect(
      deadInitialStateFields(fixture("(request) => ({ lifecycle: 0, store: storeOption(request) })", "lifecycle: 1")),
    ).toEqual([])
  })

  test("accepts a field a step handler writes", () => {
    expect(
      deadInitialStateFields(fixture("() => ({ lifecycle: 0, store: undefined })", "lifecycle: 1, store: true")),
    ).toEqual([])
  })

  test("accepts a field written by a full state rebuild", () => {
    const rebuild = `
interface ParserState {
  readonly lifecycle: number
  readonly store: boolean | undefined
}
const step = (state: ParserState) => [{ lifecycle: state.lifecycle + 1, store: true }, []]
export const protocol = { stream: { initial: () => ({ lifecycle: 0, store: undefined }), step } }
`
    expect(deadInitialStateFields(rebuild)).toEqual([])
  })

  test("ignores comments and string contents", () => {
    const source = fixture("() => ({ lifecycle: 0, store: undefined })", "lifecycle: 1")
    const decoys = `\n// { ...state, store: true }\nconst hint = "{ ...state, store: 1 }"\n`
    expect(deadInitialStateFields(source + decoys)).toEqual(["store"])
  })
})
