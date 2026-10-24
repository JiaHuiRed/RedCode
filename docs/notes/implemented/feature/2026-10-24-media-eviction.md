# 历史图片驱逐：多模态会话的 read 账单削减

- 日期：2026-10-24
- 状态：已实施（`session/message-v2.ts`、`config/config.ts`、`session/prompt.ts`）
- 背景：本月会话 token 审计（`.redcode/temp/token-audit-oct.mjs` 可复跑）——近 30 天
  3.09B token 中 cache.read 占 96%，miss 仅 3-7%（前缀稳定性战线已守住），账单是
  「命中的重读」本身。大户会话（186.6M，GLM5.3→GPT-6.1-Sol→step-5 接力）历史里
  15 张用户截图 28MB + read 读图附件单条 3.5-4.3MB（工具输出共 130MB、占历史字节
  81%），对多模态模型每轮重放。

## 机制

`toUIMessages` 回放时，从尾部数保留最近 `keepRecentMedia`（默认 5）张图（image/*，
用户附件与工具附件合窗），更早的：

- 用户附件 → 占位符文本 `[Historical image removed: <文件名>]`（保留文件名供反查）
- 工具附件 → 丢弃附件，输出文本追加一行 `[historical image attachment removed]`——
  没有这行，模型看到「Image read successfully」却没有图，会重读同一张旧图，省下的
  token 反手烧回去

配置 `experimental.mediaEviction`：`enabled`（默认 true）、`keepRecent`（默认 5，
负数整体关闭）。历史原文不动库——只影响回放，换会话/换模型可复看。

## 结算时机（与 prune 的「记账不结算」同源取舍）

驱逐只结算于**冷缓存序列化点**：会话启动/续接、模型切换（modelKey 换桶）、压缩边界
（settlePromptCaches 重建）。轮中不重估、不主动打缓存：一张图重读走缓存价（≈1/10
输入价），为提前驱逐 bust 一次是全量 miss（≈250K 全价）——只对千轮级不压缩会话才
回本，不做。副作用：活会话里图片在窗口滑动时不驱逐，等最近的重建点生效；压缩节奏
（4-12 块/会话）就是驱逐节奏。

## 判据数字（审计复跑口径）

「合并 codex」类会话：图片字节占历史 81%+17%；驱逐窗口 5 张后，重建点起 read 的
理论削减 40-60%（保守区间，取决于截图任务的图片密度）。纯代码会话零影响（file 占
比 ~0）。

## 模型可见四问

1. **模型看到什么变了**：重建点起，窗口外的旧图消失、原位是一行占位符（含文件名）；
   窗口内（最近 5 张）与所有文本逐字节不变。关闭态（enabled:false / 负窗口）回放与
   改动前逐字节一致。
2. **token 影响**：固定前缀零增减；按图节约（一张 1.9MB 截图 ≈ 1-2K vision token/
   轮），窗口外部分每轮净省；占位符 ≤ 一行。
3. **KV cache 影响**：结算点（重建本就发生处）一次前缀重写；轮中零影响。部署后首个
   重建点起各会话各作废一次。
4. **注入上限**：窗口有硬顶（5 张图）；占位符文本有界（文件名长度有界）。

## 验证

- `test/session/message-v2.test.ts` 77/77（新增 4 条：用户附件占位、工具附件丢弃+
  说明行、关闭态逐字节不变、非图片不占窗）
- opencode typecheck 0 错；OpenAPI/SDK 已重生（760831 字符，drift 自检过）
- 真 GUI 会话的削减量待下个多模态任务实测（复跑 token-audit-oct.mjs 对照）

## 回链

- 代码：`message-v2.ts`（markEvictedMedia 与两条分支注释）、`prompt.ts`（mediaOptions）
- 登记：`docs/injection-registry.jsonc` 的 `media-eviction` 行
