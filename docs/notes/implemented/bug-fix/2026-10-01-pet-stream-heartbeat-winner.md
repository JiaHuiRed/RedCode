# 桌宠流式心跳与获胜会话归属

日期：2026-10-01　范围：`packages/app/src/pet/pet-state.ts`　类型：bug-fix

## 现象

长流式回合（纯文本/推理生成超过 90 秒）中，赤在回复中途被打回 idle；回合正常结束后也没有 success 庆祝。纯 reducer 探针可复现（260930 调查，无文件改动）：

- busy → tool completed（worked=true）→ text delta 持续 120s → `resolvePet` 得 `{ kind: "idle" }`，`worked` 为空，idle 后无 flash。

## 根因

事件源换血（260929，见文件头注释）后，产出期真正的高频事件是 `message.part.delta`（`session/processor.ts` 的 reasoning-delta/text-delta 都走 `updatePartDelta`），而 `applyPetEvent` 没有这个 case：

1. **delta 无消费者**：thinking entry 自 busy 开张后拿不到任何心跳，90s `STALE_MS` 一到就被 `pruneStale` 删除，`worked` 连坐清掉——这就是「中途变 idle + 无 success」的完整链条。
2. **part.updated 只建不刷**：text/reasoning 分支 `if (!state.sessions[id])` 才创建，已有 thinking entry 的 `at` 永不更新。part.updated 是低频定型事件，两次定型之间照样超时。
3. **后续 step 的 busy 不刷新**：busy 分支只在无 entry 时建 thinking，多步回合后续 step 不续命（症状同 2，事件频率更低）。

## 修复

- **delta 心跳**：`message.part.delta` 的 properties 顶层自带 sessionID（`EventMessagePartDelta`），O(1) 刷新已有 thinking entry 的 `at`；无 entry 时兜底创建。等用户（waiting/permission）与具体工具态（coding/searching/tool/compacting）不被心跳覆盖或刷新——前者「回应后回 thinking」的语义不受干扰，后者的 `at` 由各自事件维护。
- **part.updated 刷新**：text/reasoning 对已有 thinking entry 也刷新 `at`。
- **busy 刷新**：已有 thinking entry 时刷新 `at`，worked 复位仍严格限于「无 entry = 新回合开张」的边沿，260929 修的 A6 不回退。
- **获胜归属**：`resolvePet` 改 `Object.entries` 记录获胜 sessionID，`PetDisplay` 交叉可选 `sessionID` 字段。V0.2 表现层（模型装扮/语境跟获胜会话走）的契约前提；flash 是全局单例无归属，idle 为空。PetLayer 现有消费（`display().kind`）零改动。

## 否决的备选

- **给 text/reasoning 活动设 worked=true**：违反「纯问答不庆祝」的既有设计（worked 只认工具），且心跳修好后该场景不复存在。
- **per-token 驱动动画**：渲染节奏在 PetLayer 的 1s tick，reducer 只维护时间戳，不为 delta 增加任何动画/渲染路径。
- **拉长 STALE_MS 掩盖**：心跳缺失是机制问题，改超时只是把 90s 换成别的数字，事件链断了的兜底语义也被稀释。

## 边界

- delta 心跳只认 thinking entry：晚到的 delta 不会复活工具态，也不会刷新等用户状态。
- `resolvePet` 同优先级 tie-break 保持遍历序（严格大于），行为不变。
- flash 不记 sessionID：需要 per-session flash 归属时在 `state.flash` 上扩展，本轮不做。

## 验证

- `bun test ./src/pet/pet-state.test.ts --timeout 30000`：25 pass 0 fail 55 expects（原 20 条断言补 sessionID 后全绿，新增 delta 续命/防覆盖/text 刷新/busy 刷新/无 sessionID 安全 5 条）。
- `bun run typecheck`（packages/app）：EXIT 0。
- 未跑真实 GUI 冒烟：reducer 层纯函数已覆盖失败模式，PetLayer 消费面未变。

## 模型可见四问

全部为零：`PetDisplay`/`resolvePet` 是 GUI 内部展示类型与纯函数，不进提示词、不进注入面，KV cache 无关。

## 回链

- CHANGELOG `[未发布]` 修复段。
- 前置决策：`docs/notes/implemented/bug-fix/2026-09-29-pet-worked-busy-reset.md`（worked 判据与 pruneStale 落点）。
