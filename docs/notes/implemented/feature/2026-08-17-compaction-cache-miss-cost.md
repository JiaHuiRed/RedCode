# 压缩边界全灭代价优化（cache turn=0 根治）

日期：2026-08-17 · 状态：implemented · 来源：公司实测 cache turn=0 双来源之二

## 问题

260817 公司实测：`prompt-caches ... reason=compaction droppedEntries=284`——**每次压缩后第一轮必然全灭**。机制：压缩代理重写上下文（历史被摘要替换）→ `settlePromptCaches` 丢 msgPin/modelMsgs → 压缩后前缀与云端缓存无共同点，压缩代理轮 + 恢复轮两次全价。

实测代价：每次压缩固定 2 次全灭 ≈22.6 万 token 全价（压缩代理轮 ~177K + 恢复轮 ~49K）。缓存命中率面板（`cacheRead / (cacheRead + miss + write)`，`packages/app/src/pages/home-stats.tsx:53-55`）被全灭轮持续拉低——长会话命中率从 97% 一路掉到 93%。

双来源拆分（这是第 ② 个，代码侧）：
- ① opencode-go 网关 Cloudflare 多节点路由：`cf-placement` 节点切换、节点间 prefix cache 不共享（429 GoUsageLimitError 佐证）。**换官方直连已根治，非代码问题。**
- ② 内置压缩边界（本次修）：压缩代理请求体体积 + 恢复轮体积都过大。

## 决策

1. **压缩代理请求体跳过 head 的 reasoning part**（`session/compaction.ts` `processCompaction`）：摘要模型只需要工作内容（text/tool），不需要思考过程——reasoning part 约占 head 的 40-50%，`structuredClone(selected.head)` 后按 `part.type !== "reasoning"` 过滤。与既有 `stripMedia: true` 同类轻量化操作。
2. **`MAX_PRESERVE_RECENT_TOKENS` 8000 → 50K**（`session/compaction.ts:41`）：8000 太小是结构性隐患——长会话最近 2 轮通常几万 token，装不进 budget 就触发 `select()` 的 tail fallback（`keep=undefined → head=全部历史`），压缩代理请求体爆炸（~177K 全价）**且最近细节也被压缩掉**。50K 后最近轮次保留原样（head 只剩老历史），budget 仍受 `usable*0.25` 上限约束，小上下文模型自动收缩。

## 备选与否决理由

- **reasoning 保留 + 摘要提示词显式忽略**：请求体照样大，浪费带宽与 cache write，弃。
- **tail 预算动态化（按轮数/按百分比自适应）**：先按常量 50K 落地，等实测命中率回升数据再决定是否要更精细的档位，避免一次引入两个变量。

## 后果

- 每次压缩全灭代价预期从 ~22.6 万 token 降至 ~10 万（压缩代理轮 177K → ~90K，恢复轮随 tail 保留保持在 50K 量级）。
- 新增用例 `compaction request skips reasoning parts from head`（`test/session/compaction.test.ts`）：带 reasoning part 的历史压缩时，发给摘要模型的请求体不含思考内容、text 照常。
- 验证：compaction.test.ts 61 用例全过 + `cd packages/opencode && bun run typecheck` exit 0。
- 未覆盖：压缩后恢复轮仍会全灭一次（摘要替换历史的结构性代价，无法消除，只能缩小）；公司侧命中率回升需次日实测确认。
