# 主会话共享相处契约，压缩同时保留互动连续性

状态：implemented

后续 [Code 提示词与记忆职责收敛](2026-11-17-code-prompt-voice-ownership.md) 精简 Conversation，并修正工程记忆的统一指令标签；下文 token 数为本次初版测量。

## 问题与范围

维护者在新 Soul、新会话中仍观察到长任务逐渐退回通用工作汇报；不同 Soul 程度不同。
不把旧会话版本冻结当作该现象的解释，也不据源码断定某一模型的漂移根因。

基于 `73c9f1d` 核对到三个可直接修改的结构缺口：

- `default.md` 拥有 Conversation 段，独立模型提示词、定制 agent prompt 和 Chat 不一定经过它。
- 原生与传统压缩的共同模板只明确保留任务、进度和技术上下文；没有互动连续性的位置。
- Chat 基础提示词无条件描述 `companion_memory`，而工具实际可用性由注册表与权限控制。

本批统一能力归属，不修改私有 Soul 内容，不合并人格、个人档案或会话绑定。

## 决策

1. 将原 Conversation 段移入 `session/prompt/conversation.md`，由主会话在 Soul 后装配一次。
   Chat、Code、模型家族与定制 agent prompt 共用；子任务不增加面向用户的相处要求。
   工程事实、工具权限、工作交付要求仍由原拥有方负责。
2. 补明确的持续表达范围：工具结果后的回复、重试、纠错与完成都保留当前 Soul 的关系语气。
   自然反应可以值得花字数；不用开场问候代替全程相处，不规定昵称次数或表演动作。
   对别的伙伴经历的了解与自己的经历区分，称呼和关系距离始终取绑定 Soul。
3. 原生与传统摘要共用的模板增加 `Conversation Continuity`：保留相关共同经历、用户明确
   表达的感受或偏好、未完话题和承诺，并记录来源、归属与后续更正。没有则写 `(none)`。
   不复写 Soul 传记，不把梦境当实事、承诺当已执行或已排程；摘要不授予写个人档案的权限。
4. 将个人记忆的检索与写入指引放入工具自身描述。当前上下文不足以回答旧事时先检索，
   再读所需原文；已有路径直接读。记录共享经历不必满足“工程教训”条件，但保留原权限、
   选择性写入、来源和成功回执要求。Chat 基础段保留快照和历史证据语义。

借鉴来源为 RedClaw `49ccafcabfce4252eec93f6c67b2950cab096ede` 的
[能力条件下的检索—原文核对指引](https://github.com/JiaHuiRed/RedClaw/blob/49ccafcabfce4252eec93f6c67b2950cab096ede/extensions/memory-core/src/prompt-section.ts)
与 [Soul / 项目上下文装配](https://github.com/JiaHuiRed/RedClaw/blob/49ccafcabfce4252eec93f6c67b2950cab096ede/src/agents/system-prompt.ts)。
这里按 RedSpace 已有工具和会话机制重新实现，没有复制另一套执行器或宣称未实现的能力。

## 模型可见四问

1. **内容**：原 `default.md` 的 `# Conversation` 移到主会话 Soul 后并补持续表达与经历归属；
   原摘要 `single-sentence task summary` 改为任务或话题，新增互动连续性段；
   Chat 中无条件的工具指导移到实际暴露的 `companion_memory` 描述并补检索后核对原文。
2. **token**：以仓库 chars/4 口径粗估，非供应商 tokenizer 实测：
   - Conversation 固定 2,526 bytes，约 630 tokens。
   - default 9,947 → 8,286 bytes；经过 default 的 Code 主会话合计净增约 216 tokens。
   - 独立模型提示词或定制 agent 的 Code 主会话新增约 630 tokens。
   - Chat base 1,941 → 914 bytes，加共享段后净增约 373 tokens；若记忆工具可用，描述
     714 → 1,569 bytes，另增约 214 tokens，合计约 587 tokens。
   - 经 default 的子任务不加共享段，减少约 414 tokens。
   - 摘要模板 1,823 → 2,563 bytes，约 +185 tokens，仅摘要请求；专用摘要 agent 约 +1 token。
3. **KV cache**：default 家族最早从移除 Conversation 处重建；Chat 从其基础提示词变化处
   重建；其他主会话从 Soul 后新增段重建。工具描述改变还会影响工具区，具体序列化顺序取决于
   provider。属于版本部署的一次性变化。运行中共享段固定，不按轮次追加、不重写旧消息，
   不增加额外模型调用；记忆工具结果继续追加在历史尾部，不热改系统快照。
4. **硬上限**：新增契约和工具描述都是固定源码，单项均低于 1K 估算 tokens；工具描述纳入
   既有 32 KiB 总预算（本批 27,845 bytes）。摘要总输出上限、Soul 的 16 KiB、bootstrap
   的 32 KiB 以及 search/read/remember 上限均不变。default 全文件仍超过 1K tokens，
   保留的是原有工程契约，本批净缩短。登记表同时修正目录迁移遗留的 opencode 路径。

## 验证与边界

- 真正经过 SessionPrompt 和本地 provider 的请求：Chat 与 Code 都恰有一份共享契约；
  search → read → remember 工具循环中 system 和工具定义逐字一致；写入后新 Chat 能召回。
- Code 保留自己的 Soul 和工程记忆，不带另一个伙伴的个人历史或记忆工具；子任务保留绑定
  Soul，但不带主会话相处契约。原生与传统压缩均收到新模板并保存对应摘要；缓存前缀复用
  和超预算降级两条原生路径也覆盖。
- 验证使用隔离的本地 provider / 固定返回夹具，不等于真实模型长任务人格改善验收。
  不使用昵称计数作为真实感指标，不宣称本批已经解决所有漂移或完成 RedClaw 的完整迁入。
  主动活动、梦境整理、到期跟进和 Code 个人记忆归属仍需各自运行时实现与验收。
