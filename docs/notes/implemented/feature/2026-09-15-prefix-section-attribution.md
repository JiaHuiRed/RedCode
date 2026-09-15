# 前缀诊断只归因、不改写模型上下文

状态:implemented

## 问题

`PrefixShape` 原来只能报告 `system` 整体 hash 变了。两三千万 token 的长会话平时可稳定在 98% 以上命中；一旦掉下来，日志无法区分是 AGENTS/MEMORY、MCP 指南还是动态 system 尾段先断开，排查只能猜。

`docs/notes/rejected/feature/2026-08-17-instruction-change-notice.md` 已有反例：每轮重读指令并插入一次性变更通知，会让变化轮和恢复轮都与前缀不一致，实测两轮各写入约 25 万 token。诊断不能以改变模型可见内容为代价。

## 决策

`prefix-shape.ts` 以 `WeakMap<PrefixShape, string[]>` 保存最终 system 数组的进程内 sidecar。仅当既有整体 system hash 已经变化时，才比较上一轮和本轮的数组，记录第一个不同区块的位置以及安全标签。

标签只保留 `Instructions from: <path>`、环境、skills、日期、规则标题等定位信息；session marker 与 DCP 元数据使用固定泛称，绝不把指令正文或 canary 写进日志。`prompt.ts` 仅把这份归因附在既有 `prefix cache changed` warning。

## 备选与否决理由

- **会话中即时刷新指令/记忆**：否决——即便变更 notice 持久化，刷新 system 仍至少造成一次完整前缀重写；对稳定高命中长会话不划算。
- **每轮落盘或全量保存 system 原文**：否决——不必要地增加 I/O，并扩大指令、路径和 canary 的泄露面。

## 模型可见改动四问

1. **模型看到什么变了**：没有变化；传入 `handle.process` 的 system、messages、tools 均未修改。
2. **token 影响**：固定前缀增减 0 token。
3. **KV cache 影响**：完全不动；仅在既有 hash 已变化后做本地归因。
4. **注入项硬上限**：未新增任何模型可见注入项。

## 后果

诊断保留每个活跃 `sessionID|modelKey` 的上一份 system 数组引用，生命周期跟现有 prefix-shape evictor 一致；稳态只多一次 `WeakMap.set`。若日志出现 `systemDifference`，其位置就是 provider 前缀从该 section 起失效的最早证据。
