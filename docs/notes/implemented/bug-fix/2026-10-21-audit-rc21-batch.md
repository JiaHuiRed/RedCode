# 第三方审计 RC21-02/03/04/05 修复批次

状态:implemented

审计原文：`docs/2026-10-21-third-party-audit.md`（基准 `a191033a`）。本 note 只记这四项的取舍；
RC21-01（退役配置迁移）、RC21-06（sidecar 恢复所有权）、RC21-07（WSL 同步等待）未动。

## 问题

四处的共同点是**状态归属与预算落实在错误的层**：

1. **RC21-02**：`session-history-loader.loadThrough` 只走 `loadMore`（向旧）。400 条窗口两端都会裁边，
   往前翻过一段后点「较新的那一轮」永远够不到 —— 判据是 `historyMore()` 为假，但目标其实在新的一侧。
2. **RC21-03**：`fetchOlderMessages` 的 catch 无条件写 `stalled=true`，只比 sessionID 不认代次。
   旧会话的请求迟到失败会污染新会话；A→B→A 更拦不住（id 又对上了）。同一 catch 也没调 `onLoadError`。
   相邻的 `fetchNewerMessages` 早就检查了归属 —— 兄弟分支不对称。
3. **RC21-04**：`usage.ts` 的指纹只数行数与 `max(time_created)`。`projectors` 的
   `onConflictDoUpdate` 原地改 `data`（assistant 的 cost/tokens 累计），行长与创建时间都不变；
   `range="all"` 的 `currentStreak` 还依赖「今天」。结果是首页看板停在生成期间的中间值，直到下一条新消息。
4. **RC21-05**：`file/index.ts` 三条媒体分支先 `readFile` 全量读再比 20 MiB，限额压不住读取峰值；
   文本分支（`readFileString`）一个上限都没有；`context: Infinity` 的全量 diff 再叠一份正文。

## 决策

- **双向定位**：`loadThrough` 先按 `targetOrder`（整份轮次目录的 user 消息顺序）与窗口最旧一条的位置
  判方向，然后 `walk(direction)` 复用同一套「边界推进 + 无进展等一拍 + 页数上限」保护；判定方向走不通
  再试另一侧。顺序缺失（目录没加载过）时退回只向旧翻，与旧行为一致。
  目录顺序从 `queryClient` 读同一份 outline 缓存，不新增请求；键由 `sessionOutlineKey` 唯一定义
  （`server-sync` 的失效通道也改用它，消掉三处硬编码的 key 形状）。
- **归属 + 代次**：loader 内加 `generation`，每次切换会话递增；每个分页请求发起时捕获
  `(sessionID, generation)`，所有写状态（`stalled` / `newerStalled` / `shift` / 视口 / 错误提示）的出口
  统一走 `owned()`。向旧、向新共用这一条约束。
- **缓存失效**：`usage.invalidateSession(sessionID)` 由 `projectors` 在 assistant 消息 upsert 之后调用
  （`cache.size === 0` 直接返回，流式期间不额外查库）；`today` 进缓存键，跨天必失效。
- **读取预算**：`readBounded(full, limit)` 用 `appFs.stream(path, { bytesToRead: limit + 1 })` 一次有界读，
  读取那一刻的硬上限，不受 stat 之后文件增长影响；多读 1 字节区分「等于」与「超过」。
  文本超 2 MiB 时返回前缀并带 `truncated: true`，同时**跳过 diff**（前缀对全文的 patch 不成立）。

## 备选与否决理由

- **给 message 表加 `time_updated` 列让指纹自洽**：否决 —— 要动 schema 与迁移，代价远大于一个
  `Map.delete`；而且「谁该失效」本来就有明确写入点（projector），不必让读路径猜。
- **指纹里加 `sum(length(data))`**：否决 —— 数字位数变化（100→500）才变，1→9 不变，不可靠。
- **`loadThrough` 双向无条件各翻一遍**：否决 —— 目标在旧侧是常态，先白翻几百页。
  有 `targetOrder` 就按它判，没有就只向旧翻（旧行为）。
- **文本超限直接拒读（返回空）**：否决 —— 用户看不到内容，也无法判断是空文件还是超限；
  截断 + 标记能定位。
- **前端加「已截断」提示**：本次不做 —— 需要新 i18n key 与三处消费方 UI，`truncated` 字段先留给消费方。

## 后果

- 跳转：1000 条合成消息 `m1..m400 → m900 → m500` 连续定位成立，窗口仍为 400 条。
- 归属：旧会话迟到失败不再让新会话停在 `stalled`；A→B→A 同样拦住；当前会话真失败会给一次错误提示。
- 用量：同一消息原地更新 / 删除 / 无新消息跨天都会重算；未变化时仍返回同一对象引用（缓存命中不变）。
- 读取：超限媒体不再全量读入；3 MiB 文本返回 2 MiB 前缀并标记；正好 2 MiB 不标记。
- **未做**：`context: Infinity` 的大 diff 预算。它会改变 GUI 的 diff 展示面（只显示上下文片段），
  与「读取有界」是两件事，需要单独评估。
- 顺带：`settings-general.tsx` 的生图后端设置面板（写回已下线的 `config.image`）已删除 ——
  它会让 GUI 用户重新制造 RC21-01 那类启动故障，也是 `app` typecheck 唯一的红。
