# 原生压缩的可见性过滤下推到分页层

- 日期：2026-10-17
- 状态：implemented
- 相关：`packages/opencode/src/session/message-v2.ts`、`native-context-runtime.ts`

## 背景

原生压缩（`compaction.native.enabled`）的历史读取在 `NativeRuntime.history()`：

```ts
for (const message of MessageV2.stream(sessionID)) {
  if (covered.has(message.info.id) && !anchors.has(message.info.id)) continue
  ...
}
```

`MessageV2.stream()` 每次翻页都会 `hydrate()` 整页消息的全部分片——把被压缩覆盖的旧工具输出、正文从库里读出来、JSON 反序列化，然后在循环里原地 `continue` 丢掉。会话越长，被覆盖的历史越多，每轮 prompt 构造都要重复付这份读取成本。模型看到的上下文缩短了，本地读取成本却没有。

## 决策

给 `MessageV2.page()` / `stream()` 增加可选的 `filter?: (info: Info) => boolean`，在 `hydrate()` **之前**按 `message.data`（不含 part）过滤；`NativeRuntime.history()` 把 `covered/anchors` 判定下推进去。

两个必须守住的细节：

1. **游标取原始 slice 的末行**。被过滤的行同样占翻页位置，若按过滤后的末行编码，下一页会跳过这些消息。
2. **整页被过滤时不能当成流结束**。`stream()` 原来 `items.length === 0` 即 break，现在先看 `more/cursor`，有更早的消息就继续翻页。

`maxMessages` 预算仍按可见消息计数（过滤后），语义不变。

## 备选

- **建独立表/索引记录覆盖关系**：当前覆盖集合来自 `ContextCompaction.list()`（块内 `sourceMessageIDs`），一次查询就能取全，不需要再建表；瓶颈在 part 正文的读取，不在集合查询。
- **在 SQL 里用 json_extract 过滤**：`covered` 是内存里的集合，逐行 SQL 判断反而更慢，且会把判定逻辑散到两处。

## 后果

- 被覆盖消息的 part 不再被读取和反序列化；可见消息的读取行为逐字节不变。
- 分页语义从"每页 limit 条消息"变成"每页最多扫描 limit 条消息、返回其中通过过滤的"；调用方只消费迭代结果，不受影响。
- 回归护栏：`messages-pagination.test.ts` 新增两条——整页被过滤仍继续翻页、过滤不改变游标推进。
- 未做真实长会话的耗时基准：本机没有开启 native compaction 的长会话样本。量化依据是代码路径（filter 在 hydrate 之前）与上界（旧路径读取全部 part、新路径只读可见 part）。
