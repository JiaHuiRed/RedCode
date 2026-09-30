# 工具 deadline 的取消信号覆盖整个执行作用域

状态:implemented

## 问题

`Tool.timeoutMs` 已有统一 Effect 超时和 typed `Tool.TimeoutError`。但旧包装把调用方原始 `ctx.abort` 原样给工具，工具只监听该信号时，自己的 deadline 不会取消底层操作。新增真实 `Tool.define` 用例超时后观察到信号仍是调用方信号，回归先红。

## 决策

声明了 `timeoutMs` 的工具，在独立作用域创建 `Effect.abortSignal`，和调用方信号通过 `AbortSignal.any` 合并，传给局部 context 副本。该作用域包住整个 `timeoutOrElse`，结束或中断时关闭；调用方原始 context/signal 不改。

超时仍返回原有 typed error，外层 fiber 取消仍是 interruption，不误报本工具 timeout。未声明预算的工具保持原执行路径，没有新增默认 deadline。

## 备选与否决理由

- **只把作用域放在 timeout 的工作分支内**:否决——外层中断用例证实返回时该分支的 signal 尚未取消；timer 和工作分支的竞速需要被同一个外层取消作用域覆盖。
- **直接 abort 调用方 controller**:否决——工具预算不能取消整个模型请求或其他并行调用。
- **对全部工具硬套固定时限**:否决——不同工具已有独立预算策略，不增未经配置的可调常量。

## 后果与验证

取消是协作式的；底层忽略 signal 时仍可能继续运行，不承诺硬杀或等待任意不配合操作完成。成功完成也关闭该工具局部信号作用域。

真实包装测试覆盖 deadline 触发、调用方 fiber 中断、正常成功和无预算工具。五条通过；局部取消不 abort 调用方，外层中断 cause 只有 interruption。

模型可见四问：错误文案和工具 schema 不变；固定前缀增量 0；KV cache 不动；无新增注入项。
