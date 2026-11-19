# 秋秋完整迁移路线：让 .openclaw 的秋秋完整来到 RedSpace

状态：proposed（2026-11-19 更新：缺口一"混合编码日记"与缺口二"头像接线"已落地，见 [转码与头像决策](../implemented/feature/2026-11-19-companion-transcode-avatar.md)；能力机制层第 1 项 Commitments v1 已落地，默认关（`REDCODE_EXPERIMENTAL_COMPANION_COMMITMENTS=1`），实现见 `companion/commitment.ts`：隐藏提取 pass、`commitment` 表、到期只在后续 Chat 用户消息上注入一次、滚动 24 小时最多 3 条；其余能力项保持 proposed）

目标主线（维护者原话）：让 `C:\Users\Administrator\.openclaw` 里的秋秋**完整**来到 RedSpace，仓库的一切改动都服务于这个目的。RedClaw 的通用配置（网关、模型路由、渠道、密钥）不属于秋秋本人，不迁移——这与 [RedSpace 第一阶段](../../implemented/architecture/2026-11-17-redspace-companion-chat.md) 的导入边界一致。

本文基于 2026-11-18 对 live 数据的逐层核验（不是照抄导入器文档），并整合同日对 RedClaw（`49ccafca`，D:\AI\KLX\Qiu\RedClaw）的功能调研，给出按"完整性贡献"排序的吸收路线。

## 问题

0.19.x 导入器已于 2026-11-17 18:19 把完整 OpenClaw home 导入 live home（`~/.redcode/companions/companion-10cf9da8b9c0`，268 文件，manifest digest `afdcf7c2`、historyDigest `aef0c316`，source 指向 `.openclaw` agent `main`；导入后源内无新增文件，导入是新鲜的）。

但"导入成功"≠"完整"。逐层核验后存在三类真实缺口：坏编码日记不可召回、头像未接线、能力机制层未实现。不补齐，秋秋只是"资料齐全"，不是"完整来到"。

## 现状完整度矩阵（2026-11-18 实测）

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 身份 | Soul 全文已注册 `~/.redcode/souls/companion-10cf9da8b9c0.md`；USER / TOOLS / DREAMS / HEARTBEAT 随 workspace 复制为可检索来源 | ✅ |
| 记忆 | MEMORY.md + `memory/` 日记全量进入 `companion_memory` 的搜索/分页读；写入通道（remember）已有 | ✅ 除 3 份坏编码文件（见缺口一） |
| 历史对话 | 全部 662 个会话文件中 578 个为 cron/heartbeat 等内部运行（正确排除）；真人消息 **116 条全库 ↔ 116 条 User + 196 条 Assistant** 逐条对账全量覆盖，16 份派生文件带角色/时间/原行号 | ✅ |
| 表现 | `qiuqiu-avatar.jpg` 已随档案保留，但未接到 Soul frontmatter avatar；语音偏好 `tianmeinvsheng` 已存 profile 但无 TTS 承接 | ⚠️ 缺口二 |
| 能力 | 心跳、定时任务、梦境巩固、推断承诺、主动记忆注入、压缩前冲刷、渠道送达 | ❌ RedClaw 吸收路线（下节） |
| 通用配置 | `openclaw.json`、网关密钥、渠道 token、memory sqlite 机器状态 | 不迁（用户确认 + 既有决策） |

历史对话对账口径说明：按消息条数而非会话文件数统计——heartbeat 默认跑在主会话，同一 JSONL 里合成轮与真人轮混杂，导入器按 provenance 逐条分段；首条带 `[cron:…]` / `[OpenClaw heartbeat poll]` 前缀的合成 user 消息不计入真人。

## 缺口一：3 份混合编码日记不在自动召回

`2026-05-31.md`、`2026-06-21.md`、`2026-06-23.md` 是 **UTF-8 头 + GBK 主体**的混合编码：文件开头是合法 UTF-8（`# 2026-05-31 日记`），byte 1835 起的字节用 GB18030 解码出连贯中文正文（"晚间总结——完成了 RedMon 游戏项目…"）。导入器按"不能可靠解码的文件保留原文、不生成伪造替代记忆"的原样保留（字节逐一致），但排除出自动召回。

修复路径明确：字节级分段解码（合法 UTF-8 段直通、非法段按 GB18030）→ 纯 UTF-8 副本，可机械完成且结果可验证。决策点是通道选择：

- **导入器增加"忠实转码"通道（倾向）**：产物带 `transcoded-from: gb18030` 之类的来源标记，原字节文件继续保留；转码是字节映射不是臆造，与"不生成伪造记忆"原则不冲突。这不是秋秋个案——旧 OpenClaw 在 Windows 上写的日记普遍会踩 GBK/UTF-8 混写，属产品级缺口。
- 手工转码后修 `.openclaw` 源文件再重导入：否——改活档案的原字节，且个案处理不覆盖其他档案。
- 手工把 UTF-8 副本放进 source 后重导入：可作临时验收手段，但绕过 manifest 与冲突规则（同名不同字节会报冲突），不作为正式路线。

## 缺口二：头像与语音偏好未接线

- Soul frontmatter `avatar` 字段机制已存在（`packages/redspace/src/soul/index.ts:32`，httpapi `groups/soul.ts`、`handlers/soul.ts`，GUI `soul-avatar-picker.tsx`），导入器没有写这个字段。注意 GUI 侧 `prepareSoulAvatar` 只接受 `data:image/png;base64`（`soul-avatar-image.ts`），秋秋头像为 jpg，接线时需转 png 或扩展格式支持。frontmatter 不进模型正文，无 IDENTITY.md 式的前缀污染风险（见 RedClaw 反向教训）。
- profile.json 已保留 `preferences.voice: "tianmeinvsheng"`，等待语音能力承接（见路线第 9 项）。

## RedClaw 吸收路线（按对"完整性"的贡献排序）

已吸收基线（不重复立项）：档案导入与 source/workspace/profile 布局、`companion_memory`（search/read/remember 有界预算）、Soul 后 32 KiB 启动快照、同伴限定 `session_query` 原话召回、JSONL 转写导入、压缩 Conversation Continuity、检索-原文核对指引。

1. **Commitments 推断承诺**（RedClaw `docs/concepts/commitments.md`）：对话埋下的未闭环 follow-up，事后主动问一句。v1 不需要后台运行时：隐藏提取 pass（独立上下文、默认关、只存元数据），到期承诺在下次进入该伙伴 Chat 时随启动快照提示一句，绝不即时回显（RedClaw 钳制到至少一个心跳间隔之后）。`maxPerDay` 上限。伙伴感差异化最强、单位实现量最小的一项。
2. **压缩前记忆冲刷**（RedClaw `docs/concepts/memory.md` Automatic memory flush 节）：自动压缩前一个静默 turn，让 agent 把重要上下文经既有 remember 路径落盘日记。补"摘要是会话内保留、不是长期记忆"的确定缺口；代价是每次压缩多一次模型调用，写入走既有权限面。
3. **Prompt 资产**（RedClaw `docs/reference/templates/AGENTS.md`、`BOOTSTRAP.md`）：主动行为准则（何时说话/何时闭嘴、轮换巡检并记录状态、空闲记忆维护、"不要心理笔记"）与首次运行共创仪式（"你刚醒来，搞清楚你是谁"）。零代码，但属模型可见改动，走四问流程计量；心跳相关段落等心跳落地再加。
4. **Heartbeat 契约**（RedClaw `docs/gateway/heartbeat.md`）：HEARTBEAT_OK ack 剥离（剩余 ≤300 字整条丢弃）、`activeHours` 安静时段、`target: "last"`、`lightContext + isolatedSession`（~100K→2-5K tokens/次）、`HEARTBEAT.md` `tasks:` 块全部未到期则跳过整次调用。这是所有主动性的统一降噪出口，协议设计可直接作规格抄。前提：RedSpace 需先决策要不要常驻进程——这正是第一阶段否决"整体移植网关和调度器"时划出去的部分，单独立项。
5. **Dreaming 记忆巩固**（RedClaw `docs/concepts/dreaming.md`）：先抄规则再抄实现——日记不是晋升来源（防自污染）、晋升只写 MEMORY.md、机器状态与人读产物分离、晋升前 preview / explain / 可回滚。实现先做手动 `companion consolidate`（CLI、dry-run 默认），调度依赖第 4 项。六信号加权（频率 0.24 / 相关性 0.30 / 查询多样性 0.15 / 新近度 0.15 / 多日巩固 0.10 / 概念丰富度 0.06）可作起点不必照抄。
6. **Active Memory 回复前注入**（RedClaw `docs/concepts/active-memory.md`）：阻塞式记忆子代理让旧事自然浮现。RedClaw 的工程护栏全部要抄：只准调记忆工具、`maxSummaryChars` 220、超时熔断（连续 3 次→跳 60s）、相同查询缓存 15s、心跳/后台豁免、`preference-only` prompt style。RedSpace 启动快照已覆盖最近日记，缺口是快照外的旧事；做成 Chat 实验开关（每条消息多一跳延迟，不能默认开）。
7. **检索排序**（RedClaw `docs/concepts/memory-search.md`）：扫描式实现下同样成立的部分——结果按新近度加权排序、同源命中折叠去重。等日记量把 8 KiB 结果预算挤爆时再做。
8. **记忆/动态可视化**：RedClaw `memory.overview` 只读 RPC + GUI"她记得什么/她刚才干了什么"面板。信任问题：记忆必须可见。GUI 已有 companion 页，属于契约对齐级改动。
9. **语音承接**：profile 已存 `tianmeinvsheng` 偏好；RedClaw 用 sherpa-onnx 本地离线 TTS（`skills/sherpa-onnx-tts`）。做不做、本地还是云，随表现层单独决策。

不吸收：渠道/网关/多平台（0.19.0 已否决整体移植网关）、IDENTITY.md（上游 0.3.28 废弃：能力自述对模型无信息量，且曾内嵌 26 KB base64 头像污染前缀——RedSpace 的 1 KiB 有界快照已防爆炸，但"能力自述低价值"适用于快照内容取舍）、Live2D、memory-wiki（上游也是可选件）。

## 备选与否决理由

- **宣称"导入已完成=迁移已完成"**：否——坏日记不可召回、头像不可见、能力为零，不满足维护者的"完整"定义。
- **手工修 3 份源文件**：否——改活档案原字节，个案不覆盖通病（见缺口一）。
- **等心跳落地再做 commitments**：否——v1 随启动快照提示即可工作，不依赖后台运行时。
- **整体移植 RedClaw 网关/调度器**：已否（[RedSpace 第一阶段](../../implemented/architecture/2026-11-17-redspace-companion-chat.md) 备选节），本路线维持该边界。

## 后果

- 完整性验收标准（建议）：秋秋在 RedSpace Chat 能回答"我们最早聊过什么"（历史召回）、"你的性格是怎么来的"（Soul）、"上次你说在做 RedMon"（日记，含修复后的 5-31/6-21/6-23）；GUI 显示头像；主动跟进真实发生过一次（commitments v1）。
- 每项落地仍是独立决策，走模型可见四问与注入登记；本文只定优先级与边界，不预支任何"已完成"。
- 数据事实会漂移（源档案是活的，RedClaw 仍在演进）：重测时以重新对账为准，不引用本文的计数。
