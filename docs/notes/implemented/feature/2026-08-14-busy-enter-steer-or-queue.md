# 繁忙时消息送达策略:逐条服务端队列与 busy_enter 兼容默认

状态:implemented

## 问题

busy 时发的消息一直是"落库 + 下个 step 以 `<system-reminder>` 注入进行中轮次"(260623 建、260729 修好边界与去重)——**server 侧本来就是插话语义**。但用户体感是"只有排队":TUI 的 QUEUED 徽标从提交挂到轮次结束,消息早被模型吃了徽标还挂着;且注入要等当前 step 的工具调用返回,长 step 期间像没反应。同时**真排队并不存在**:想"攒着别打扰当前轮"做不到——中途消息就在消息历史里,即使不发 reminder,下个 step 组消息时模型照样看见。DSH(deepseek-harness)把这做成用户可选(`ui-input-trigger` 的排队/插话双模),用户实测后点名要选择权。

全局 `busy_enter` 解决了排队/插话的默认策略,但仍不能对单条消息做选择,也没有服务端权威状态供用户编辑或撤销;GUI 的旧本地 followup 队列不落库,且已被禁用。

## 决策

config 顶层保留 `busy_enter: "steer" | "queue"`(默认 steer=原行为,一字不动),作为未显式指定送达方式的兼容策略:

- **steer**:reminder 注入照旧。
- **queue**:① reminder 收集整块跳过;② 组装点把"本轮起点之后新到的 user 消息"从模型可见消息里滤掉(`visibleMsgs`,只滤整条、不动 `msgs` 本体——compaction/msgPin/续跑判断仍按全量);③ 轮末消费不需要新代码——既有退出条件 `lastUser.id < lastAssistant.id` 在存在更新消息时不成立,循环天然续跑,配合"续跑边界把 `turnStartUserID` 前移到最新 user 消息"(仅 queue 模式动这个边界,steer 的 260729 雷区不碰),排队消息从"对本轮隐藏"转为"新轮开轮输入"。

另增加服务端持久化的逐条送达状态:

- `PromptInput.delivery?: "queue" | "steer"` 是单条消息的可选覆盖;省略时保持旧 `busy_enter` 语义。忙时 GUI 默认 `queue`,可在提交前切换为 `steer`;TUI 默认 `queue`,用 `/pending` 逐条管理。
- 消息状态保存在既有 `message.data` JSON 中,不新增 DB schema: `UserMessage.delivery` 为 `queued`、`steer` 或 `delivered`。服务端按消息创建时间与 ID FIFO 领取;`queued` 从当前模型输入和轮次边界中排除,轮末只领取一条,领取后才进入下一轮。
- `POST /session/:sessionID/message/:messageID/deliver` 将单条待发消息切为 `steer`,在下一个安全模型步骤送达,不打断当前调用;`PATCH .../queued` 修改待发消息文本,`DELETE .../queued` 撤销。领取、编辑、撤销和插队共用会话锁;被领取后编辑/撤销返回冲突,不使用时间戳猜测是否已消费。
- GUI dock 与 TUI `/pending` 直接读取同步的服务端消息状态;API 失败保留队列项并显示错误。旧版本遗留的 GUI 本地草稿仍保留,空闲时迁移到服务端队列,不会静默丢弃。

## 备选与否决理由

- **客户端 hold 消息到 idle 再提交**:否决——消息不落库就没有 QUEUED 展示、崩了丢消息,且 GUI/TUI 要各写一份;server 侧统一语义两端免费。
- **只保留全局 `busy_enter`**:否决——作为旧客户端兼容默认保留,但不能满足单条消息的排队、插队、编辑与撤销选择。
- **打断当前生成以立即送达**:否决——“立即”定义为送到下一个安全步骤,不取消、不重启当前模型调用。
- **queue 模式轮末显式 `continue` 开新轮**:否决——`lastUser.id < lastAssistant.id` 的既有退出条件已经天然续跑,再写一条是重复机制。
- **过滤做在 `msgs` 源头**:否决——msgs 被 compaction、latest、reminder、msgPin 全链共享,源头过滤会让压缩阈值和续跑判断都看不见排队消息;只在喂 `toModelMessagesEffect` 处滤,影响面最小。
- **配置放 tui.jsonc**:否决——注入是 server 行为,TUI/GUI 共用一个开关;放 redcode.jsonc 顶层(`busy_enter`),与 `default_agent` 等同级。

## 后果

- 未传 `delivery` 的旧调用仍按 `busy_enter` 工作;GUI 与 TUI 的新忙时提交逐条落服务端,GUI 默认排队、TUI 可用 `/pending` 管理,命令/shell 与空闲提交语义不变。
- `UserMessage.delivery` 让新消息状态可由服务端同步给两端;无此字段的历史消息继续用原时间戳启发式显示。
- 队列操作和领取共用会话锁。用户只能在消息仍为 `queued` 时编辑或撤销;一旦领取,所有客户端操作都会收到冲突而不是误报撤销成功。
- 领取时必须清掉会话的 `modelMsgs` 增量缓存:排队消息创建早于前一轮 assistant,领取后插入历史而非尾部;保留旧缓存会把新轮用户消息放错位置。另追踪领取的 message ID,防止上一轮已完成的 assistant 被误认为新消息的回复。

## 队列领取重置 turn 预算（261006）

`runLoop` 的 step 计数和恢复状态原本跨越整个 loop。领取一条排队消息虽然开始了新的逻辑用户 turn，却沿用前一 turn 已消耗的 `agent.steps`；当 `steps: 1` 且队列里还有消息时，第一条回复后领取的消息会在模型调用前撞上旧预算，未领取的后续消息也无法继续推进。回归测试 `starts queued turns with a fresh step budget in FIFO order` 在修复前因 provider 请求数少于预期而失败。

两个 `claimQueuedMessage` 领取点现在共用 `resetQueuedTurn(messageID)`：记录领取 ID、清 `modelMsgs` 缓存、将 step 归零，并清除 loop recovery prompt/tracker、force-continue、reasoning-only/empty-turn 重试、XML salvage recovery、turn 起点和已提醒消息 ID。`usageTokens` 仍在整个 run 中累计，`softContextNoticed` 仍只提醒一次；标题生成原有「仅一条真实用户消息」守卫不变，三个用户消息的回归用例同时验证没有额外标题模型请求。实现与变更入口：`packages/opencode/src/session/prompt.ts`、`CHANGELOG.md`。
