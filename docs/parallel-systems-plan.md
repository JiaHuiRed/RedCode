# 并行系统收口路线图

> 2026-08-19 定向：RedCode 从「快速加功能」转向「做减法、打磨已有代码」。本文件是这项工作的权威底本（模式同 `dsh-adoption-plan.md`、`tauri-migration-plan.md`），每项落地后更新状态。调研数据出自 0697ae5b 会话。

## 为什么盯「并行系统」而不是「死代码」

减法的价值不在少几行，在**少一个「每次改动都要问一遍」的岔路口**。真正的成本是：同一件事有两套实现，于是每次改动要么写两遍，要么悄悄只改一边。

死代码清理反而是**低收益高风险**的一类。本次调研第一步就踩到：`session/message.ts`（v1 消息 schema）在 `packages/opencode/src` 内零引用，看起来是死文件，**差点删掉**——实际 `packages/web/src/components/Share.tsx:9` 在用，`fromV1()` 是老分享链接的兼容层（分享页收到带 `metadata` 字段的 message 事件时转换成当前结构）。教训：跨包搜索，且「零引用」这类否定结论必须换一种搜法复核。08-10 审计的「防误删名单」记的是同一类事故。

## 战线一览

| 战线 | 状态 | 结论 |
| --- | --- | --- |
| HTTP API v1/v2 | **已关闭** | 不是半截迁移，是两个受众 |
| UI 组件 v1/v2 | **待排期** | 地基铺了房子没盖，应做完不应砍 |
| 会话事件系统双写 | **已摘（2026-08-19）** | 双写摘除、退回单写；详见下节执行记录 |

---

## 战线 2（先说，因为它是个误判）：HTTP API —— 无需决策

调研前我判断「19 个未版本化路由组等着补 v2」，**这是错的**，且该判断一度影响了方向讨论。

`test/server/sdk-v1-smoke.test.ts` 的注释写明：

> Smoke test: **v1 SDK (the plugin contract)** can actually reach core endpoints … **v1 generation has been frozen since #5216 (2025-12-07)**

| | v1（未版本化，2496 行 / 19 组） | v2（327 行 / 5 组） |
| --- | --- | --- |
| 面向 | **插件契约**，已冻结 | 一方客户端 |
| 消费者 | plugin 宿主、`packages/plugin`、`packages/slack`、第三方插件（含自家 DCP 经 `@opencode-ai/plugin`） | app **72** 处、TUI **43** 处 |

app 与 TUI 已 **100% 在 v2 上，零处非 v2**。两套服务两个受众，「迁移完成」等于砸掉全部插件。`packages/plugin/src/index.ts` 同时从两边取类型（多数走 v1，`Provider`/`Model`/`Auth` 走 v2）是刻意的混合。

**结论：保持现状。** 今后新增一方接口走 v2；插件契约的变更另按兼容性流程走。

---

## 战线 1：UI 组件 —— 应做完，不应砍

**现状：地基铺了，房子没盖。**

| | 数量 |
| --- | --- |
| 老组件 | 63 |
| v2 组件（已建） | 27 |
| v2 组件（app/TUI 真正用到） | **5**（icon / icon-button-v2 / avatar-v2 / wordmark-v2 / button-v2） |
| 未被使用的 v2 组件 | **22，合计 2448 行**（不含 stories/css） |
| `v2-*` token 在 app 的用量 | **101 处 / 9 文件** |

token 层已铺开而组件层几乎没动——这是「应做完」的依据：砍掉组件层也**砍不掉 token 层**，砍完仍是混合状态，只是少了半套可用件。

**调用点排行（仅列有 v2 对应版本的）：**

```
toast 28   icon 27   button 26   icon-button 20   tooltip 17   dialog 17
tabs 9     switch 5   select 4    keybind 3        avatar 3     accordion 2
text-shimmer / inline-input / diff-changes / checkbox 各 1
tool-error-card / line-comment / basic-tool 各 0
```

**API 不是等价替换**（抽查）：

| | 老 | v2 |
| --- | --- | --- |
| Button | `variant: primary \| secondary \| ghost` | `ButtonV2` `variant: neutral \| contrast \| ghost` |
| Toast | `showToast()` | `showToastV2()` |

导出符号名、variant 枚举都变了 —— **没有批量替换的可能**，每个调用点要人判断新 variant，这是设计决策不是重命名。

**排期原则**：按组件切，一组件一 commit，从视觉回归风险低的开始。建议顺序 `toast` → `button` → `icon-button` → `tabs`/`switch`/`select` → `tooltip` → **`dialog` 最后**（牵扯焦点管理与栈式渲染，260819 上游采摘刚改过）。零调用点的三个（tool-error-card / line-comment / basic-tool）可直接删老版。

- [ ] toast（28）
- [ ] button（26）
- [ ] icon-button（20）
- [ ] tabs（9）/ switch（5）/ select（4）/ keybind（3）/ avatar（3）/ accordion（2）
- [ ] 单调用点四个：text-shimmer / inline-input / diff-changes / checkbox
- [ ] tooltip（17）
- [ ] dialog（17）—— 最后
- [ ] 零调用点三个：直接删老版

---

## 战线 3：会话事件系统双写 —— 待判决

| | 数量 |
| --- | --- |
| `experimentalEventSystem` 分支 | **23 处 / 6 文件** |
| 涉及文件 | `session/processor.ts`、`session/prompt.ts`、`session/prompt/shell.ts`、`session/compaction.ts`、`cli/cmd/tui/plugin/internal.ts`、`effect/runtime-flags.ts` |
| v2 会话实现 | `src/v2/session.ts` 372 行 |
| 投影层 | `session/projectors.ts` + `projectors-next.ts` 合计 403 行 |
| 规格文档 | `specs/v2/`（api.ts、message-shape.md、notifications.md）+ `src/v2/provider-parity-checklist.md` |
| 默认状态 | **关**（`REDCODE_EXPERIMENTAL_EVENT_SYSTEM`） |

**代价不在行数，在那 23 个分支落在 `processor.ts` 与 `prompt.ts`** —— 全仓改动最频繁的两个文件。每次改这两处都要判断「双写那边跟不跟」，而绕过是零成本的，于是两边会悄悄不一致。

**两条路**：
- **排期打开** —— 需先跑通 `provider-parity-checklist.md`，把默认值翻正。
- **摘掉双写退回单写** —— 删 23 个分支，`src/v2/` 与 `projectors-next.ts` 保留或移入 `specs/`，`specs/v2/` 全部保留备将来。

**判决（2026-08-19，哥哥拍板「摘」）：摘掉双写，退回单写。** 执行记录：

- 摘除：6 文件 23 处 flag 分支（19 个 if 块 + 1 处三元 + TUI 注册 + Pick 类型 + flag 本体）、
  `SessionV2Debug` 调试插件（1186 行）、`context/sync-v2.tsx`（307 行，app.tsx 卸载 Provider）、
  指向不存在目录的 `provider-parity-checklist.md`、`preload.ts` 里给全套件开 flag 的 env 行、
  测试侧 12 处 flag 传参与 1 段双写断言。
- 保留：`specs/v2/`、`src/v2/session.ts`、`projectors-next.ts`、`event-v2-bridge`、
  非门控的 `AgentSwitched`/`ModelSwitched` 发布（有活消费者：projectors-next 投影入库）。
- **执行中修正的三个事实**（判决前的调研有错，记下防复述）：
  1. 「唯一消费者是调试插件」不准确——`prompt.ts` 有两处**非门控**发布（Agent/ModelSwitched，保留），
     测试套件经 preload.ts 全程开着 flag 在测双写（两个用例断言 SessionV2.messages）。
  2. 「src/v2/session.ts 是活的骨干」说重了——它活在 import 图里（httpapi /v2 路由组引用），
     生产零流量。`SessionV2.messages` 读的 session_message 表，引擎侧唯一写入链就是被摘的门控发布。

     > **260820 cc 更正**：本条原来还写着「**/v2 路由组不在 openapi 里，SDK 没有对应方法，
     > 客户端无法调用**」——**这句是错的**。openapi.json 里有 9 个 `v2.*` 操作
     > （`v2.session.list` / `prompt` / `compact` / `wait` / `context` / `messages`、
     > `v2.model.list`、`v2.provider.list` / `get`），SDK 也照常生成了
     > `client.v2.session.*`（`sdk.gen.ts` 的 `class Session3`，经 `class V2` 挂载）。
     > 「客户端无法调用」不成立，成立的只有「没有客户端在调用」——**零调用方，不是零能力**。
     > 这条写在「记下防复述」里，反而成了最容易被复述的错误，08-20 就是照它下的判断。
  3. 「SDK v2」≠「路由组 v2」：sdk/js/src/v2 是**整个 API** 的新生成客户端（app 72 处 / TUI 43 处
     指的是它）；路由组 v2 是事件系统实验面。此前把两者混在一起说了。
- 既有失败不背锅：`snapshot-tool-race` 的 "non-empty session diff" 在 HEAD 基线上同样失败，
  与本次无关，另行处理。

### 后续（2026-08-20）：`/api/session/:id/context` 已确认是空壳

摘除双写的直接后果，08-20 做上下文查看器时撞上并实测确认：

- `prompt.ts` 现在只 publish `AgentSwitched` / `ModelSwitched`，`session_message` 表因此
  只剩这两类行。拷 live 库查：**782 行 = model-switched 501 + agent-switched 281，
  一条对话内容都没有**；真正的会话在旧 `message` 表（51,264 行）。
- 于是 `GET /api/session/:sessionID/context`（"Retrieve the active context messages"）
  对任何真实会话都返回空数组。它在 openapi 里、SDK 里都有，只是**答案是空的**。
- 替代品已落地：`GET /session/:sessionID/context-inspect`（`session/context-snapshot.ts`），
  在请求真正发出的那一刻记账，不依赖 `session_message`。
- **未决**：那个空壳端点的去留。要么让它改读旧 `message` 表重建，要么删掉——两条都是独立
  决定，没混进 08-20 那次改动。删之前注意它是 `/v2` 路由组的一员，动它等于动整组的存废。

---

## 同时进行的其他战线

- **Tauri 迁移**（`tauri-migration-plan.md`，#1–#5 完成，下一步 #6）—— 那是**加法**。若确定转向打磨，建议先停，避免边清理边开新摊子。
- **DSH 采纳**（`dsh-adoption-plan.md` 第二/三批）—— 逐项吸收，与本文件不冲突。

## 不属于本文件的减法

- 同一概念被独立实现多遍（如 token 口径问题 260819 一天内碰到三处：TUI 侧边栏 / GUI 面板 / `overflow.level()` 的档位判据，修了前两处）—— 遇到即合并，不单独排期。
- `runLoop` 850 行、`prompt.ts` 2202 行的结构性拆分 —— **不是减法**（拆完总行数常增加），是把「改不动」变成「改得动」，风险最高、收益最慢，单独排期。
