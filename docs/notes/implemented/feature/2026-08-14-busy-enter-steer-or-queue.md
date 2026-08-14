# 繁忙时消息送达策略:busy_enter 可选 steer(插话)/queue(排队)

状态:implemented

## 问题

busy 时发的消息一直是"落库 + 下个 step 以 `<system-reminder>` 注入进行中轮次"(260623 建、260729 修好边界与去重)——**server 侧本来就是插话语义**。但用户体感是"只有排队":TUI 的 QUEUED 徽标从提交挂到轮次结束,消息早被模型吃了徽标还挂着;且注入要等当前 step 的工具调用返回,长 step 期间像没反应。同时**真排队并不存在**:想"攒着别打扰当前轮"做不到——中途消息就在消息历史里,即使不发 reminder,下个 step 组消息时模型照样看见。DSH(deepseek-harness)把这做成用户可选(`ui-input-trigger` 的排队/插话双模),用户实测后点名要选择权。

## 决策

config 顶层加 `busy_enter: "steer" | "queue"`(默认 steer=原行为,一字不动):

- **steer**:reminder 注入照旧。
- **queue**:① reminder 收集整块跳过;② 组装点把"本轮起点之后新到的 user 消息"从模型可见消息里滤掉(`visibleMsgs`,只滤整条、不动 `msgs` 本体——compaction/msgPin/续跑判断仍按全量);③ 轮末消费不需要新代码——既有退出条件 `lastUser.id < lastAssistant.id` 在存在更新消息时不成立,循环天然续跑,配合"续跑边界把 `turnStartUserID` 前移到最新 user 消息"(仅 queue 模式动这个边界,steer 的 260729 雷区不碰),排队消息从"对本轮隐藏"转为"新轮开轮输入"。

## 备选与否决理由

- **客户端 hold 消息到 idle 再提交**:否决——消息不落库就没有 QUEUED 展示、崩了丢消息,且 GUI/TUI 要各写一份;server 侧统一语义两端免费。
- **queue 模式轮末显式 `continue` 开新轮**:否决——`lastUser.id < lastAssistant.id` 的既有退出条件已经天然续跑,再写一条是重复机制。
- **过滤做在 `msgs` 源头**:否决——msgs 被 compaction、latest、reminder、msgPin 全链共享,源头过滤会让压缩阈值和续跑判断都看不见排队消息;只在喂 `toModelMessagesEffect` 处滤,影响面最小。
- **配置放 tui.jsonc**:否决——注入是 server 行为,TUI/GUI 共用一个开关;放 redcode.jsonc 顶层(`busy_enter`),与 `default_agent` 等同级。

## 后果

- steer 模式行为与改动前逐字节一致(reminder 块只是包了条件)。
- queue 模式下 stabilizedMsgs 的增量缓存逻辑不受影响:被滤消息从未进过 modelMsgs,续跑轮它作为尾部增量首次进入,前缀稳定性保持。
- 送达可见性(QUEUED 徽标在 steer 模式下应变"已送达")未做——需要 user 消息 schema 加字段 + sync 推送 + 双端 UI,单独一批;当前 QUEUED 徽标语义在 queue 模式下准确、在 steer 模式下仍偏保守(显示排队实际已送达)。
- V1 切换方式是改 `redcode.jsonc`;TUI 命令面板/GUI 设置面板的开关后续补。
