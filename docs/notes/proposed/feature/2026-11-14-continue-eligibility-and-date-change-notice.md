# 续写资格写时固化 + 跨天日期变更带内注入

状态:proposed(决策 A 的资格判定已于 2026-11-14 以读时纯函数形态实现,
决策 B 已实现;两者实现记录见文末,note 随续写动作/后续演进整体移入
implemented/)

两个独立的小决策合写一文,共同主题:**把"时间/资格"这类易变事实固化成
稳定的带内信号**。均立项自 DeepSeek chat-demo 调研(2026-11-14,`reply.ts`
的 `prefix` 标记与 `latest_reminder` 机制)。

---

## 决策 A:续写(continue)资格写时固化

### 问题

输出被截断(`max_tokens`,消息落 `OutputLengthError`,`message-v2.ts:1680`)
后,用户没有任何"接着说"的手段,只能整轮重发重付费。若做 continue,核心
风险在资格判定:哪些截断回复能安全地作为 prefill 续写?若在点击时从消息
内容重推算,迁移过的、旧版本的、部件被清理过的历史无法保证满足重推算的
规则——和本仓"导入数据显式拒绝"红线同一类坑。

### 决策

> 2026-11-14 落地修正:字段形态改为**读时纯函数** `MessageV2.continuable()`,
> 理由见文末实现记录;本节保留原文以记录提案时的思路。

1. **assistant 消息流式结束时写一个持久化布尔 `continuable`**(message-v2
   schema 新字段):默认 false;置 true 当且仅当——finish 为 length/truncation
   或被用户 stop、消息内**不存在任何 tool part**、正文非空白、无 refusal/
   content-filter。**任何 tool part 出现即就地写 false**,此后不再变(对应
   demo `reply.ts:88` 的 `prefix: false` 就地降级)。
2. continue 动作只查这个字段,不重推算。点击后:重建上下文时把该截断
   assistant 作为**末尾 assistant prefill** 原样回传(思考块带签名回传,
   供服务端续解),不再附新的 user 消息。
3. 迁移/导入的历史一律 `continuable: false`(字段缺失即 false,schema 不给
   默认值诱导误判)。
4. 续写产物是同一条 assistant 消息的延伸还是新消息?取**新消息**,parent
   语义留给消息树分支 note(2026-11-14-message-tree-branching)落定后再定,
   避免先入为主锁死两功能的接口。

### 备选与否决理由

- **点击时从内容重推算资格**:否决——见问题段;旧数据不满足新规则时要么
  误判要么全部拒绝,字段缺失时连"当时为什么 false"都无从追问。
- **自动续跑(检测 length 自动续)**:否决——隐性改变成本上限语义,截断
  往往伴随上下文临界,自动续跑容易连环触发 overflow;续写必须是显式动作。
- **合成的 user "继续"消息代替 prefill**:否决作为主路径——污染历史语义
  (模型看到的是新指令而非续写),且后续每一轮都带着这条假 user。但它是
  **provider 兼容回退**:不支持 assistant prefill 的 provider(OpenAI 系)
  上,continue 退化为合成 user 轮,资格字段语义不变。

### 后果

- message-v2 schema 加字段 → OpenAPI/SDK 重生成 + drift 检查纪律。
- 服务端 route(continue)与 TUI/GUI 入口为独立后续项;本决策只固化
  schema 语义与资格规则,防止字段后补时历史数据无法回填。
- KV cache 影响:续写请求的历史前缀与上一请求完全一致,只在末尾追加
  prefill——天然缓存命中,无需额外处理。

---

## 决策 B:跨天日期变更带内注入

### 问题

每轮 system 尾部注入 `Today's date: X`(`prompt.ts:2126`,260718 决策,
缓存友好),但只告知"今天"。跨天 agent 会话(常态:长任务跑过零点)里,
模型对"前几轮发生在昨天"没有任何带内信号,涉及时间推理
("昨天那个方案"/"周五提的")时只能靠猜——消息部件的时间戳并不进模型
上下文。

chat-demo 的做法:日期快照存到每条回复上,重建上下文时**只在快照变化的
轮次边界**插入一条 `latest_reminder` 消息。变更才插入 = 平时零成本,
边界处模型获得完整的时间线感知。

### 决策

在 prompt 组装(`prompt.ts` 拼接模型消息处)按消息 `time.created` 的本地
日期检测轮次边界:相邻两轮(以上一条 user/assistant 消息的时间为界)本地
日期不同,则给后一轮 user 消息**头部插入一条 synthetic 文本部件**:

```text
[System: the local date changed from 2026-11-13 to 2026-11-14 since the previous turn]
```

- **派生不持久化**:边界检测是消息时间戳的纯函数,每次组装结果确定,不写
  库——重启、换机、重放结果一致。
- 格式与 system 尾部的 `toDateString()` 同源,避免两处日期口径漂移。
- 只标注变更点,不在每轮重复注入。

模型可见四问:
1. 看到什么变了:跨天会话中,日期变更点之后第一轮 user 消息头部多一行
   ~15 token 的 system 说明;未跨天的会话一个字节都不多。
2. token 影响:每次日期变更 1 行(≈15 token);上限 = 会话跨天数 − 1 条,
   无截断必要。
3. KV cache 影响:变更点首次出现时从该轮起前缀失效一次(新增字节),之后
   字节确定、重新稳定;未跨天零影响。
4. 上限:每会话 ≤ 跨天数,天然有界。

### 备选与否决理由

- **每轮都注入日期行**:否决——重复注入浪费 token,且与 system 尾部已有
  的当日日期重复;变更点注入是严格更优。
- **把时间戳塞进每条消息部件**:否决——每条消息都变,token 成本线性,
  且模型对裸时间戳的利用率低;只标变更点信息密度最高。
- **持久化 synthetic 部件**:否决——派生数据落库会引入"时间戳修正后部件
  不同步"的一致性问题,纯派生无此负担。

### 后果

- prompt 拼接路径改动,属模型可见改动:上线 commit 需按四问逐条作答
  (上文即答案)并跑 prefix-shape 对照。
- 部件 ID/顺序需在组装时保持稳定(按时间戳派生,不引入随机性),否则
  会反复打爆缓存——实现时用确定性序号。
- 服务的时区口径:沿用 `toDateString()` 的本地时区;服务器与用户同时区
  是既有前提,不新引入偏差。

---

## 实现记录(2026-11-14)

### 决策 A:形态修正——读时纯函数,不做 schema 字段

原文按 chat-demo 的思路要求"流式结束时写持久化布尔 continuable"。落地
调研推翻了字段形态,理由有三:

1. **前提变了**:调研发现 `llm.ts` 的 `withContinuation`(260803)已在
   LLM 层对 DeepSeek 家族做透明自动续写(限 2 轮、纯文本)。用户可见的
   截断只剩两类——非 DeepSeek 模型(完全无续写路径)与自动续写耗尽,均
   以 `finish="length"` 落库。资格判据(收尾形态、尾段部件、悬空工具)
   **全部来自已持久化状态**,不存在 chat-demo 那种"只有流式时刻知道"的
   事实(它的 prefix 标记本质是「服务端签名块不可重放 + 导入数据不可信」
   两条策略的 belt,RedCode 的 tool part 原生可重放,无此依赖)。
2. **落库点家族过大**:assistant 消息收尾点散布在 prompt.ts 至少 5 处
   (671/703/1831/2379/2472)+ processor 的 step-finish 路径,逐点写字段
   违反"数同形状兄弟"红线——漏一处就是静默 false,比没有字段更糟。
3. **纯函数可回填**:判据是持久化状态的纯函数,历史/迁移数据天然可判,
   "防止历史无法回填"的原始动机不再成立。

**落地形态**:`MessageV2.continuable(message)` 纯函数(message-v2.ts,
toModelMessagesEffect 前),三道门槛——finish="length" 或 AbortedError
(其他 error 一票否决);跳过尾部 step-finish 记账件后必须是非空、非
synthetic、非 ignored 的 text 部件(截断点在正文上);全消息无
pending/running 工具部件(截断点在工具声明上时 prefill 回传会违反
tool-call/result 配对协议)。缺失即 false 的导入语义由"字段不存在→判据
不满足"自然达成,无需特判。

**与原决策的差异**:原决策 4(续写产物取新消息、parent 语义留给分支
note)与 provider 回退路径(决策 4 的 OpenAI 系合成 user 轮)维持不变,
待续写动作立项时执行;资格判定本身已是现行决策。

验证:`test/session/message-v2.test.ts` 新增 `continuable` 用例 10 条
(纯文本截断、前置已完成工具不阻塞、用户中止、正常完成不续、悬空
pending/running 工具、reasoning 尾、synthetic 通知尾、纯记账件、空白尾),
93 pass / 0 fail;typecheck exit 0。

### 决策 B:跨天注入已实现

`MessageV2.toUIMessages`(message-v2.ts):`previousUserDate` 随遍历推进,
相邻两轮 user 消息本地日期(`toDateString`,与 prompt.ts date-per-turn
同源)不同时,在后一轮前插入合成 user 消息
`[date changed: the previous turn happened on X; it is now Y]`,置于既有
model-change 通知之前(先时间线后身份)。空轮(部件全被过滤)不占上下文
但**仍推进日期基准**——它确实发生过。纯派生自 time.created,不落库;
MessageID.ascending() 的 UIMessage id 不上线上(convertToModelMessages
剥 id),与 model-change 通知同一先例,缓存逐字节稳定。

估算路径口径:prompt.ts:2368 的尾部切片与 compaction 的摘要转换若从
切片中间起算,切片起点会少一条日期通知——它们只喂 token 估算/摘要,不
出站,15 token 级噪声可接受,已接受不消除。

验证:同文件新增用例 3 条(跨天注入、同日不注入、空轮推进基准;
本地构造日期取正午/23 时,不依赖机器时区),与 model-change 既有用例
同 fixture 体系,93 pass / 0 fail;typecheck exit 0。改动不进 OpenAPI
(纯转换层,无 schema 出口变化),无 drift 义务。
