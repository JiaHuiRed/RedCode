import type { PromptInfo } from "./history"
import type { ProjectDraft } from "@tui/context/project-navigation"

// 261110 Red 项目切换草稿的纯数据操作：归属判定、追加占位、追加文本。
// 组件里的响应式与渲染逻辑不进来，这样能直接跑单测
// （test/cli/cmd/tui/prompt-draft.test.ts），不用挂整棵 TUI。

export type DraftPart = PromptInfo["parts"][number]

export type DraftScope = { directory: string | undefined; sessionID: string | undefined }

// 261110 Red 只判「同一个传入值」；目录规范化由 navigation 的 projectDraftKey 负责，
// 两处各做一份会漂。
export function sameDraftScope(a: DraftScope, b: DraftScope) {
  return a.directory === b.directory && a.sessionID === b.sessionID
}

function emptyDraft(): ProjectDraft {
  return { prompt: { input: "", parts: [] }, cursor: 0, mode: "normal" }
}

// 261110 Red 附属部件（file / agent / text 占位）的虚拟文本区间搬到新位置。
// 三种部件的 source 形状不同：agent 在 source 顶层，file / text 在 source.text。
function relocate(part: DraftPart, start: number, end: number): DraftPart {
  if (part.type === "agent") {
    if (!part.source) return part
    return { ...part, source: { ...part.source, start, end } }
  }
  if (part.type === "file") {
    if (!part.source) return part
    return { ...part, source: { ...part.source, text: { ...part.source.text, start, end } } }
  }
  if (!part.source) return part
  return { ...part, source: { ...part.source, text: { ...part.source.text, start, end } } }
}

export function appendDraftText(draft: ProjectDraft | undefined, text: string): ProjectDraft {
  const base = draft ?? emptyDraft()
  const prompt: PromptInfo = structuredClone(base.prompt)
  const input = prompt.input + text
  return { prompt: { ...prompt, input }, cursor: input.length, mode: base.mode }
}

export function consumeSubmittedDraft(draft: ProjectDraft | undefined, submitted: ProjectDraft) {
  if (!draft || draft.mode !== submitted.mode || JSON.stringify(draft.prompt) !== JSON.stringify(submitted.prompt)) return draft
  return emptyDraft()
}

// 261110 Red 异步附件/粘贴在归属变了之后写回原格子：占位符追加到草稿末尾，
// 部件区间一起搬到末尾，恢复时 restoreExtmarksFromParts 能按原样重建。
export function appendDraftChunk(
  draft: ProjectDraft | undefined,
  chunk: { virtual: string; part: DraftPart },
): ProjectDraft {
  const base = draft ?? emptyDraft()
  const prompt: PromptInfo = structuredClone(base.prompt)
  const start = prompt.input.length
  const end = start + chunk.virtual.length
  const input = prompt.input + chunk.virtual + " "
  return {
    prompt: { input, parts: [...prompt.parts, relocate(chunk.part, start, end)] },
    cursor: input.length,
    mode: base.mode,
  }
}
