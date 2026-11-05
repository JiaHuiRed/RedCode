#!/usr/bin/env bun
// 261106 Red timelineRows 合并层 benchmark。
//
// 量的是流式期每 16ms flush 一次的「最终合并」成本：messageRowMemos flatMap +
// reuseTimelineRows（全局 byKey Map + 逐行 equals）。260901 cc 在注释里留过基线
// （481 行 0.68ms / 1651 行 1.82ms / 3601 行 3.96ms），本脚本用同一把尺子复测——
// 换了模型换了机器，旧数字不一定还算数。
//
// 两个场景：
//   hit    —— 流式主导路径：活跃轮整轮结构相等重建（reuse 命中率 100%，纯开销）
//   insert —— 工具行插入：活跃轮多出一行（真实插行，reuse 必须换新数组）
//
// 运行：cd packages/app && bun --conditions=browser script/bench-timeline-merge.ts

import "../happydom.ts"
import { TimelineRow } from "../src/pages/session/message-timeline.data"
import type { PartGroup, PartRef } from "@redcode-ai/ui/message-part"

type Row = TimelineRow.TimelineRow

const WARMUPS = 3
const RUNS = 40
const PARTS_PER_TURN = 10 // 每轮 UserMessage + 10 个 AssistantPart ≈ 11 行
const SIZES = [481, 1651, 3601]

type Turns = Row[][]

function makeTurn(index: number, parts: number): Row[] {
  const id = `user-${index}`
  const rows: Row[] = [
    new TimelineRow.UserMessage({ userMessageID: id, anchor: false, previousUserMessage: index > 0 }),
  ]
  for (let k = 0; k < parts; k++) {
    const ref: PartRef = { messageID: `assistant-${index}`, partID: `${id}-${k}` }
    const group: PartGroup = { key: `${id}:${k}`, type: "part", ref }
    rows.push(new TimelineRow.AssistantPart({ userMessageID: id, group, previousAssistantPart: k > 0 }))
  }
  return rows
}

function buildTurns(targetRows: number): Turns {
  const turnCount = Math.max(1, Math.round(targetRows / (PARTS_PER_TURN + 1)))
  return Array.from({ length: turnCount }, (_, i) => makeTurn(i, PARTS_PER_TURN))
}

/** 流式命中帧：活跃轮整轮结构相等重建（新实例、同内容），其余轮引用不动。 */
function flushHit(turns: Turns): Turns {
  const next = turns.slice()
  next[next.length - 1] = makeTurn(next.length - 1, PARTS_PER_TURN)
  return next
}

/** 插行帧：活跃轮多出一行（工具行落地的真实形态）。 */
function flushInsert(turns: Turns): Turns {
  const next = turns.slice()
  const lastIndex = next.length - 1
  next[lastIndex] = makeTurn(lastIndex, PARTS_PER_TURN + 1)
  return next
}

/** 现行实现（改造前）：flatMap 全量数组 + 全局 byKey Map 复用。保留作对照基线。 */
function legacyMerge(turns: Turns, previous: Row[] | undefined): Row[] {
  const rows = turns.flat()
  if (rows.length === 0) return rows
  return TimelineRow.reuse(previous, [...rows, new TimelineRow.BottomSpacer()])
}

/** 261106 Red 新实现：按 turn 切片合并（message-timeline.tsx 现行路径）。 */
let lastTurns: Turns | undefined
function slicedMerge(turns: Turns, previous: Row[] | undefined): Row[] {
  const merged = TimelineRow.mergeTurnRows({ turns, lastTurns, previous })
  lastTurns = turns
  return merged
}

function measure(merge: (turns: Turns, previous: Row[] | undefined) => Row[], frames: () => Turns) {
  let previous: Row[] | undefined
  const samples: number[] = []
  for (let i = 0; i < WARMUPS; i++) previous = merge(frames(), previous)
  for (let i = 0; i < RUNS; i++) {
    const turns = frames()
    const started = performance.now()
    previous = merge(turns, previous)
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  return { median, mean, min: samples[0] }
}

let failing = false
for (const size of SIZES) {
  Bun.gc(true)
  const base = buildTurns(size)
  const actualRows = base.flat().length
  const scenarios = [
    ["hit", (): Turns => flushHit(base)],
    ["insert", (): Turns => flushInsert(base)],
  ] as const
  for (const [name, frames] of scenarios) {
    const legacy = measure(legacyMerge, frames)
    lastTurns = undefined
    const sliced = measure(slicedMerge, frames)
    // 预算门禁：切片实现至少 2× 或进入亚 0.1ms，防回归
    const speedup = legacy.median / sliced.median
    const ok = sliced.median < 0.1 || speedup >= 2
    if (!ok) failing = true
    const fmt = (value: number) => value.toFixed(3).padStart(8)
    console.log(
      `rows=${String(actualRows).padStart(4)} ${name.padEnd(6)} legacy ${fmt(legacy.median)}ms   `
        + `sliced ${fmt(sliced.median)}ms   ${speedup.toFixed(1)}x ${ok ? "OK" : "FAIL"}`,
    )
  }
}
if (failing) {
  console.error("BUDGET FAIL: sliced merge 未达标（<0.1ms 或 >=2x）")
  process.exit(1)
}
