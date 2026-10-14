# Execute 子代理决策收敛提示词

状态: implemented

## 现场证据

两个 step-5-preview/medium 的 execute 子任务分别运行 16.20 分钟（62 个 assistant turns）和 15.87 分钟（82 turns）。SQLite 中 reasoning parts 合计 346,649 字符；159 次工具调用为 read 78、bash 64、grep 16、gash 1，没有 edit/write/apply_patch；两个 worktree 的 `git status --short` 都为空。最终 finish 是 stop，未见 `finish=length`。

因此已证实的是「长时间调查/推演、没有落盘」，**不是** provider 已强制输出截断。`execute.md` 原本已写「不做方案研究，直接实现」，但缺少如何结束权衡、何时开始实际修改的执行门槛。两条任务提示词分别约 3.3K 字符并包含较多局部约束；它们是上下文，不足以单独证明因果。

## 决策

只修改 execute 子代理定义 `packages/opencode/src/agent/definition/execute.md`，在文件末尾追加「决策收敛」：

- 先做一轮有边界的检查（任务相关代码、测试、就近 instructions），有明确缺口再扩展。
- 证据足够后选择最小方案并冻结；只有新代码事实或验证失败才重开。
- 实现授权明确时，检查完立即开始首个可验证改动（失败测试或最小实现），不以方案文本或“准备动手”代替交付。
- 后续调查必须回答尚未解决的问题；重复操作没有新证据或落盘时，停止循环并报告具体阻塞。

不增加工具调用硬上限、不跳过必要调查、不要求所有任务强制先写测试；正常的删代码搜引用、跨调用方核对、失败后换思路与验证要求保持不变。规则追加在文件末尾，避免改写现有 system prompt 前缀。

## 备选与否决理由

- **只改这两次派发 prompt**：否决——任务级 prompt 是调用方临时文本，不能稳定约束后续 execute 任务；角色定义才是其固定工作方式 owner。
- **固定工具调用次数或总时长**：否决——长任务的读/测/改次数不同，硬阈值会误杀正当工作；以“是否新增证据/落盘”作为收敛判据。
- **强制每个任务 TDD**：否决——文案、配置等实现不都需要同一流程；只要求授权后的首个可验证改动。

## 后果与验证

规则对所有使用 execute agent 的任务生效，不只针对 step-5-preview。提示词能收紧工作流，但不能保证模型永不重复思考；后续真实任务还需观察首次编辑时机、无进展工具调用和最终落盘，才能判断收益。按现有约束没有调用真实供应商做验证。

`test/agent/agent.test.ts` 先加 system prompt 注入断言，旧定义下 1 fail；更新后完整文件 53 pass / 0 fail，242 expects。追加规则移动到 EOF 后，针对注入断言重跑 1 pass / 0 fail；opencode typecheck 通过（tsgo 崩溃后既定 TypeScript 5.9.3 fallback 成功）。

模型可见四问：

1. execute system prompt 末尾新增上述四条「决策收敛」规则；不改用户消息、工具 schema、请求参数或其他 agent prompt。
2. 相对 HEAD：提示词增加 211 个字符 / 571 UTF-8 bytes；按 `Token.estimateReporting`（诊断估算，非 provider tokenizer）增加约 94 tokens，低于 1K。
3. 新段追加在 execute prompt EOF，之前的 prompt 字节不变；`llm/request.ts` 会在它后面继续拼接 `input.system` / `user.system`，所以 system 前缀可复用，缓存从新增段起至 system 末尾需重建一次，不是只增加孤立尾 token。
4. 无动态注入或无界输入；新增文本固定 571 UTF-8 bytes，边界由静态源码确定。

回链：`packages/opencode/src/agent/definition/execute.md`（文件末尾「决策收敛」）；CHANGELOG Unreleased。
