# 子代理运行中定向纠偏（非打断式 steer）

状态: implemented

## 问题

子代理跑偏时父会话只有两个选择：等它跑完（烧 token），或取消重派（丢失已完成工作与已读上下文）。官方 Codex 有 `send_input`（运行中向子代理追加指令，可选打断）；本仓 `task_status` 只有轮询/等待/级联取消，没有运行中输入通道。

## 决策

`task_status` 新增可选 `message` 参数（纯文本纠偏，不打断、不取消、不回收工作目录）：

- **准入**：仅任务的直接父会话可发（`session.parentID === ctx.sessionID`）；目标必须是 `running` 的 background task；文本非空白且 ≤16,384 UTF-8 bytes；与 `wait`/`timeout_ms`/`cancel` 互斥。
- **投递**：复用既有 `TaskPromptOps.prompt(delivery: "steer")` 通道，继承目标最后一轮的 agent/model/variant，消息落库后由下一 step 的 reminder 注入消费；父会话取消或任务收尾时投递 fiber 随任务实例 scope 中断。
- **控制通道**：`task.ts` 的 `runSteerableTask` 包裹任务运行体——执行期在进程内 Map 注册 `{parentSessionID, send}`（`EffectBridge.fork` 捕获任务实例的 InstanceRef/隔离边界），收尾先关准入再 `Fiber.join` 等待已接受的投递，复用既有收尾重试，收尾竞态不丢回执；任务结束/取消即摘除，不新增常驻状态。
- **回执**：以持久化消息的 `delivery` 为准（`queued`=已保存待下一 step、`delivered`=已随请求发出），输出 `task_id`/`message_id`/`delivery` 三行；轮询语义不变。投递 fiber 失败或任务在消费前结束则显式报错，不把排队谎报为已消费。

## 备选与否决理由

- **新增独立 steer 工具**：否决——工具表膨胀；目标定位与状态查询同属 task_status 语义。
- **投递即打断当前 step**：否决——丢已生成内容；纠偏靠下一 step 的 reminder 注入即可生效。
- **向空闲/已结束任务投递并借此启动**：否决——凭空开工；空闲任务的纠偏应随新任务一起派发。
- **unbounded 等待投递被消费**：否决——工具调用挂起风险；回执窗口内有界轮询，之后交由任务自然消费。

## 后果

- 文本上限 16,384 bytes 是防注入面的硬预算；附件/模板解析不走（纯文本）。
- steer 消息是普通 user 消息，走会话正常持久化与 task record 边界，无旁路。
- 任务收尾瞬间送达的消息：收尾路径 join 后按 `compareTime` 取更晚结果，不会静默丢弃；取消路径中断投递并报 cancelled。
- 验证：`task_status.test.ts` 8 pass（空白/超限/无目标任务/非直接父/空闲拒绝，既有轮询取消不回归）；`prompt.test.ts` steering 四态 4 pass（真实 TestLLMServer 全栈：queued→delivered、子目录隔离保持、取消即断、final-step race 不丢回执）+ 忙时手动压缩集成 2 pass；两文件 82 pass / 13 skip / 0 fail，typecheck 通过。全部离线 fixture。

模型可见四问：

1. `task_status` 工具 schema 尾部新增一个可选 `message` 参数及一行说明（既有参数顺序不变）；工具说明 md 同步。运行中任务的下一 step 会看到既有 reminder 注入格式的纠偏文本。
2. 工具定义区前缀增加约 60 tokens（参数+描述）；其余注入段零增量。
3. KV cache 从 task_status 工具定义处失效一次（工具表变更属预期一次性成本）；运行期无逐轮重置。
4. 硬上限：message ≤16,384 UTF-8 bytes（execute 显式拒绝超限）；回执输出固定三行，无新增无界注入。

回链：`packages/opencode/src/tool/task.ts`（runSteerableTask 头注释）、`packages/opencode/src/tool/task_status.ts`（message 分支注释）、`packages/opencode/src/tool/task_status.md`。
