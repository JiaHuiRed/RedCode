import { describe, expect, test } from "bun:test"
import { TimelineRow } from "./message-timeline.data"
import type { PartGroup, PartRef } from "@redcode-ai/ui/message-part"

type Row = TimelineRow.TimelineRow

// 261106 Red mergeTurnRows 的差分测试：与旧路径（flatMap 全量数组 + 全局 reuse）在
// 随机流式序列上逐元素比对**引用**。行 key 内嵌 userMessageID、轮 id 全程恒定、
// 只变轮内行——这是真实会话的不变量，也是「全局 Map ≡ 逐轮 Map」成立的前提。
// spacer 用稳定单例同口径：新 BottomSpacer 与单例皆无字段、key 恒为 "bottom-spacer"，
// 两者行为不可区分。

const STABLE_SPACER = TimelineRow.bottomSpacer

function referenceMerge(turns: Row[][], previous: Row[] | undefined): Row[] {
  const rows = turns.flat()
  if (rows.length === 0) return rows
  return TimelineRow.reuse(previous, [...rows, STABLE_SPACER])
}

function makeTurnRows(id: string, parts: number): Row[] {
  const rows: Row[] = [
    new TimelineRow.UserMessage({ userMessageID: id, anchor: false, previousUserMessage: false }),
  ]
  for (let k = 0; k < parts; k++) {
    const ref: PartRef = { messageID: `assistant-${id}`, partID: `${id}-${k}` }
    const group: PartGroup = { key: `${id}:${k}`, type: "part", ref }
    rows.push(
      new TimelineRow.AssistantPart({
        userMessageID: id,
        group,
        previousAssistantPart: k > 0,
        repeatSignature: k > 0,
      }),
    )
  }
  return rows
}

type SimTurn = { id: string; rows: Row[] }

let seed = 0x2f6e2b1
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

describe("TimelineRow.mergeTurnRows", () => {
  test("全部轮引用未变时原样返回 previous（=== 短路）", () => {
    const turns = [makeTurnRows("u0", 3), makeTurnRows("u1", 2)]
    const first = TimelineRow.mergeTurnRows({ turns, lastTurns: undefined, previous: undefined })
    const again = TimelineRow.mergeTurnRows({ turns, lastTurns: turns, previous: first })
    expect(again).toBe(first)
  })

  test("空轮次返回空数组", () => {
    expect(TimelineRow.mergeTurnRows({ turns: [], lastTurns: undefined, previous: undefined })).toEqual([])
  })

  test("会话切换（无共享引用）产出全新且顺序正确的数组", () => {
    const stale: Row[] = [...makeTurnRows("old-0", 2), STABLE_SPACER]
    const turns = [makeTurnRows("new-0", 2), makeTurnRows("new-1", 3)]
    const merged = TimelineRow.mergeTurnRows({ turns, lastTurns: undefined, previous: stale })
    expect(merged.length).toBe(3 + 4 + 1) // makeTurnRows(id, parts) 产出 parts+1 行
    const first = merged[0]!
    expect(first._tag).toBe("UserMessage")
    if (first._tag === "UserMessage") expect(first.userMessageID).toBe("new-0")
    expect(merged.at(-1)).toBe(stale.at(-1)) // spacer 单例稳定
  })

  test("trim 帧按首个共享引用对齐，未变轮保住复用", () => {
    const t0 = makeTurnRows("u0", 2)
    const t1 = makeTurnRows("u1", 2)
    const t2 = makeTurnRows("u2", 2)
    const turnsA = [t0, t1, t2]
    const first = TimelineRow.mergeTurnRows({ turns: turnsA, lastTurns: undefined, previous: undefined })
    // HELD trim 掉 u0：u1 的行对象应原样保留（引用相等）
    const turnsB = [t1, t2]
    const second = TimelineRow.mergeTurnRows({ turns: turnsB, lastTurns: turnsA, previous: first })
    expect(second.length).toBe(6 + 1)
    expect(second[0]).toBe(first[3]) // t1 的 UserMessage 行沿用（t0 占 3 行）
    expect(second[1]).toBe(first[4])
  })

  test("随机差分 400 帧：与全局 reuse 参考实现逐元素引用等价", () => {
    // 忠实模拟生产结构：每轮 memo = createMemo(previous => reuse(previous, construct(...)))
    // —— mergeTurnRows 消费的 turns[i] 必须是各轮 memo 的返回值（与上一帧输出同源），
    // 而不是 construct 的原始产物。轮 id 全程恒定、只变轮内行数。
    type SimTurn = { id: string; fixture: Row[]; memoOutput: Row[] }
    let turns: SimTurn[] = Array.from({ length: 8 }, (_, i) => {
      const id = `u${i}`
      const fixture = makeTurnRows(id, 3 + (i % 4))
      return { id, fixture, memoOutput: fixture }
    })
    let nextId = turns.length
    let lastTurns: Row[][] | undefined
    let previousRef: Row[] | undefined
    let previousMine: Row[] | undefined

    for (let frame = 0; frame < 400; frame++) {
      const roll = random()
      if (roll < 0.1 && turns.length > 3) {
        turns = turns.slice(1) // HELD trim 最老轮
      } else if (roll < 0.18) {
        const id = `u${nextId}`
        turns = [...turns, { id, fixture: makeTurnRows(id, 2 + Math.floor(random() * 5)), memoOutput: [] as Row[] }]
        nextId++
      } else {
        const index = Math.floor(random() * turns.length)
        const turn = turns[index]!
        const variant = random()
        const parts =
          variant < 0.4
            ? Math.max(1, turn.fixture.length - 1 + Math.floor(random() * 3))
            : turn.fixture.length + (variant < 0.8 ? 1 : -1)
        turns = turns.map((item, i) =>
          i === index ? { ...item, fixture: makeTurnRows(item.id, Math.max(1, parts)) } : item,
        )
      }

      // 各轮 memo 步进：reuse 自己上一帧的返回值（260901 per-turn memo 的语义）
      for (const turn of turns) {
        turn.memoOutput = TimelineRow.reuse(turn.memoOutput, turn.fixture)
      }

      const currentTurns = turns.map((turn) => turn.memoOutput)
      previousRef = referenceMerge(currentTurns, previousRef)
      previousMine = TimelineRow.mergeTurnRows({ turns: currentTurns, lastTurns, previous: previousMine })
      lastTurns = currentTurns

      expect(previousMine.length).toBe(previousRef.length)
      for (let i = 0; i < previousRef.length; i++) {
        if (previousMine[i] !== previousRef[i]) {
          // bun test 无 expect.fail；直接抛出带帧号与索引的定位信息
          throw new Error(
            `frame ${frame} index ${i}: 元素引用分歧 ${JSON.stringify(previousMine[i])} vs ${JSON.stringify(previousRef[i])}`,
          )
        }
      }
    }
  })
})
