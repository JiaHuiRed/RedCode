# 桌宠装扮桥接：获胜会话 → 模型 → 装扮

状态：implemented

## 问题

`resolvePet` 自 260930 起就把获胜会话的 `sessionID` 输出在 `PetDisplay` 上（`pet-state.ts:56-59`），注释写明「表现层（V0.2 装扮/语境）按它取模型上下文」——但全仓零消费：`pet-layer.tsx` 只按 `display().kind` 查 `PET_IMAGE`，没有装扮维度。

另一半问题是**没有 sessionID → 模型的通路**。app 侧的 session 状态不带 model（`event-reducer.ts` 里的 `model` 字样属于额度 `providerID`；`session-cache.ts` 没有），模型挂在 **message** 上（`message.updated` 的 `info.model`，形状 `{ providerID, modelID }`，与 `event-reducer.ts:269-271` 一致）。

## 决策

- 模型随现有事件流进来：`applyPetEvent` 新增 `case "message.updated"`，`info.sessionID` 与 `info.model?.providerID` 同时存在时写 `PetState.models[sessionID]`。字段缺失静默忽略，不因缺字段抛错。
- `models` 的生命周期**完全对齐既有 `worked`**（`pruneStale` 随 entry 删、`session.status` 的 `idle` 分支删、`session.error` 分支删）——同一个会话键、同一批清理点，避免长出第二条只增不减的记账。
- 纯函数 `outfitFor(state, sessionID)`：查不到（无 sessionID / 无模型）返回 `DEFAULT_OUTFIT`，否则返回该会话的 `providerID`。装扮维度定为 **providerID**。
- 渲染侧：`sprite` memo 在 outfit ≠ `DEFAULT_OUTFIT` 时，把 `PET_IMAGE[kind]` 的 `/pet/` 前缀换成 `/pet/outfits/<encodeURIComponent(providerID)>/`；`PET_IMAGE` 表结构不动（它存的是完整路径）。咖啡帧（`presentation.action === "coffee"`）不参与装扮。
- `onError` 回落链扩成三级：装扮图 → 基础图 → 占位图（`hamster.png`）→ 隐藏。第三级沿用既有行为。

## 备选与否决理由

- **装扮映射做成 settings 配置字段**：否决。V0.2 note 已定「可调参数归 `settings.v3.general.petBehavior`、无设置页控件」，而装扮是**从模型推导**的、不是用户旋钮；再加一层配置只会多一个会和目录对不上的真相源。
- **凭空定一套 outfit 名单**（openai/anthropic/deepseek…）写死在代码里：否决。素材尚未生成，写死名单等于凭空造契约；直接拿 `providerID` 当目录名是自解释的，且素材缺失自动回落，不需要预先声明。
- **细到 modelID**：本批否决。同一 provider 下不同模型换不同装扮，收益不明而映射表会立刻膨胀；结构上留了扩展点（要细分只需在 `outfitFor` 里加一层覆写表，不改调用方）。
- **单独抽 `pet-outfit.ts` 模块**：否决。resolver 只有一行、只有两个调用方（渲染 + 测试），按 app 包「不要预抽单次使用的 helper」抽成模块属过度工程。

## 后果与范围

- **素材未生成，本批只落机制**。`packages/app/public/pet/outfits/<providerID>/` 不存在时，装扮图 404 → 回落到基础 13 图，视觉与本批之前完全一致。
- 装扮目录约定：文件名与基础集同 kind（`01-idle-look.png`、`03-thinking.png` ……），只是多一层 `outfits/<providerID>/`。
- 未做「桌面独立窗口 / 拖拽」那一档——`packages/desktop/src` 侧零宠物/透明窗/置顶代码。
- **本批无模型可见改动**：不发引擎事件、不改提示词与工具 schema，固定前缀与 KV cache 均不变，无新增注入项。
- 顺带修掉 `pet-state.ts` 头部两处**指向不存在文件**的过时注释：原写 `E:\AI\dsh-pet\PET_EVENT_SOURCE_MAPPING.md` 与 `REDCode_PET_SYSTEM_DESIGN.md`（前者是另一台机的盘符，两文件本机均不存在），改为指向本机真实存在的三篇 pet note，并保留一条「该文档不在本仓」的说明而不是把引用删掉。

## 验证

- `bun test --conditions=browser --preload ./happydom.ts ./src/pet/pet-state.test.ts ./src/pet/pet-lines.test.ts --timeout 30000`：**47 pass / 0 fail**。新增 outfit 四组用例：记录 provider、缺 sessionID / 缺 model 双路回落、`idle` + `session.error` + `pruneStale` 三路清理、permission（最高优先级）获胜会话与 `outfitFor` 指向同一会话。
- `bun run typecheck`（`packages/app`）：`tsc -b` 绿。
- **未做真实浏览器视觉验证**：装扮素材不存在，视觉路径与改动前一致，无可视差异可验——等素材落地后应补一次真机核对。

## 前置与后续

- 前置契约：`docs/notes/implemented/bug-fix/2026-10-01-pet-stream-heartbeat-winner.md`（获胜 sessionID）。
- 后续一：桌面独立透明置顶窗（另一档，需在 `packages/desktop` 主进程从零起一个透明无边框置顶窗 + 鼠标穿透 + 多屏 + 位置持久化 + 打包），尚未开工。
- 后续二：`04-planning.png` / `08-reviewing.png` 素材在盘却从未接线——**不是漏接，是没有对应事件源**，接线前先要有能产生这两个态的事件。
