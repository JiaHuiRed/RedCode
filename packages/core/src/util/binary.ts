export namespace Binary {
  export function search<T>(array: T[], id: string, compare: (item: T) => string): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const midId = compare(array[mid])

      if (midId === id) {
        return { found: true, index: mid }
      } else if (midId < id) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }

  // 260814 Red 自定义比较器二分：ID 48 位编码回绕后字典序不再单调（795 天周期），
  // 按 time.created 排序的数组必须用 comparator 定位。cmp(item, target) 返回
  // 负数 = item 在 target 前，0 = 相等，正数 = item 在 target 后。
  export function searchBy<T, K>(
    array: T[],
    target: K,
    cmp: (item: T, target: K) => number,
  ): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const c = cmp(array[mid], target)

      if (c === 0) {
        return { found: true, index: mid }
      } else if (c < 0) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }

  export function insert<T>(array: T[], item: T, compare: (item: T) => string): T[] {
    const id = compare(item)
    let left = 0
    let right = array.length

    while (left < right) {
      const mid = Math.floor((left + right) / 2)
      const midId = compare(array[mid])

      if (midId < id) {
        left = mid + 1
      } else {
        right = mid
      }
    }

    array.splice(left, 0, item)
    return array
  }
}
