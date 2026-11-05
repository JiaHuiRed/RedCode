// 261106 Red List 虚拟分支的扁平化：分组结构（GroupHeader + items + 可选末尾 add 行）
//   摊平成单一渲染数组，供 virtua Virtualizer 逐条渲染与 index 映射（替代 DOM
//   querySelectorAll 定位）。纯数据、零 solid 依赖，方便单测。

/** 分组头条目。group 保留原分组引用，groupHeader 渲染 prop 直接可用。 */
export interface FlatListHeader<T> {
  type: "header"
  category: string
  group: { category: string; items: T[] }
}

/** 列表条目。index 是组内下标（onSelect 的第二个参数语义不变），groupSize 用于分隔线判断。 */
export interface FlatListItem<T> {
  type: "item"
  item: T
  key: string
  index: number
  groupSize: number
  lastGroup: boolean
}

/** 末尾 add 行，等价非虚拟路径的 renderAdd。 */
export interface FlatListAdd {
  type: "add"
}

export type FlatListEntry<T> = FlatListHeader<T> | FlatListItem<T> | FlatListAdd

export interface FlattenListGroupsOptions<T> {
  key: (item: T) => string
  /** 是否在扁平数组末尾追加 add 行（对应 List 的 add prop）。 */
  add?: boolean
}

export function flattenListGroups<T>(
  groups: readonly { category: string; items: readonly T[] }[],
  options: FlattenListGroupsOptions<T>,
): FlatListEntry<T>[] {
  const entries: FlatListEntry<T>[] = []
  const last = groups.length - 1
  for (const [groupIndex, group] of groups.entries()) {
    // 261106 Red 空组与嵌套 For 的行为一致：有 category 就渲染头，条目为空则只有头
    if (group.category) {
      entries.push({ type: "header", category: group.category, group: { category: group.category, items: [...group.items] } })
    }
    for (const [index, item] of group.items.entries()) {
      entries.push({
        type: "item",
        item,
        key: options.key(item),
        index,
        groupSize: group.items.length,
        lastGroup: groupIndex === last,
      })
    }
  }
  if (options.add) entries.push({ type: "add" })
  return entries
}

/** 虚拟分支的键盘导航映射：item key → 扁平数组 index（含 header 占位）。
 *  替代非虚拟路径的 findByKey 全列表 DOM 扫描；同 key 后者覆盖前者。 */
export function itemIndexByKey<T>(entries: readonly FlatListEntry<T>[]): Map<string, number> {
  const map = new Map<string, number>()
  entries.forEach((entry, index) => {
    if (entry.type === "item") map.set(entry.key, index)
  })
  return map
}
