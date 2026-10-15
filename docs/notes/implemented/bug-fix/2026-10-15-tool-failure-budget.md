# 重复失败工具调用的成本有界止损

状态:implemented

## 问题

261015 一个会话里 `task_status` 被连续错误调用 15 次：每次都是同一组参数
`{task_id, wait:false, timeout_ms:1000, cancel:false, message:""}`，触发
`Steering cannot be combined with wait, timeout_ms, or cancel`。会话库只读统计证实这是
15 条不同的 assistant message、15 个不同 callID——不是执行器重放，是模型每一轮都重新生成
同样的错误调用。账面累计 uncached input 46,631 + cached input 1,070,208 tokens（cost 字段为 0
不代表免费；reasoning 疑为 output 子集，未重复相加）。

当时的防护全都拦不住这件事：

- `repeat-tool-reminder` 软层阈值 3/5/8，只建议不拦截，而且只接在 **tool-result 成功**尾部，
  tool-error 路径根本没有提醒；超过 8 之后沉默。
- `processor.ts` 的 doom-loop 硬层阈值 3，触发的是 `Permission.Service.ask({permission:
  "doom_loop"})`——要用户确认后**继续执行**。日志显示当晚弹了 4 次（13:12:35、13:12:55、
  13:13:10、13:13:20），用户每次都点确认，循环原样继续。它是"问过再烧"，不是止损。
- 没有任何机制约束**模型请求次数**：工具可以不被执行、错误可以缓存，但只要 run loop 还在，
  下一轮就是一次全额请求。

诱因侧有两个真实缺陷：`task_status.ts:135` 用 `params.message !== undefined` 判空，
空串也进 steering 分支，于是和 wait/timeout/cancel 的互斥校验先炸；且出站 function tool 没有
显式 `strict`，Responses 服务端会尝试把 schema 归一成严格模式、可选参数可能变必填
（本地已验证 wire 缺 strict + 本地 optional schema；**未做耗费真实额度的服务端 A/B**，
所以只说"兼容风险已消除"，不说"已实测服务端转换"）。

## 决策

按「同工具 + 规范化参数 + 同一错误签名」在当前用户轮内记账，预算默认 2：

- 签名口径复用 `repeat-tool-reminder.inputKey`（深层 key-sort，数组顺序保留），
  工具名与参数一起哈希，错误文本单独哈希——同参不同错（如网络抖动）不计。
- 计数从持久化 tool part 读（`json_extract` 过滤 session/parentID/type/status/签名），
  跨 step、跨 assistant 消息有效；新用户消息换 parentID 自然重置。
- 第 2 次同样失败时，错误输出尾部附一次有界纠偏提醒（<1KiB），告诉模型错在哪、该怎么改参数。
- 第 3 次原样调用：session 工具执行入口的闸门直接返回
  `Repeated tool failure budget exhausted...`，**不执行工具**，同时把 handle 标记为
   stopped-by-tool-failure，run loop 收尾——不再发下一次模型请求。
- 预算耗尽后 doom-loop 弹窗路径也短路：不能再靠"确认"重开同一个死循环。
- 会话记录、后台任务全部保留；界面追加一条可见终态说明。
- 预算可配：`experimental.repeated_tool_failure_limit`，1–20，`resolve()` 默认 2，
  seed 模板与 live 配置同写 2。

同批修掉两个诱因：`task_status` 的互斥错误现在附带两种合法调用示例（并点明空串不等于省略）；
出站工具显式 `strict: false`——AI SDK 侧在 `session/tools.ts` 对内置/MCP/resource 三类
工具统一设置，native Responses 侧在 `packages/llm` 的 `lowerTool` 同样设置，两条 runtime 都覆盖，
不是只修 task_status 特例。

## 备选与否决理由

- **只缓存错误/禁止执行，不停 run loop**：否决——模型照样每轮发请求，烧的正是我们要省的钱。
- **注入伪 user 消息提醒**：否决——260810 DCP user 角色注入的教训，且破 append-only 前缀。
- **把 doom-loop 弹窗当硬止损**：否决——它语义就是"确认后继续"，当晚 4 次确认已经证明。
- **跨会话/全局计数**：否决——不同用户轮次做相似的事是合法的（轮询、批量重试），会误伤。
- **任何错误都累计（不看错误文本）**：否决——瞬时错误会把正常重试也判死；必须同错误签名。
- **把预算做成配置项可任意调大**：否决——上限 20 是 Schema 校验的安全边界，不是可调参数。

## 后果

- 实测请求次数（离线 LLM fixture，无真实额度）：默认预算下 3 次原样调用只产生 2 次执行 +
  2 次请求，第 3 次不执行、无第 4 次请求；插入 `todoread` 记账不洗计数；limit=1/3 线性成立；
  修正参数后正常继续；新用户轮次预算重置；同一并行批次的 3 个同参调用在批次内全部启动
  （拦不住已在途的），但该轮不再续跑。
- 计数查询有实测成本：512 条 16KiB 合成 tool part 的单轮里，中位 7.6ms、最大 19.8ms
  （`json_extract` 过滤 + max 聚合，不读 part 正文）。正常会话远小于此。
- 轮询不受影响：输出在变的调用错误签名不同；成功路径从不计数。
- 模型可见面：错误尾部多一段有界提醒（每次预算耗尽只出现一次）+ 一条终态说明；工具定义多一个
  `strict:false` 字段（约 3–4 tokens/工具，随工具表线性增长，属固定前缀增量，KV cache 从工具
  定义段起作废一次）。
- 未覆盖/待观察：服务端严格模式归一化只是本地 wire 级验证；云端 A/B 未做。执行器在
  schema 解码阶段就失败的调用（execute 从未被调）不走本闸门，由参数纠偏文案兜。
- 识别签名：日志 `tool.failure.budget`（WARN，带 tool/count/limit）；tool part metadata
  `failureGuard.{inputSignature,errorSignature,count,blocked}`。
