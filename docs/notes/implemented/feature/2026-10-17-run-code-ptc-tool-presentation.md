# run_code：PTC 形态的工具呈现（实验，默认关闭）

状态: implemented

## 问题

RedCode 只有原生 function calling：每个工具调用是一轮 assistant 输出，工具结果再原样回到对话。
工具多、轮次多的任务里，这两笔成本都很实在——模型要多说几次"我要调什么"，中间结果也要整段
留在上下文里。

DeepSeek Harness 的 PTC（prompt tool calling）形态给了另一条路：模型只看到 `run_code` 加一份
按可见工具生成的 SDK，写一段程序一次调完多个工具；中间结果留在程序里，只有外层打印/返回值进
对话。官方 1017 公告说新模型针对这类 harness 形态做过优化，并把最低版本抬到 `0.2.1-rc.1`。
（本仓审计未发现 1017 专属代码分支；`1017` 在 Harness 里是展示角标，不改变请求。）

## 决策

- 新增工具 `run_code`，**默认不注册**：`REDCODE_EXPERIMENTAL_RUN_CODE=1`（或 `REDCODE_EXPERIMENTAL=1`）
  才进工具表。关闭时工具表、固定前缀、KV 缓存布局全部零变化。
- SDK 由**本次请求真正可见的工具集合**生成（已过 agent 权限、model tools 开关、插件与 gate 过滤），
  所以模型不会看到调用不了的绑定。生成器按 id 排序：同一集合产出逐字节相同的声明。
- 执行放在 Bun 子进程：协议帧前缀 `\u001eRC\u001e` 与程序 stdout 分开；只有程序打印/返回进结果。
  子进程在临时目录里跑生成的程序，结束后删除。
- 嵌套调用桥回**同一张 AI SDK 工具表**（`src/session/tools.ts` 的 `dispatchRunCode`），因此
  `tool.execute.before` / `tool.use.pre` / explore capability / `ctx.ask` 权限 / truncate 全部照旧；
  程序拿到的只是 output 文本，失败转成 `ToolCallError` 供程序 try/catch。
- 禁止 `run_code` 自调用；单程序最多 64 次调度；整体硬截止 120s，`ctx.abort` 监听直接杀子进程。
- 三处硬上限：SDK 24,000 字符（超出只列 id，工具仍可调）、程序输出 64KB、stderr 8KB。

## 安全边界

这**不是沙箱**。子进程拥有当前用户的文件权限，能读写的东西与 bash 工具同级；模型写的代码可以
做任何 bash 能做的事。因此默认关闭，且由用户显式开启。编译版 RedCode 不是 Bun，子进程需要
PATH 上有 `bun`；找不到时工具返回明确错误而不是静默失败。

## 已知限制

- 程序不能 `import`；要读文件用 `tools.read`，要跑命令用 `tools.bash`。
- 嵌套调用不会在会话里生成独立的工具行：只有外层 `run_code` 一行，加上日志里的调度帧。
  权限询问仍会正常弹出（挂在父调用的 messageID 下）。
- SDK 的类型只是提示，不参与校验；真实参数仍是 JSON 对象，由各工具自己的 schema 校验。
- 只有 `native` 形态的模型才能用；本仓没有实现 Harness 那套 preset 级 native/ptc 切换。

## 验证

- `test/tool/run-code.test.ts`：SDK 声明（排序、必需/可选、枚举、数组、`$ref` 退化、字节上限）、
  真实子进程执行（两次派发且只回传 curated output、中间大结果不进结果、工具失败转 ToolCallError、
  程序抛错与语法错误、abort 杀进程），10 pass。
- `test/tool/registry.test.ts`：默认隐藏 `run_code`；开启后描述里带 SDK 且不含自身绑定，2 pass。
- `test/tool/capability.test.ts` 7 pass；`bun run typecheck` 通过。

模型可见四问：

1. **变了什么**：开关关闭时零变化；开启时工具表多一个 `run_code`，其 description 追加生成的 SDK 文本。
2. **token 影响**：SDK 有 24,000 字符硬顶；开启后大致相当于把可见工具 schema 再呈现一遍（加两个参数项）。
3. **KV cache 影响**：切换开关会让工具表及其后的前缀作废；同一开关下，可见集合（权限/模型/插件）变化
   同样从该段起作废。默认关闭，现有会话不受影响。
4. **注入上限**：SDK 24,000 字符、程序输出 64KB、调度 64 次、stderr 8KB——全部有硬顶，没有无界注入。
