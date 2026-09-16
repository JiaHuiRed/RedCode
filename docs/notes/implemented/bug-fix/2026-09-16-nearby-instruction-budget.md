# Nearby instructions obey the instruction budget

状态: implemented

## 问题

`Instruction.system()` 已经对固定前缀来源应用 `max_source_bytes`，但 `Instruction.resolve()` 会在 `read` 工具读取子目录文件时追加附近的 `AGENTS.md` / `CLAUDE.md`。该路径既不检查单来源大小，也不限制本次 read 的累计注入量，且追加发生在 read 的普通输出上限之后。

这使模型可见输入可绕过 `instruction_budget`。另一个语义偏差是字段名使用 bytes，原实现却以 JavaScript 字符数计量，CJK 内容会少算 UTF-8 字节。

## 决策

- `max_source_bytes` 统一按 UTF-8 字节计量，固定前缀和 nearby instructions 使用相同的单来源规则。
- 新增 `instruction_budget.max_resolved_bytes`，默认 32 KiB，限制单次 read 追加的所有 nearby instructions。
- 超限时整份跳过并记录 warning；不截断规则内容。
- 先遇到的最近目录指令优先保留，后续不再适配预算的祖先指令跳过。

## 备选与否决理由

- **在 read 工具末尾截断字符串**：否决——会把指令切成语义残片，也把预算规则分散到工具层。
- **只增加 read 输出总上限**：否决——工具正文与 nearby instruction 的责任不同，且不能阻止多份 nearby 文件累计膨胀。
- **继续只 warning**：否决——模型可见输入无硬上限违反仓库不变量。

## 后果

含附近指令的 read 可能少附带祖先目录规则；warning 会给出路径、实际字节和触发的配置阈值。配置的 `max_total_bytes` 仍保持既有的固定前缀观测阈值语义，不在这次修复中变为硬上限。
