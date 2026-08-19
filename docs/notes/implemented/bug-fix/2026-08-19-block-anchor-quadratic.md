# BlockAnchorReplacer 二次方候选扫描：无界算法家族的第四例

状态:implemented

## 问题

2026-08-19 全仓审计发现：`tool/edit.ts` 的 8 个 replacer 里，`BlockAnchorReplacer` 是唯一没有任何行数上限的一个，且候选收集是嵌套双循环——外层遍历全部行找首锚点，内层从 `i + 2` 一路扫到文件末尾找尾锚点。

合成病理输入（首锚点行大量重复、尾锚点行永不以正确块长出现）实测：

| 行数 | 耗时 |
| --- | --- |
| 5,000 | 254 ms |
| 10,000 | 1,013 ms |
| 20,000 | 4,074 ms |
| 40,000 | 16,518 ms |

严格四倍/倍长，标准 O(n²)，且是同步 CPU——整个事件循环冻住，症状是 evloop drift 探针的「drift 警告＝同步 CPU 冻结」那一态。

这是「无界算法跑在任意文件内容上」这一支的**第四例**：`snapshot/diffFull` 的 Myers diff（260709，59 秒）→ `fuzzyFindBestMatch`（260722，6.5 分钟）→ `ContextAwareReplacer`（260724，18.7 分钟）→ 本例。260724 那次补齐了「剩余 5 个 replacer」的行数帽（`7819e68`），但 `BlockAnchorReplacer` 被漏掉了——「修一个、漏一个同形状的」在这个文件里已是第三次。

触发条件恰好是历史事故的同一个场景：**大文件 + 模型给的 oldString 不精确**。`LineTrimmedReplacer` 之类的前置 replacer 撞 3000 行帽直接 return，所以 3000 行以上的文件里，本函数是第一个真正开扫的。

另有一处放大：`dbdef8fc`（260812，防吞区间）把内层命中后的 `break` 改成「行数不符就 `continue` 接着找」。那个修复本身是对的，但它同时**扩大了走到最坏情况的输入集**——原来撞到第一个尾锚点就停，现在要一路找到块长匹配为止。

## 决策

**不加行数帽，改用 O(1) 定位。**

关键观察：`dbdef8fc` 的行数一致性校验让内层扫描变成了多余的。候选被接受当且仅当 `j - i + 1 === searchBlockSize`，即 `j` 只能取 `i + searchBlockSize - 1` 这**唯一一个值**；原循环找的「≥ i+2 且两个条件都满足的最小 j」就是它。直接算出来即可：

```ts
const j = i + searchBlockSize - 1
if (j < i + 2 || j >= originalLines.length) continue
if (originalLines[j].trim() !== lastLineSearch) continue
candidates.push({ startLine: i, endLine: j })
```

`j >= i + 2` 保持原内层循环的起点约束：`searchLines` 尾部空行被 `pop()` 后 `searchBlockSize` 可能降到 2，那时原循环够不到 `j = i + 1`，不产生候选。

等价性用 20 万例随机 fuzz 验证（行内容、首/尾锚点、块长均随机，含 0/1/2 等边界块长）：新旧候选数组逐例完全一致，0 例不符。

复杂度 O(n²) → O(n)。40,000 行 16,518 ms → 4 ms；200,000 行 21 ms。

## 备选与否决理由

- **照抄其余 7 个 replacer 加 3000 行帽**：否决——`ContextAwareReplacer` 等前置 replacer 都已有 3000 行帽，`BlockAnchorReplacer` 是 3000 行以上文件**唯一**还在跑的模糊回退。给它加帽等于宣布「大文件上模糊匹配一律失败」，行为改动远超修复范围，且与哥哥此前否决 fail-closed 改造时的理由（现有很多编辑正靠这条链成功）冲突。测试里专门留了一条「>3000 行仍能模糊匹配」把这个决定钉住，防止后人图省事换回加帽。
- **限制内层扫描窗口（如 ±500 行）**：否决——O(1) 定位既然是精确等价的，窗口是没必要的近似。
- **候选数上限**：已有（`BLOCK_ANCHOR_MAX_CANDIDATES = 50`，260722 加的），管的是候选收集**之后**的 Levenshtein 打分，与本次的收集阶段无关，两者不重叠。

## 顺带修的两处终止性

同次审计发现 `MultiOccurrenceReplacer` 与 `UnicodeNormalizedReplacer` 的 `while (true)` 在 `find === ""` 时原地打转：`indexOf("", i)` 恒返回 `i`，`startIndex += find.length` 加 0 不前进，实测 5 ms 内 yield 超 10 万次且永不终止。

两者当前都**够不到**：`edit.ts` 在工具入口把 `oldString === ""` 分流到了建档路径。`UnicodeNormalizedReplacer` 还有第二道——`normContent === content && normFind === find` 的 early return 会挡住纯 ASCII 正文，只有正文含「归一化后会变」的字符（智能引号、全角字符等）时才进得了循环。但 `replace()` 是 exported，护栏离循环一千行远，就地加 `if (find === "") return`。

对应的回归测试正文必须含全角引号——拿纯 ASCII 当输入，那条测试在修复前也是绿的，guard 不住任何东西。

## 后果

- 测试：`test/tool/edit.test.ts` 新增 `describe("replacer 复杂度与终止性回归")` 4 例。回滚 src 到修复前实测：3 例失败（病理大文件 16,660 ms 撞 2 秒阈值、两条空 find 各 yield 满 1000 上限），1 例通过（「>3000 行仍能模糊匹配」——它的职责是拦住「换成加帽」的错误修法，两侧都应绿）。修复后 `edit.test.ts` 58 例、`apply_patch.test.ts` 28 例全绿，`tsc --noEmit` 干净。
- 阈值 2 秒是修复后（4 ms）的 500 倍余量，只拦复杂度回归，不做性能基准，慢机器上不会 flake。
- 本次只修了收集阶段的复杂度，**未改变任何匹配结果**——`dbdef8fc` 的防吞区间行为、相似度阈值、候选上限全部原样保留，`BlockAnchorReplacer 区间吞并回归` 那条事故回归测试仍绿。
