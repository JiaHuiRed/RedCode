# 接续旧聊天，并让增长后的个人记忆仍可回读

状态：implemented

## 问题

首批 Companion 导入只接续个人 Markdown；原始 OpenClaw JSONL 留在迁移源。日记未记录的旧对话无法从 Chat 记忆工具找到。另一个确定的缺口是个人搜索达到 8 MiB 后停止，换关键词仍扫描同一批文件；长行之前的上下文还可能挤掉真正命中的文字。

本提交接续可识别的历史对话，不复制旧网关、渠道、定时任务或执行权限。秋秋仍是 Chat 的独立伙伴，Code 的既有 Souls、工程记忆与执行路径保持独立。

## 导入与归属

- 从同一身份的 `agents/<id>/sessions/` 读取普通 JSONL 与 reset 留存。排除其他 agent、trajectory、checkpoint、备份及 deleted 文件。
- 结合 sessions.json 和记录中的 sessionKey/runId，识别 cron、heartbeat、subagent、dreaming 运行。逐条识别 inter-session provenance、系统回执、心跳与 compaction flush 等伪装为 user role 的内部消息；其后助手回应不被当作真人交流，直到下一条可识别的人类消息。解析失败的行计数告知，未臆造补全。
- 只导出直接 user/assistant text，去除已知传输元数据，排除 reasoning、工具参数/结果、合成消息、摘要与静默回执。每段保留角色、时间和 JSONL 行号；文件头记录原路径与原字节 SHA-256。助手说过的话不自动提升为用户事实。
- 可读派生文件为 `history/openclaw-<source-path-hash>.md`，与原有个人文件一起进入私有档案及 `companion_memory` 的权限检查、搜索和分页读取。它们明确标注为派生视图；原 JSONL 继续留在原迁移源，不把包含大量工具载荷的原始日志复制进活动档案。
- 固定身份、MEMORY 与日记仍遵循各自生命周期。启动快照不自动塞入整份聊天历史；有需要时按来源召回。

参考 RedClaw `49ccafcabfce4252eec93f6c67b2950cab096ede` 的 `packages/memory-host-sdk/src/host/session-files.ts`、`extensions/memory-core/src/prompt-section.ts` 和 `src/agents/tools/sessions-history-tool.ts`。这里采用其角色、运行来源和按需回读的思路，沿用 RedSpace 现有存储与权限，不引入旧运行时依赖。

## 已导入用户的升级

保留首批 personal-file digest 的算法。重新导入同一来源时，原 Soul 和后来写入的日记不覆盖；追加缺失的派生聊天，更新 manifest 的 historyDigest。已有相同文件逐字节摘要核对，不重复追加；已有同名文件不同则明确报冲突。进程间文件锁及原子 manifest 替换保护重复导入；中断留下的相同派生文件可在重试时复用。

GUI 仍使用原有导入入口。TUI 在更新构建后使用既有伙伴 ID：

```sh
redcode companion list
redcode companion import /absolute/path/to/.openclaw.zip --id <existing-id>
redcode --companion <existing-id>
```

这是导入而非两个运行时的双向同步；源档案的既有个人文件发生变化仍按原冲突规则处理。

## 搜索与回读

- 8 MiB 改为每页扫描预算，返回 `nextCursor`。游标绑定伙伴、关键词与本次已授权的来源列表；换身份、换查询或来源列表变化后必须重新开始，空页并不代表全部历史不存在。
- 输出依然最多 10 条、总计 8 KiB。长行片段围绕命中位置，提供 `byteOffset`，避免命中在长文本后方却只能反复读到开头；中文、emoji 和 CRLF 按实际 UTF-8 字节回读。
- 新 RedSpace 聊天继续由 Session 正典库保存，使用前一提交的同伴限定 `session_query`；旧档案经 `companion_memory` 查询，二者不重复建库。

## 验证

- 28 项定向测试通过：来源分类、文字/角色/时间保留、编码与路径约束、旧 manifest 补导入、日记不覆盖、重载召回、重复导入、跨身份与权限、空页继续、长中文/emoji/CRLF 定位等。
- 实际 SessionPrompt → provider fixture 另 1 项通过：新会话找回未写进日记的细节，工具调用间 system/工具表稳定，Code 不携带个人资料。
- core 包级 typecheck、OpenAPI 漂移检查（无生成物变化）、工具描述预算、diff 空白检查通过。
- 用户完整 ZIP 在隔离目录通过真实 CLI 导入，268 文件 / 28,281,449 字节，其中 16 份历史对话派生文件 / 102,785 字节 / 312 条可识别发言。252 份原资料副本逐字节、逐摘要核对源 ZIP。真实资料没有进入仓库或发送给模型。
- 独立新进程验证列表恢复、旧聊天搜索/回读、追加测试记忆、重复导入、新进程再次召回和新会话启动快照。测试写入仅发生在隔离副本。
- 3 篇旧日记编码不合法，原字节保留并明确报告，未猜测编码或制造替代内容。真实模型的长期口吻、Windows/Electron 实机体验不由合成 provider 或本次 Linux CLI 验证代证。

## 模型可见四问

1. **内容**：`companion_memory` 增加可选 `cursor` 参数；search 结果可含 `nextCursor`、长行命中的 `byteOffset`；描述说明历史聊天来源与续页/续读。召回内容带角色、时间、原路径、行号，system/Soul/启动装配顺序不变。
2. **token**：工具描述 2063 → 2292 字节（约 +57 token），实际序列化 schema 532 → 576 字节（约 +11），合计约 +68。历史文本不成为固定前缀，按需读取也不额外安排模型请求。
3. **KV cache**：发布后从工具声明变化处一次性重建，之后保持稳定；不随日记增长改写每轮前缀，工具回读进入正常结果历史。
4. **硬上限**：每个原会话源 8 MiB，最多 4096 个 / 64 MiB；派生可读文件 4 MiB，全部个人文件合计仍为 4096 个 / 64 MiB。游标 1 KiB；每页检索 8 MiB，结果 8 KiB，每个片段 1400 字节；read 16 KiB。搜索/读取结果可能超过 1K token，属于已有的按需工具结果预算，不是常驻注入；整份历史从不作为一次模型输入。
