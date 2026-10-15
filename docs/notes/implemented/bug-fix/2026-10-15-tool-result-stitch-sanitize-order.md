# 出站 tool-result 配对：缓存拼接撤销净化（审计 A01）

状态:implemented

## 问题

`prompt.ts` 每一步按「净化 → 拼接固定前缀缓存」组装出站数组。净化（`sanitizeToolResultPairing`，
261007 为解决 steer 场景重复 result 导致的 DeepSeek 400 而加）刻意放在拼接**之前**，那段注释也
写明「后续 slice 以净化后下标对齐」—— 但拼接实际做的是：

```ts
const prevLen = cachedModelMsgs.messages.length        // 缓存里**净化后**数组的长度
if (prevLen > 0 && prevLen < modelMsgs.length)         // 却拿它和**原始**数组比长度
  stabilizedMsgs = [...cachedModelMsgs.messages, ...modelMsgs.slice(prevLen)] // 后缀也取自原始数组
```

`prevLen` 是净化后的长度，后缀却取自未净化的原始数组：净化在尾部丢掉的 result 被原样追加回来，
出站数组重新违反配对协议。三种形态，修复前三条全红：

1. 重复 result 整条被丢 → 又被拼回（审计给的最小反例）；
2. 孤儿 result 整条被丢 → 又被拼回；
3. 单条 tool message 内混有合法与无效 result → 净化只滤掉无效那条，拼接把**未过滤的原始 message**
   整个带回来（审计只列了这个场景，这条推论是复核时新发现的）。

这道拼接此前内联在 2500 行的 `runLoopImpl` 里，除了跑整条会话没有驱动手段，所以 261007 只测了净化
函数本身，**净化与拼接的组合从未被测过**。

**没有生产复现**：未取得出站 wire 数组证据，反例由代码路径构造。261007 注释里那次真实 400
（`ses_ffe5eeab…`）与本 bug 同形，但不能反推它就是本反例触发。

## 决策

- **拼接抽成纯函数** `MessageV2.stitchModelMessages(cached, raw, sanitized)`，从主循环里拿出来，
  让组合可被直接驱动 —— 本次唯一的结构改动，不改控制流。
- **后缀取自净化后的数组**（`sanitized.messages.slice(...)`），不取 `raw.slice(...)`。
- **缓存前缀有效性条件**：`prevLen` 能当边界的前提是「净化输出与输入逐条对应」，只有**消息条数未变**
  时才成立（一条 message 内的 result 全无效时整条不进结果，位置就此移动）。条数变了直接退回本次
  规范化结果，宁可这一轮重建前缀 —— 正确性优先于缓存。
- 其余失效条件在结构上已各有归属：同一代内 `msgPin` 钉死旧消息 parts、净化是纯函数 → 输出稳定；
  换模型有 `modelKey` 分桶；compaction / native-compaction / prune-sufficient / evict 四处
  `settlePromptCaches` 置换分代；**revert 自愈** —— 撤销删消息（`MessageV2.Event.Removed`），
  下一轮数组变短 → 命中「缓存更长不拼接」→ 退回并在同一步把缓存重建成撤销后的数组。

## 备选与否决理由

- **只把 `modelMsgs.slice` 换成 `sanitized.messages.slice`**：审计明确点名不够 —— 净化会改变位置，
  历史内容也可能变而长度不变。补上条数条件，才把「下标对齐」从假定变成**检查过的**。
- **在最终出站数组再净化一遍作防线**：本次不做 —— 每步多一遍 O(消息数) 扫描，而上面的组合已保证
  后缀与前缀各自都是净化产物；防线买不到额外保证，只买到每步成本。若将来观察到「条数不变但位置移动」
  （如中段插入）再上内容指纹。
- **每条消息做内容指纹校验前缀**：否决 —— 要深比较或哈希整段历史、每步一次，把优化做成了开销。
- **cached 与 raw 逐元素引用比较**：否决 —— 转换每步都产生新对象，引用比较恒不成立，等于关掉缓存。

## 后果

- 正常路径（无丢弃、无过滤）输出与原实现**逐元素同一**：后缀对象相同、顺序相同 → 出站字节不变，
  **KV 前缀不受影响**。
- 仅异常路径（净化真的丢了东西）有差异：这一轮前缀重建一次，换来出站数组满足配对协议。
- 新增 7 条用例（修复前 3 条红）：`message-v2.test.ts` 70 pass、`prompt.test.ts` 84 pass / 13 skip、
  `prompt-caches.test.ts` 9 pass、opencode `typecheck` EXIT=0。
- 未覆盖：中段插入消息导致「条数不变而位置移动」。现无此路径的证据；若出现需内容指纹而非条数条件。
