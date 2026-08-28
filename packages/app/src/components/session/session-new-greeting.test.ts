import { describe, expect, test } from "bun:test"
import { pickGreetingKey } from "./session-new-greeting"
import { dict as zh } from "@/i18n/zh"

// 260828 cc 时段分档的闸门。边界（11 点算早上还是中午、23 点算晚上还是深夜）是这类
// 代码最容易在后续改动里被挪错的地方，而挪错了不会有任何东西报错 —— 只是某个时段的
// 问候语永远不出现。
describe("pickGreetingKey 时段分档", () => {
  const bucketOf = (hour: number) => pickGreetingKey(hour, 0).split(".")[3]

  test("五档各自的覆盖区间", () => {
    expect([5, 8, 10].map(bucketOf)).toEqual(["morning", "morning", "morning"])
    expect([11, 12].map(bucketOf)).toEqual(["noon", "noon"])
    expect([13, 15, 17].map(bucketOf)).toEqual(["afternoon", "afternoon", "afternoon"])
    expect([18, 21, 22].map(bucketOf)).toEqual(["evening", "evening", "evening"])
    expect([23, 0, 3, 4].map(bucketOf)).toEqual(["night", "night", "night", "night"])
  })

  test("边界逐个点名", () => {
    expect(bucketOf(4)).toBe("night")
    expect(bucketOf(5)).toBe("morning")
    expect(bucketOf(10)).toBe("morning")
    expect(bucketOf(11)).toBe("noon")
    expect(bucketOf(12)).toBe("noon")
    expect(bucketOf(13)).toBe("afternoon")
    expect(bucketOf(17)).toBe("afternoon")
    expect(bucketOf(18)).toBe("evening")
    expect(bucketOf(22)).toBe("evening")
    expect(bucketOf(23)).toBe("night")
  })

  test("每档两句都抽得到，且 roll=1 不越界", () => {
    for (const hour of [8, 12, 15, 20, 2]) {
      const first = pickGreetingKey(hour, 0)
      const second = pickGreetingKey(hour, 0.99)
      expect(first).not.toBe(second)
      // Math.floor(1 * 2) === 2 会越界，兜底必须把它拉回第一条
      expect(pickGreetingKey(hour, 1)).toBe(first)
    }
  })

  // 抽出来的 key 必须真的能翻出文案 —— 词典里少一条就是页面上一片空白。
  test("每个 key 在词典里都有对应文案", () => {
    const keys = new Set<string>()
    for (let hour = 0; hour < 24; hour++) {
      keys.add(pickGreetingKey(hour, 0))
      keys.add(pickGreetingKey(hour, 0.99))
    }
    expect(keys.size).toBe(10)
    for (const key of keys) {
      expect((zh as Record<string, string>)[key], key).toBeTruthy()
    }
  })
})
