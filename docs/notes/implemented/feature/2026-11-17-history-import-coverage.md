# 历史导入覆盖率报告：把「跳过来源」变成可核对的清单

状态：implemented

## 问题

0.19.1 综合审计 F-05：历史导入只报告最终文件数（268 个文件 / 16 份对话派生），无法回答「有多少 trajectory、deleted、内部任务会话被跳过」「失败了多少条」「哪些来源没覆盖」。保守排除是对的，但导入是黑盒，无法验证真正有意义的经历有没有漏掉。

## 决策

- 新增 `Coverage` 结构化 schema，按审计 §6.3 的分类给出计数：普通 JSONL（scanned / extracted / internalExcluded / noUsableText / parseFailedRecords）、Trajectory（scanned / notImported / reason）、Deleted（found / excluded）、Other（deduplicated / conflicts）、Final（searchableFiles / humanTurns / uncoveredSources）。
- **只统计，不导入**：trajectory（运行时 trace、cron/heartbeat）和 deleted 会话只计数，继续留在来源目录，不进活动档案。`classifySource` 只按路径分类、不读文件内容。
- 计数挂在导入链路上：`directoryEntries` / ZIP 枚举统计来源分类，`transcript()` 返回真人段落细分（extracted / humanTurns / internal / invalid），`collect()` 聚合。只走已存在的解析逻辑，不新建索引、不重复读大文件。
- `Coverage` 进 `ImportResult`（公开 schema），CLI 默认打印人类可读清单，`--json` 输出结构化数据，`profile.json` 存一份供回溯。重导入（appendHistory）也带 coverage。
- `deduplicated / conflicts` 恒为 0：当前导入模型里重复的 personal path 直接报错而非静默去重，没有可计数的去重路径；留 0 是如实反映，不为填字段造语义。

## 取舍与边界

- 不把 trajectory 的文本导入模型上下文——审计明确「目标是可靠恢复有意义的经历，不是提高导入条目数」，且 trajectory 含大量工具载荷、cron 提示，不是真人交流。
- `role: user` 不等于真人发言：归属判断沿用 transcript.ts 的 provenance / synthetic / ignored / generated 规则，覆盖率只对已判定为真人交流的段落计 humanTurns。
- coverage 是纯计数，不含任何个人文本；测试断言私有内容不出现在序列化结果里。
- 不改身份绑定、冲突检测、文件原子落盘等既有路径。

## 模型可见四问

coverage 不进入模型上下文：它是 `companion import` 的 CLI / HTTP 返回值和档案清单，不是注入段、工具 description 或工具输出格式。固定前缀、token、KV cache 均不变。ImportResult 新增可选字段只影响 SDK 类型与 OpenAPI 文档，已同步生成。

## 验证

- 定向测试 26 项通过（companion / transcript / httpapi-companion）：来源分类计数、真人段落细分、内部会话排除标志、私有文本不进 coverage、profile.json 落盘。
- redspace 与 sdk 两包 typecheck 通过；`check:openapi-drift` 通过；两包 SDK 生成命令成功。
- 秋秋真实档案（`C:\Users\Administrator\.openclaw`，只读）验证：301 普通 JSONL / 730 trajectory / 16 deleted；导出 16 份可检索历史、312 段交流、116 个真人发言、1031 个未覆盖来源。
- 临时目录编译的 exe 跑真实 CLI 重导入，人类可读清单正确输出；因 digest 相同走 early return，未改动正式档案。

关联：[历史对话导入](../feature/2026-11-17-companion-transcript-import.md)、[审计报告](../../../reviews/0.19.1-comprehensive-audit.md)。
