---
name: simplify
description: Use when a diff, function, or file feels over-engineered — too many abstractions, layers, flags, defensive checks, or premature generality for what the task actually needs. Trims code back to the minimum that does the job, without changing behavior.
---

# Simplify

把代码改回"刚好够用"的样子。目标是减少复杂度，不是加功能、不是重构周边。

## 什么时候用

- 一个 diff/函数/文件读起来比它该有的复杂
- 出现了"为了以后"的抽象、配置项、helper，但当前只用一次
- 防御性代码在处理不可能发生的情况
- 三行相似代码被提前抽成了一个抽象

## 怎么做

1. **先读懂当前行为**。简化前要确信你知道这段代码实际在干什么、被谁调用。
2. **只删不必要的复杂度**，行为保持不变：
   - 一次性的 helper / 抽象 → 内联回去
   - 为假设的未来需求留的参数、flag、分支 → 删
   - 给内部代码（非系统边界）加的校验/兜底 → 删；只在用户输入、外部 API 边界留校验
   - 兼容性 shim、`// removed` 注释、改名的 `_unused` 变量 → 直接删干净
   - 重复三行 < 提前抽象——能展开成简单直白的代码就别留抽象
3. **不顺手做别的**：不重命名无关变量、不补无关注释/类型、不"顺便"优化别处。
4. **验证行为没变**：跑对应 package 的 typecheck/test（TUI → `cd packages/opencode && bun run typecheck`；GUI → `cd packages/desktop && bun run typecheck`），改接口要更新所有调用方。

## 边界

- 简化 = 减复杂度，不是减功能。删之前确认那段真的没用、真的不会发生。
- 拿不准某个分支是不是死代码 → 停下来问哥哥，别赌。
- 只动被指到的范围，不扩大战场。
