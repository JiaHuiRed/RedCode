import { describe, expect, test } from "bun:test"
import { heatLevel, MAX_MODEL_SERIES, stackByDay, topModels, type Usage } from "./home-usage.data"

const model = (id: string, output: number, extra: Partial<Usage["models"][number]> = {}) => ({
  providerID: "p",
  modelID: id,
  messages: 1,
  input: 10,
  output,
  cost: 1,
  ...extra,
})

describe("topModels —— 分类色不循环，所以必须折叠", () => {
  test("模型少于上限时不出现「其他」", () => {
    const out = topModels([model("a", 30), model("b", 20)])
    expect(out).toHaveLength(2)
    expect(out.some((s) => s.isOther)).toBe(false)
  })

  test("超过上限时多出来的全部并成一条「其他」", () => {
    const many = Array.from({ length: 9 }, (_, i) => model(`m${i}`, 100 - i * 10))
    const out = topModels(many)
    expect(out).toHaveLength(MAX_MODEL_SERIES + 1)
    const other = out.at(-1)!
    expect(other.isOther).toBe(true)
    // 尾部 4 个：output 50+40+30+20 = 140
    expect(other.output).toBe(140)
    expect(other.messages).toBe(4)
  })

  test("占比之和为 1，折叠不能把量丢掉", () => {
    const many = Array.from({ length: 9 }, (_, i) => model(`m${i}`, 100 - i * 10))
    const sum = topModels(many).reduce((a, s) => a + s.share, 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  test("按产出排序，不是按传入顺序", () => {
    const out = topModels([model("small", 1), model("big", 100)])
    expect(out[0]!.modelID).toBe("big")
  })
})

describe("heatLevel —— 0 与「用得少」必须区分", () => {
  const sorted = [1, 2, 3, 10, 100, 1000]
  test("0 返回 -1（走底色，不是最浅一档）", () => {
    expect(heatLevel(0, sorted, 5)).toBe(-1)
  })
  test("非零最小值落在第 0 档而不是 -1", () => {
    expect(heatLevel(1, sorted, 5)).toBe(0)
  })
  test("最大值落在最高档", () => {
    expect(heatLevel(1000, sorted, 5)).toBe(4)
  })
  test("空样本不炸", () => {
    expect(heatLevel(5, [], 5)).toBe(0)
  })
})

describe("stackByDay", () => {
  const usage = {
    daily: [
      { day: "2026-01-01", messages: 2, output: 30, cost: 0 },
      { day: "2026-01-02", messages: 1, output: 5, cost: 0 },
    ],
    dailyByModel: [
      { day: "2026-01-01", providerID: "p", modelID: "a", output: 20 },
      { day: "2026-01-01", providerID: "p", modelID: "z", output: 10 },
      { day: "2026-01-02", providerID: "p", modelID: "a", output: 5 },
    ],
    models: [model("a", 25), model("z", 10)],
  } as unknown as Usage

  test("不在 slices 里的模型并进「其他」，量不丢", () => {
    const slices = topModels(usage.models, 1)
    const days = stackByDay(usage, slices)
    expect(days).toHaveLength(2)
    expect(days[0]!.total).toBe(30)
    expect(days[0]!.segments.find((s) => s.key === "__other__")!.output).toBe(10)
  })

  test("**段的顺序在每一天都相同**——顺序一乱柱子之间就没法比了", () => {
    const slices = topModels(usage.models)
    const days = stackByDay(usage, slices)
    const keys = days.map((d) => d.segments.map((s) => s.key).join(","))
    expect(new Set(keys).size).toBe(1)
  })

  test("日期轴取自 daily，没有活动的模型日不会凭空造出一列", () => {
    const days = stackByDay(usage, topModels(usage.models))
    expect(days.map((d) => d.day)).toEqual(["2026-01-01", "2026-01-02"])
  })
})
