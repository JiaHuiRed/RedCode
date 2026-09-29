# Pet：worked 被每个 step 的 busy 清零，过期 entry 只跳不删

状态:implemented

## 问题

第三方审计（`E:\dwonload\REDCODE_AUDIT_2026-09-29_ROUND2.md`）提了两条 Pet 的，
都不在我改过的文件里，但两条都坐实。

### A6（P1）worked 被每个 step 的 busy 清零

`pet-state.ts` 的 `session.status` 分支：

```ts
// busy / retry：新回合开张，重置 worked
state.worked[sessionID] = false
if (!state.sessions[sessionID]) setEntry({ kind: "thinking", at: now })
```

而 `session/prompt.ts:1138` 的 `yield* status.set(sessionID, { type: "busy" })` 在
`while (true)` 里——**每个 step 顶部都发 busy，不是每回合一次**。

于是多步回合的真实链路是：

```
step1: busy(worked=false) → tool running → tool completed(worked=true)
step2: busy(worked=false) → 只剩纯文本 → idle(worked=false → 不庆祝)
```

「第一步用了工具、第二步模型只吐文本」这种最常见的收尾，success flash 永远不触发。
而 `worked` 的设计意图（见同文件注释）是「**本回合**动过工具才庆祝，纯问答不庆祝」——
实现把它降级成了「**本 step** 动过工具」。

原有 7 条相关测试每回合只喂一次 busy，所以这个漏洞一条都没抓到。

### A7（P2）过期 entry 只跳不删

`resolvePet` 对过期 entry `continue`，不删除。`state.sessions` 于是只增不减：
流中断、切走后再也不发 idle 的会话会永久留下记录，且每次 resolvePet 都要全量遍历它们。
`worked` 同样只在 idle/error 时清，跟着一起漏。

## 做法

### 1. worked 只在 idle→busy 边沿复位

```ts
if (!state.sessions[sessionID]) {
  state.worked[sessionID] = false
  setEntry({ kind: "thinking", at: now })
}
```

「没有 entry」正是那条边沿：idle 会 `delete state.sessions[sessionID]`，session.error 也会。
所以新回合（idle 之后）和重试（error 之后）都照样复位，只有同一回合内后续 step 的
busy 不再复位。

顺带解决了另一个隐患：entry 过期但没被删时，旧实现遇到 busy 会照样复位 worked；
现在 prune 跑在事件处理之前，过期 entry 已经不存在了。

### 2. 清理放在写入点，不放在 resolvePet

`resolvePet` 是 `createMemo` 里的纯投影，不能让它顺手删状态。改成导出
`pruneStale(state, now)` 在 `applyPetEvent` 开头扫一遍：

- 事件频率足够高（每个 part 更新都来一次），成本是 O(会话数)
- `feedPetEvent` 本来就用 `produce` 包着的，删除会被 solid-js/store 正常跟踪
- 不依赖 PetLayer 的 1s tick——关宠后事件仍在喂，清理不能停

`resolvePet` 里的 `entryExpired` 跳过逻辑保留作纯读侧的兜底。

## 模型可见四问

不涉及模型可见内容（`pet-state.ts` 是 GUI 渲染态，不进任何提示词或工具 schema）。
唯一的行为变化是**用户可见的**：多步回合现在会正确庆祝，纯问答仍然不庆祝。

## 验证

- `bun test ./src/pet` → 20 pass 0 fail（新增 3 条）
- oxlint 两文件 → 0 error；3 条 warning 全在 `resolvePet` 既有行（`PRIORITY[...]!` 与
  `state.flash!.kind`），`git diff -U0` 证明不在本次改动范围
- typecheck（packages/app）→ EXIT 0

新增三条回归：
- `多步回合：下一步的 busy 不抹掉上一步的 worked` —— 直接复现审计那条链路
- `新回合仍复位 worked：上一回合干过活，这一回合纯问答不庆祝` —— 钉住边沿语义没被
  修反（这条比上一条重要：只修第一条会把「纯问答也庆祝」引进来）
- `过期 entry 在下一个事件时被清掉，不再只跳不删`

第二条最初写成 `expect(state.flash).toBeUndefined()`，挂了——flash 从不被删除、
只按时间失效，`state.flash` 永远留着上一次的值。改成断言 `resolvePet` 的展示态。

## 回链

- `packages/app/src/pet/pet-state.ts` — `pruneStale` / `session.status` 分支
- `packages/opencode/src/session/prompt.ts` — busy 每 step 发送的那一行
