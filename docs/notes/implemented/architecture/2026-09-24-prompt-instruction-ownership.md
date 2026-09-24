# 提示词规则按 owner 收敛

状态:implemented

## 问题

提示词把通用工作法同时放在全局 AGENTS、项目 AGENTS、runtime WORK RULES 和 live soul，出现相互冲突或职责重复。`system.ts` 还规定称呼频率与 reasoning 用语，与 soul 的自然称呼风格冲突。两份 MEMORY 超出各自注入预算。

## 决策

- **owner 分层**：`default.md` 拥有常规执行与 routine assumptions；全局 `~/.redcode/AGENTS.md` 拥有跨项目硬边界和 Memory 资格规则，并明确何时打断默认路径（材料性歧义、缺失信息、不可逆操作才问）。纠正后落实并验证；调查范围按影响面，未知根因/跨模块/高风险问题才扩展，深诊断阶段由 diagnose skill 拥有。
- **项目 `AGENTS.md` 只保留 RedCode 仓库规则**：删掉“先读代码、失败后诊断、承认能力边界”通用 CORE，owner 分别是全局工作法、default prompt 和 diagnose skill。
- **runtime `prompt.ts` 删除两个 owner 明确的重复项**：移除 CORRECTIONS ARE ACTIONABLE（全局 AGENTS 已有明确 owner）和 AFTER ANALYSIS → EXECUTE YOURSELF（default prompt 的执行范围 + 全局提问边界已有 owner）；保留 #1/#2/#3。#1/#2 的权威 owner 仍是全局 AGENTS，保留 runtime 镜像不代表重复规则能增权——这仍是未验证假设。
- **称呼风格归 soul**：`system.ts` 不再要求正文或 reasoning 的称呼频率，只注入 `Preferred form of address: …`。`config.username` 不设长度上限，因此 `addressFrom()` 在 prompt 边界截为最多 128 个 Unicode code point（UTF-8 不超过 512 bytes；当前 context estimate 上界 64 tokens），配置原值不变。
- **live soul 保留人格，移除通用工程工作流**：Tsoul 的读文档/写经验清单改为个人求知习惯；Gsoul 的抓 bug、纠错后修复、实验步骤改写为性格反应；两边移除“工程规则由 Agent/Model Prompt 决定”的元说明。口吻、关系和情绪表达保留。
- **Memory 剪枝只压缩、不淘汰有效索引**：全局 MEMORY 保留全部索引号；将已提交的 capsule L1-L6 状态从项目 MEMORY 移入 `.redcode/MEMORY-archive.md`；#302 正文保留在数据库并规范标题编号，随后导出备份快照。

## 备选与否决理由

- **继续在各层重复规则并依赖模型自行裁决**：否决——三处全局内部矛盾已有实际 owner，重复只扩大解释空间。
- **一次删掉全部 runtime WORK RULES 或重写所有模型 prompt**：否决——#3 是明确的用户决策权护栏；#1/#2 保留，模型 delta 也不在本次范围内。
- **把 live soul 整体改成通用人格模板**：否决——会抹掉维护者明确偏好的角色声音；只移除真正越界的工程流程。
- **让任意长度 username 原样进入 system prompt**：否决——这是配置来源的模型可见输入，必须有硬上限；仅限制注入副本，不修改配置。

## 后果

- UTF-8 文件字节变化（旧值按编辑前实测/HEAD，非 tokenizer 的精确 token 数）：

  | 注入层 | 旧 → 新 | 变化 |
  |---|---:|---:|
  | 全局 AGENTS | 17,179 → 17,488 | +309 |
  | RedCode 项目 AGENTS | 14,737 → 14,174 | -563 |
  | 全局 MEMORY | 13,786 → 10,978 | -2,808 |
  | 项目 MEMORY | 9,040 → 5,631 | -3,409 |
  | Tsoul | 5,675 → 5,174 | -501 |
  | Gsoul | 5,246 → 4,764 | -482 |

- 全局 AGENTS 净增是有意的：用更短的明确判据替代相互冲突的口号，不把字节变少误当成唯一目标。Memory 与 soul 共减少 7,200 bytes；项目 AGENTS 减少 563 bytes。文件字节数不是模型 token 数；`ContextSnapshot` 的 token 估算为 `round(chars / 4)`。
- runtime WORK RULES 删除的 #4/#5 正文共 358 个字符，按 `Token.estimate` 约 90 tokens（完整 block 的 round 差异最多 1 token）；称呼指令则由两段带行为要求的文本改为一条偏好事实，具体节省随配置 username 长度变化。
- `default.md` 与各模型 Delta 未改。对当前有称呼配置的会话，首个变化位于模型 prompt 之后的 `<env>` 地址事实；从该字节起至请求尾部的前缀需要重建，前面的 default/model Delta 仍可复用。若地址为空或被识别为系统用户名/主机名，最早变化点是全局 AGENTS；每日日期仍留在原来的 prompt 尾部。
- “重复规则会增权”及模型人格变化仍属未验证假设；本 note 只记录静态 owner 变更，不将其写成实测结论。
- 回归命令 `bun test test/session/system.test.ts test/session/reasoning-language.test.ts test/session/system-prompt-routing.test.ts --timeout 30000`：40 pass；Prettier 检查 `src/session/{system,reasoning-language}.ts` 与 `test/session/system.test.ts` 通过。全局 MEMORY dual-write 检查通过。TUI 全包 typecheck 此前连续两次因 tsgo 崩溃后 TypeScript fallback OOM，未再次运行。
- 同任务试跑只得到 Luna 样本：两次读文件、一次实现编辑、`bun test test/filter.test.ts` 2/2，随后简短收尾；请求记录显示 context 约 35.5K tokens、缓存读 34.3K、cost=0。Sol 启动后未留下输出、会话或新日志，期间系统可用 commit 从 1.15 GB 降至 0.71 GB；没有证据确认退出根因，因此不重试，也不据单个 Luna 样本推断模型差异。
