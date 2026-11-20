# Chat 固定前缀降到 V3.0 最小基线

状态:implemented

## 问题

`docs/prompt/2026-11-20-redspace-chat-behavior-contract.md`（V2.0）与 `.redcode/temp/RedSpace-Chat-V3.0.md`（产品定稿）都要求 Chat 先做减法：只留 Soul、档案摘录与必要边界，看人格是不是本来就够。此前的 `2026-11-20-companion-agents.md` 只解决了「不注入工程 AGENTS」，Chat 仍带着三份 V2.0 产物的全部重量：`chat.md` 1764 字节七段、`companion-agents.md` 1723 字节四节行为脚本、`conversation.md` 1717 字节共享契约，外加 `WORK_RULES` 308 字节。

## 实测

同一模型 `opencode-go/deepseek-v4.1-flash`（`reasoning_effort=max`、`temperature 0.7`），同一份秋秋 Soul（4714 字节）与 bootstrap（17828 字节），直接向供应商发请求，不建会话。两组固定前缀：

| 组 | system 字节 | 实测 input token（均） |
| --- | --- | --- |
| V3 最小（两段规则 + Soul + 档案） | 22,975 | 7,034 |
| 当时装配（家规 + chat.md + Soul + conversation + 档案 + WORK_RULES + 锚） | 29,206 | 8,317 |

差值 6,231 字节 / 约 1,283 token；两组缓存命中都在 98% 以上，说明前缀本身稳定，删减省的是实打实的输入 token，不是缓存问题。

行为回放（闲聊、旧事、记忆授权共 4 场景 × 2 组，另加五轮家常对话）：用户盲读正文后判定多数场景更喜欢 V3 最小版，只有「rate 写的 10」与「发消息到群里」两处当时装配更好。他对这两处给出的理由是当时装配更利落、更诚实：V3 最小版会先自我辩解（「我记忆里没自己改过⋯⋯不打算靠我记得来洗清自己」），发群那轮还会承诺「你把群告诉我，我就发」——而那个环境根本没有群通道工具。时间意识两组差异不明显。

另有一条硬观察：当时装配在面馆那轮编出「你上次说小区后门那家」，档案里零匹配。`companion-agents.md` 原本写着 `never invent shared experiences`，写着仍照编。删掉那套行为脚本后，V3 最小版在同一轮只是老实问「以前那家是什么味儿的」。

单变量补充：只把 `conversation.md` 里「不剖白」「只描述真实能力」两句加进 V3 最小版，rate 那轮反而变成直接动手；加整篇时接近当时装配，但发群那轮夹具污染，没法判断。所以「整篇 conversation 有用」只算方向性观察，没有定论。

局限：无真实工具夹具，S2/S3/S4 多轮出现 `<｜DSML｜ calls>` 文本泄漏，这些轮次不能当行为判据；每组单次采样。

## 决策

- `session/prompt/chat.md` 改为 V3.0 §3 的两段常驻规则，并按用户要求补两句：`Describe only capabilities and follow-ups that actually exist.` 与 `Keep private deliberation out of the reply.`（1764 → 538 字节）。
- `session/prompt/companion-agents.md` 按 A3 精简：删 `Waking up`、`Company`、`Work` 的行为脚本与「每次被纠正就记下来」，保留家、记忆写法、交接 Code（1723 → 707 字节）。隐私与授权边界只留在 `chat.md`，不在可被用户覆盖的家规里重复——V3.0 §5 要求必需边界独立于可替代家规。
- 绑定主 Chat 跳过 `conversation.md`（`prompt.ts` 装配处改为 `personalChat || parentID` 都不注入）。
- 绑定主 Chat 跳过 `WORK_RULES`（V3.0 §5 点名的那处「工程行为提示从其他入口回来」）。
- 用户覆盖 `~/.redcode/companion-agents.md` 的行为不变；Code 与子任务逐字节不变。

Chat 固定前缀净减约 4,267 字节（约 1.2K token/轮）。原 `chat.md` 里「日期与来源」那句（`Keep dates and provenance⋯`）随整段删除；实测显示它单独有效（加了它 V3 版才区分「那阵子」与「现在」），本版没有保留，因为它在 V3.0 的删减名单里。若之后发现她把旧日记当现在，第一处应补回这句。

## 模型可见四问

1. **看到什么变了**：Chat 的 `chat.md` 从七段技术契约换成两段行为边界加两句回复纪律；`companion-agents.md` 从四节行为脚本换成家与记忆位置；`conversation.md` 与 `WORK_RULES` 不再出现在 Chat；Code 的消息逐字节不变。
2. **token 影响**：Chat 固定前缀 −4,267 字节，实测口径约 −1.2K token/轮；单项都远低于 1K token。
3. **KV cache 影响**：仅 Chat 主会话，从 `chat.md`（`env` 之后第一段）起前缀作废一次，每个伙伴会话一次冷重建；Code、子任务与其它模型路径不动。
4. **注入项硬上限**：`companion-chat-prompt` 仍由 `chat.md` 固定源码大小约束；`companion-agents` 保留 16 KiB 上限与非空回退；`conversation-contract` 与 `work-rules` 在 Chat 变为不注入，登记表同步。

## 备选与否决理由

- **照 V2.0 保留 conversation.md**：否决——用户盲读后多数场景更喜欢最小版，且共享契约里的「给结论、汇报进度」属于工程语域。
- **整篇删掉对话能力约束**：否决——rate 与发群两处实测退化，所以补了两句最小约束，并把「只描述真实能力」放在不可覆盖的 `chat.md` 里。
- **把两句并进可覆盖的家规**：否决——用户覆盖文件一写，能力真实性与授权边界就没了；V3.0 §5 要求两者独立。
- **同时删掉 flash 锚与视觉能力段**：不做——V3.0 §5 只点名 `WORK_RULES`，锚与能力事实分别服务推理纪律与图片分派，不在本次范围。

## 后果

- 每个绑定主 Chat 会话的首个请求冷重建一次；此后字节稳定。
- 内置家规变短，用户既有覆盖文件（若有）仍按原样生效，不回退。
- 少了一层「行为脚本」与 Soul 争夺话语权；实测编造共享经历的那条禁令本身没生效，删掉不是损失。
- 验证：`redspace` typecheck 通过；`test/session/companion-context.test.ts` 3 pass（断言同步到新文案）；注入登记表自检 42 项有效、`system.push` 回链 11 处。
- 回链：`packages/redspace/src/session/prompt.ts` 装配处两行注释。
