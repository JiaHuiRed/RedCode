import { describe, expect, test } from "bun:test"

import { FRAME_ROWS, listViewport } from "../../src/cli/project-selector"

/** 视口实际会渲染出的条目数——对应 render() 里的 filtered.slice(offset, offset + maxVisible)。 */
function shown(total: number, selected: number, height: number) {
  const v = listViewport({ total, selected, height })
  return Math.max(0, Math.min(total, v.scrollOffset + v.maxVisible) - v.scrollOffset)
}

describe("project selector viewport", () => {
  // 260825 cc 回归：50cf2430 把可见行数从 height-6 收紧到 height-9（为了让帧不
  // 溢出、点击映射 y-1 保持成立），但没留下限。终端 9 行时算出 maxVisible=0、
  // 8 行时算出 -1，两种情况 slice 都返回空数组——框架画得出来、一个工作区都不
  // 显示。选择器是入口闸，「新建路径」哨兵项也在同一个列表里、一起消失，用户
  // 无路可走；而且不崩不报错，看着就像"没有工作区"。
  test("再矮的终端也至少显示一项，绝不整列表消失", () => {
    for (let height = 1; height <= FRAME_ROWS + 2; height++) {
      expect(shown(5, 0, height)).toBeGreaterThan(0)
    }
  })

  test("有富余时按 height - FRAME_ROWS 给行，不多占", () => {
    expect(listViewport({ total: 100, selected: 0, height: 30 }).maxVisible).toBe(30 - FRAME_ROWS)
    expect(listViewport({ total: 100, selected: 0, height: 24 }).maxVisible).toBe(24 - FRAME_ROWS)
  })

  test("条目少于可用行时以条目数为准", () => {
    expect(listViewport({ total: 3, selected: 0, height: 40 }).maxVisible).toBe(3)
  })

  test("空列表不产生负数或越界偏移", () => {
    const v = listViewport({ total: 0, selected: 0, height: 24 })
    expect(v.maxVisible).toBe(0)
    expect(v.scrollOffset).toBe(0)
  })

  test("选中项始终落在视口内", () => {
    for (const height of [1, 8, 9, 10, 12, 24, 40]) {
      for (const selected of [0, 1, 7, 49, 99]) {
        const v = listViewport({ total: 100, selected, height })
        expect(v.scrollOffset).toBeGreaterThanOrEqual(0)
        expect(selected).toBeGreaterThanOrEqual(v.scrollOffset)
        expect(selected).toBeLessThan(v.scrollOffset + v.maxVisible)
      }
    }
  })

  test("滚动偏移不会把视口推出列表尾部", () => {
    for (const height of [10, 12, 24]) {
      const v = listViewport({ total: 20, selected: 19, height })
      expect(v.scrollOffset + v.maxVisible).toBeLessThanOrEqual(20)
    }
  })
})
