# 原生压缩预检按 usage 边界估算尾段

状态:implemented

## 问题

原生压缩预检用最近一条同模型 assistant 的 `tokens.context` 作为实报锚点，但增量按出站消息里**最后一条 assistant** 之后切片。中断产生的零 usage assistant 记录比实报记录更新，会占据这个切片边界：其自身 reasoning 与工具输出全部落在估算之外，而实报锚点只覆盖到更早的请求。

回归用例在一个有 100-token 实报锚点的会话后追加两条无实报的中断 reasoning，再发新消息。总尾段超过 10k 的原生压缩触发线；新的判别断言要求预检确实先发摘要请求，再发普通请求。

## 决策

同模型、同压缩代次且 `context > 0` 的实报仍作为基线，该 assistant 记录**整体**（含其 `step-finish` 之后晚到补写的 parts）视为已实报——记录内部不重新投影，保留 261013 预检的排除语义，避免对已实报区间重复计数。预检只对实报记录之后的消息重新投影并估算，再拼上本次临时 request tail。若有效 usage 锚点不可用，沿用整条出站消息、system 与 tools 的保守估算。

## 备选与否决理由

- **继续从最后一个 assistant 之后估算**：否决——零 usage 的中断记录也能充当最后一条 assistant，其 reasoning 全部漏出；新增测试在旧路径上稳定复现该形态。
- **只把 `tokens.output` 加到 `tokens.context`**：否决——消息级 output 会跨 step 累加，且单纯加 output 无法覆盖工具执行结果。
- **每次用整个会话重新估算**：否决——会丢失可靠的 provider 实报锚点，长会话启发式可能提前压缩并增加请求成本。

## 后果

- 预检保留精确的 provider 输入锚点，只对所有实报记录之后仍会进入模型输入的消息做估算。
- 不修改 system prompt、工具 schema、输出格式或注入文案；固定前缀与 KV cache 无变化。修正后的估算可能在此前漏算的场景更早启动既有压缩流程。
- 确定性回归还覆盖 native summary 在途期间的 steer 送达，以及 transcript flush 后、Runner 退出前的 steer 送达；这两项只锁定既有消息状态机，不改变生产行为。

实现与回归入口：`packages/opencode/src/session/prompt.ts`、`packages/opencode/test/session/prompt.test.ts`。
