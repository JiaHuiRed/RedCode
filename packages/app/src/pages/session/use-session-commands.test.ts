import { describe, expect, test } from "bun:test"
import { extractPromptFromParts } from "@/utils/prompt"
import { compareTime } from "@/utils/id"
import { findLast } from "@redcode-ai/core/util/array"
import { base64Encode } from "@redcode-ai/core/util/encode"

// 261003 Red undo 的「等待期快照保护」回归：直接抽取生产源码注入依赖运行，
// 避免复制实现漂移（与 .redcode/temp 的审计探针同一手法）。保护语义：
// 发起时记录目标会话草稿快照，await revert 返回后仅当快照与当前内容一致
// 才写入恢复文本——等待期用户又打了字时静默跳过，不覆盖新输入。
const transpiler = new Bun.Transpiler({ loader: "tsx" })
const extract = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  expect(source.indexOf(startMarker, start + 1)).toBe(-1)
  return transpiler.transformSync(source.slice(start, end))
}

const commandSource = await Bun.file(new URL("./use-session-commands.tsx", import.meta.url)).text()
const promptSource = await Bun.file(new URL("../../context/prompt.tsx", import.meta.url)).text()
const undoSource = extract(commandSource, "  const undo = async () => {", "\n  const redo = async () => {")
const pickSource = extract(promptSource, "    const pick = (scope?: Scope)", "\n    // ")
const utilSource = extract(promptSource, "function isSelectionEqual(", "\nfunction cloneSelection(").replace(
  "export function isPromptEqual",
  "function isPromptEqual",
)
const { isPromptEqual } = new Function(`${utilSource}; return { isPromptEqual }`)() as {
  isPromptEqual: (a: { type: string; content?: string }[], b: { type: string; content?: string }[]) => boolean
}

type PromptPart = { type: "text"; content: string; start: number; end: number }
type Scope = { dir: string; id?: string }

const runUndo = async (options: { returnToA: boolean }) => {
  const params = { id: "A" }
  const drafts = new Map([
    ["A", { value: "original A draft" }],
    ["B", { value: "" }],
  ])
  const toPrompt = (value: string): PromptPart[] => [{ type: "text", content: value, start: 0, end: value.length }]
  const entry = (id: string) => ({
    set: (parts: PromptPart[]) => {
      drafts.get(id)!.value = parts[0].content
    },
    current: () => toPrompt(drafts.get(id)!.value),
  })
  const pick = new Function("load", "session", `${pickSource}; return pick;`)(
    (_dir: string, id: string) => entry(id),
    () => entry(params.id),
  ) as (scope?: Scope) => ReturnType<typeof entry>
  const prompt = {
    set: (parts: PromptPart[], _cursor: number | undefined, scope?: Scope) => pick(scope).set(parts),
    current: (scope?: Scope) => pick(scope).current(),
  }

  let finish!: (value: unknown) => void
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const messages: Record<string, { id: string; role: string; time: { created: number } }[]> = {
    A: [{ id: "message-a", role: "user", time: { created: 1 } }],
    B: [{ id: "message-b", role: "user", time: { created: 2 } }],
  }
  const dependencies = {
    params,
    sync: {
      data: {
        session_working: () => false,
        part: { "message-a": [{ id: "part-a", type: "text", text: "restored old A message" }] },
      },
    },
    sdk: { directory: "C:/synthetic-only", client: { session: { revert: () => pending } } },
    info: () => ({}),
    userMessages: () => messages[params.id],
    findLast,
    compareTime,
    extractPromptFromParts,
    base64Encode,
    isPromptEqual,
    prompt,
    setActiveMessage: () => {},
  }
  const undo = new Function(...Object.keys(dependencies), `${undoSource}; return undo;`)(
    ...Object.values(dependencies),
  ) as () => Promise<void>

  const task = undo()
  params.id = "B"
  drafts.get("B")!.value = "new local B edit"
  if (options.returnToA) {
    params.id = "A"
    drafts.get("A")!.value = "newer local A edit"
  }
  finish({})
  await task
  return drafts
}

describe("undo 等待期快照保护", () => {
  test("等待期无新输入：恢复文本写回发起时的会话", async () => {
    const drafts = await runUndo({ returnToA: false })
    expect(drafts.get("A")!.value).toBe("restored old A message")
    expect(drafts.get("B")!.value).toBe("new local B edit")
  })

  test("等待期有新输入：跳过恢复，不覆盖", async () => {
    const drafts = await runUndo({ returnToA: true })
    expect(drafts.get("A")!.value).toBe("newer local A edit")
    expect(drafts.get("B")!.value).toBe("new local B edit")
  })
})
