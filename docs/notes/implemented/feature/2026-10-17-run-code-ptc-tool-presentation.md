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

- 新增工具 `run_code`，**默认不注册**：仅 `REDCODE_EXPERIMENTAL_RUN_CODE=1` 才进工具表，
  `REDCODE_EXPERIMENTAL=1` 不再隐式开启此执行面。关闭时工具表、固定前缀、KV 缓存布局全部零变化。
- SDK 由**本次请求真正可见的工具集合**生成（已过 agent 权限、model tools 开关、插件与 gate 过滤），
  所以模型不会看到调用不了的绑定。生成器按 id 排序：同一集合产出逐字节相同的声明。
- 执行放在 Bun 子进程：协议帧前缀 `\u001eRC\u001e` 与程序 stdout 分开；只有程序打印/返回进结果。
  子进程在临时目录里跑生成的程序，结束后删除。
- 嵌套调用桥回**同一张 AI SDK 工具表**（`src/session/tools.ts` 的 `dispatchRunCode`），因此
  `tool.execute.before` / `tool.use.pre` / explore capability / `ctx.ask` 权限 / truncate 全部照旧；
  程序拿到的只是 output 文本，失败转成 `ToolCallError` 供程序 try/catch。
- 禁止 `run_code` 自调用；单程序最多 64 次调度；整体硬截止 120s，`ctx.abort` 监听直接杀子进程。
- SDK 整体（含代码围栏和省略说明）不超过 24,000 UTF-8 字节；程序输出整体不超过 64 KiB，
  错误、超时、截断说明也占此预算。单个 stdout 协议帧与宿主 stdin 回包不超过 1 MiB；
  不带换行的 stdout 也有界，控制帧超限明确失败而不是截断 JSON 后继续执行。

## 安全边界

这**不是沙箱**。子进程拥有当前用户的文件权限，能读写的东西与 bash 工具同级；模型写的代码可以
做任何 bash 能做的事。因此默认关闭，且由用户显式开启。编译版 RedCode 不是 Bun，子进程需要
PATH 上有 `bun`；找不到时工具返回明确错误而不是静默失败。

## 已知限制

- 工具描述要求通过 `tools` 调用，不把“No imports”当成安全隔离：Bun 子进程仍可直接访问运行时能力。
- 嵌套调用不会在会话里生成独立的工具行：只有外层 `run_code` 一行，加上日志里的调度帧。
  权限询问仍会正常弹出（挂在父调用的 messageID 下）。
- SDK 的类型只是提示，不参与校验；真实参数仍是 JSON 对象，由各工具自己的 schema 校验。
- 只有 `native` 形态的模型才能用；本仓没有实现 Harness 那套 preset 级 native/ptc 切换。

## 首次实现验证

- `test/tool/run-code.test.ts`：SDK 声明（排序、必需/可选、枚举、数组、`$ref` 退化、字节上限）、
  真实子进程执行（两次派发且只回传 curated output、中间大结果不进结果、工具失败转 ToolCallError、
  程序抛错与语法错误、abort 杀进程），10 pass。
- `test/tool/registry.test.ts`：默认隐藏 `run_code`；开启后描述里带 SDK 且不含自身绑定，2 pass。
- `test/tool/capability.test.ts` 7 pass；`bun run typecheck` 通过。

模型可见四问：

1. **变了什么**：开关关闭时零变化；开启时工具表多一个 `run_code`，其 description 追加生成的 SDK 文本。
2. **token 影响**：SDK 整体有 24,000 UTF-8 字节硬顶；开启后大致相当于把可见工具 schema 再呈现一遍（加两个参数项）。
3. **KV cache 影响**：切换开关会让工具表及其后的前缀作废；同一开关下，可见集合（权限/模型/插件）变化
   同样从该段起作废。默认关闭，现有会话不受影响。
4. **注入上限**：SDK 整体 24,000 UTF-8 字节、最终程序输出整体 64 KiB、调度 64 次、
   协议帧与宿主回包各 1 MiB；超限控制帧导致明确失败并终止直接子进程。

## 复审后的授权收紧

原实现与原决策都允许全局实验开关启用 `run_code`，不是实现偏离设计；但用户开启其它实验，
不应被视为同意新增当前用户权限的代码执行入口。因此改为专属 opt-in，专属开关为 false 时，
全局实验开关也不能将其开启。Explore 的默认工具过滤与执行期 capability 拒绝保持不变。

授权回归以隔离的 `ConfigProvider` 输入测试默认关闭、仅全局开启、全局开启加专属关闭、专属开启四态，
并检查开启实验后 Explore 仍不见 `run_code`、capability 层仍拒绝它。此前两条全局开关用例失败，
修复后这四态与三条 registry 边界共 7 项通过。

## 输出与协议边界

复审前用真实 `runProgram` 子进程复现：10 万字符 return 返回 100,000 字节，中文打印返回
90,000 字节，4 万字符 console 加 4 万字符 return 返回 80,002 字节，三者 `truncated` 都为 false。
根因是 console 按 UTF-16 字符裁切且漏报，return/error 绕过裁切，最终拼接没有统一预算。
统一按 UTF-8 裁切后，截断标记也占 64 KiB 输出预算，不靠上层工具截断掩盖本模块的错误标识。

stdout 在解帧前受字节上限约束，普通打印保留有界前缀，协议帧超限或畸形则失败并停止进程。
宿主回包同时限制单帧与管道积压，不能靠回写巨型工具结果绕过入站限制。1 MiB 是协议安全边界，
不是新的性能调节项；这仍不是 OS 沙箱，也不承诺终止模型自行创建的孙进程。

`blocked:true` 与普通 rejected Promise 都让程序收到 `ToolCallError`；合法输出里出现“denied”
不会被字符串匹配误判。预取消在创建临时目录或子进程前返回，创建期间的取消在异步边界再次检查。

模型可见四问补充：

1. **原文差异**：工具描述与参数 schema 不变；原先正常 resolve 的 blocked 调用改为
   `ToolCallError`，原 `[run_code output truncated at 65536 bytes]` 改为预算内的
   `[run_code output truncated]`，畸形/超限协议新增有界 `run_code protocol error: …`。
2. **token 影响**：没有新增固定提示段；默认关闭仍为零。开启且 SDK 未超预算时维持原声明，
   超预算时按真实字节省略声明，不能把减小字节数直接当成实测 token 收益。SDK 本身超过 1K token，
   本次不新增第二份声明。
3. **KV cache**：正常未超预算的 SDK 与工具描述不变；超预算工具集合的 SDK 变化从该工具段起重建。
   仅开全局实验而没有专属授权的会话会移除工具，工具表及其后前缀因此改变一次；不改逐轮缓存机制。
4. **硬上限**：沿用上述 UTF-8 总预算与协议限额。截断/诊断文本不在总预算之外追加，
   子进程中间结果仍不回灌模型；不宣称 PTC 已有性能收益。

复审后验证：

- `run-code.test.ts` 新增回归首轮 12 pass / 5 fail；补齐协议、stderr 和 SDK 临界后，
  23 pass / 0 fail、103 assertions。真实子进程覆盖超长 console/return/error、混合与中文/emoji、
  跨 chunk、坏 JSON/非对象帧、超大帧/回包/积压、终止帧后不再派发、blocked 与预取消。
- 坏帧与超限用例核对本次程序文件和临时目录已经删除；不把 finally 代码存在当作清理实测。
- 主线合跑 `run-code`、`registry`、原有 `soul` 三个测试文件：60 pass / 0 fail，216 assertions。
- 独立终审无重大残余；极端 stderr 先输出超过 8 KiB 空白再输出有用错误时，前缀可能被判作空，
  导致缺少该 stderr 的截断提示。此诊断边界未在本轮继续扩展，不影响总字节上限。

## 261018 只读姿态准入（第三方审计 RC-01）

审计指出 `run_code` 与 `edit` 的权限不等价：程序内可直接调 `Bun.write` / `fs` 落盘，
不经过 `edit` 的授权链，而 `edit` 全 deny 正是只读姿态表达「不改文件」的唯一方式。
与 `bash` 的差别也在这里——shell 的破坏性命令有 `destructive` 检查兜着，程序内的写盘
没有任何信号。

结论与落实：

- **explore 早已安全**：`definition/explore.md` 的 `"*": deny` 白名单没有 `run_code`，
  既有测试 `keeps run_code unavailable to explore` 覆盖。
- **plan 与只读自定义角色此前不设防**：`plan` 只 deny `edit`，`run_code` 落在 defaults 的
  `"*": allow` 里。现在 `tool/registry.ts` 的工具过滤阶段加一条准入：
  `Permission.evaluate("edit", "*", agent.permission).action === "deny"` 时不暴露 `run_code`。
- **这不是沙箱**：它只保证受限角色看不到这个工具，程序本身仍以与 `shell` 相同的 OS 权限
  运行。工具描述里已如实写明「same file permissions as the shell tool」，不宣称只读隔离。
  要让受限角色真正安全地跑代码，需要 OS/容器级隔离，不在本轮范围。
- **回归**：`test/tool/registry.test.ts` 新增两条（plan 不可见、追加 edit 全 deny 后不可见），
  文件内 30 pass / 0 fail。

待办（本轮未做）：判断是否需要把 `bash` 的 `destructive` 检查同样套到程序内的写盘操作——
那属于执行环境设计，不是可见性守卫能解决的。
