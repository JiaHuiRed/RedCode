# 换 step-5-preview 后思考链变正文 + `[Historical context summary: msg_…]` 后缀复发

状态:implemented（261024）

## 现象

会话 `ses_ffe5e979c3fdeffexi5qXhIRFHvQeM`（RedMon 项目，切到 stepfun-step-plan/step-5-preview 之后）：

1. 助手正文里混入整段推理式文字，收尾带字面 `</think>`——思考链以正文形态渲染。
2. 多条回复尾部出现 `[Historical context summary: msg_…]` 后缀（此前 261014 修过 `[History reference: msg_…]` 形状的同类泄露，c3bfebfa）。

## 取证（redcode.db part 表；注意会话活跃、压缩会中途重写 part，查询要快照思维）

- 泄露 text part（prt_001a16c0731cd001，792 字符）：
  `[推理式 prose（无开标签）] + "</think>" + [正文] + "[Historical context summary: msg_…]"`。
  全串**不含 `<think>` 开标签**；该会话另有 572 个正常 reasoning part（中文推理，
  经 `reasoning_content` 通道进入，openai-chat.ts:332 映射）。
- 引擎全链路**不存在** content 通道的内联 think 解析：AI SDK 7.0.93 的
  openai-compatible 只认 `reasoning_content`（0 处 `<think>` 引用）；
  packages/llm 协议层同；引擎唯一的 think 处理在标题生成（prompt.ts 的整块剥离）。
- stepfun-step-plan 目录元数据：`reasoning_options: [{type:"effort", values:[low,medium,high]}]`
  ——effort 型，正常推理走 reasoning_content；内联 think 块是模型/模板层的另一条产出路径
  （interleaved thinking 风格，token 表里 `</think>` 是可生成 token）。
- 标记模仿的来源：context-compaction.ts:86-87 的块渲染头
  `[Historical context summary. …]` + `[block:…; sources: msg_a .. msg_b]`——
  模型把两者压缩成 `[Historical context summary: msg_…]` 拼在回复尾部。
  **上下文里从不出现这个冒号+单 ID 的混合形**，命中即模仿。
- 直接探针 step API 未做：鉴权走 coding-plan OAuth，不在 auth.json（证据边界：
  serving 侧「reasoning 走哪条通道、开标签去哪了」无法逐 delta 确认，修复不依赖该结论）。

## 根因

1. **内联 think 块**：step-5-preview 会把推理以 `<think>…</think>` 内联在 content 通道
   输出；引擎流式路径没有任何拆分逻辑，整段（含字面闭标签）漏进正文。与模型切换有关
   （GLM 系不这样吐），也与该 turn 是否走内联通道有关——所以「换了模型之后出现」。
2. **标记模仿**：与 261014 同病（模型把「给它看的」当「要输出的」），但形状是
   压缩块头的新混合形——c3bfebfa 的锚点表只有 `[History reference: `，罩不住。

## 修复

- **think 拆分**（`src/session/llm/think-split.ts` + ai-sdk.ts 接线）：
  `ThinkTagScanner` 把 content 增量流拆成 text/reasoning 两路——开标签后进推理路
  （合成 reasoning part，与原生 reasoning_content 通道独立 id）、闭标签回文本路、
  孤立闭标签只丢标签、悬挂标签前缀（≤7 字符）扣到下一段再判；text-end/finish 放行
  尾窗，未闭合的内联推理块在 finish 补 reasoningEnd 收口；状态不跨 step。
  模型不吐 think 标签时除 ≤7 字符延迟外零影响。
- **标记模仿**（instruction-echo.ts 三处）：LEAK_ANCHORS 加 `"[Historical context summary"`、
  OWN_BLOCKS 加 `native-compaction-summary` 剥离正则、detect 快路径加 includes——
  261014 的流式纠偏机制（按锚点截断+暂扣到 `]`）原样接管新形状。
- 不动 context-compaction 的标记本体（provenance 是 context_read 的回读依据）；
  已落库的历史消息不在本批清洗。

## 验证

- think-split 8 条单测（整块/跨增量/孤立闭标签/悬挂尾窗/flush 路由）+
  instruction-echo 新增 3 条（模仿形剥离、无标记形状不误切、流式截断放行）——51/51 过。
- opencode typecheck 绿。
- test/session/ 全目录既有失败 4 条（llm.stream ×2、llm native recorded ×2，录制夹具/
  环境相关）**带不带本批改动失败集合完全一致**（stash 前后各跑一遍对比），非本批引入。
- 真实 step-5-preview 流的端到端未跑（模型会话在用户机器上），等 GUI 实测：
  新回复的思考应进思考块、正文无 `</think>`、尾部无 summary 标记。

## 模型可见四问

① 不改任何注入文本（压缩标记本体保留）；② 固定前缀零增减；③ KV cache 不动；
④ 无新增注入项——两处修复都是输出侧的通道分流/剥离。

## 261027：整块摘要复述绕过标题剥离

### 现场与根因

`ses_ffe5e98162189ffeveIBJdWTYx07b1`（0.13.1 exe、Step 5 Preview）：

- 本地时间 08:41:46 手动原生压缩开始，08:42:50 提交成功；压前最后主请求
  358,516 tokens，压后首个主请求 141,078 tokens，耗时 63.4 秒。
- 08:43:17 的普通助手消息 `msg_001a17acfbf8f001F5tG6w9PJCUZU5`
  没有 `summary=true`，最终 `finish=stop`、无工具调用；可见 text part 留下
  `[block:…]`、Goal/Relevant Files 和 `Original user text / assistant text / tool output`。
  该 UUID 不存在于 `context_compaction_block`，来源 ID 也有错配：是模型模仿渲染格式，
  不是第二次原生压缩或真实账本块被 UI 展开。
- 同轮 08:43:20 已记录 `leak.dcp-reminder textLen=0`。扫描器命中了摘要标题，
  但 `releaseLeakHold` 只丢到第一个 `]`；标题闭合后，块正文被重新当成正常文字放行。
  `[block:` 与 `Original …` 不是旧锚点，text-end 也未剥离。循环因此看到了非空回答，
  没走空回复重试，08:43:57 正常退出；08:44:49 发“继续吧”后恢复。

### 实现与取舍

- 点号长标题 `[Historical context summary.`、`[block:` 以及现场三种
  `Original …; source:` 头均属于摘要正文回声；从首次命中处丢到当前 text part 结束。
  一次性 `detect` 同样剥掉整段尾部，保留之前的正常回答。
- 流式丢弃态仅保存一个常量锚点；后续 delta 直接跳过，不把整段摘要积进暂扣缓冲。
  下一个 text-start 按原逻辑复位，不中断流，也不吞紧随的工具调用。
- 短标记 `[History reference: …]` 和冒号短模仿形仍按 `]` 放行后续正文。
  不以普通 Goal/Relevant Files 标题判泄露，不改真实摘要的渲染或 provenance 格式。
- 全空的普通回复由既有 `prompt.ts` 空回复分支重试一次，不新增重试计数或压缩机制。
  同一 text part 在整块摘要后另附的正文也会被丢弃：没有可靠结束边界，不能再次靠
  第一个方括号猜结束；新的 text part 则正常保留。
- 261027 复检：行内代码中引用短标记时，合法回答被截断，现场连续发生两次。
  流式与收尾检测现在跳过 Markdown 行内代码和代码围栏；短摘要记录需带完整来源头
  才判泄漏，普通占位示例不会触发。摘要标题与完整来源记录仍按原策略拦截，尾窗固定
  为 512 字符，不缓存整段正文。无引号的完整真实来源头与回声无法可靠区分，仍可能
  误截；结构不完整的孤立来源头则可能漏拦，不能声称已消除所有歧义。
- 不改历史数据、不清洗隔壁会话、不改原生压缩账本；旧 exe 必须重编才包含此修复。

### 验证与四问

- 先加现场形回归：旧实现 5 条失败；修复后 instruction-echo 与 processor-effect
  两个文件共 72 pass。另增真实 `SessionPrompt` 循环回放，摘要空回复后恰好重试一次，
  返回正常回答，共两次模型请求、零 compaction part；该用例 1 pass。
- 整包类型检查暂未运行：验证期间可用内存约 1.1–3.8GB，低于本机既有编译器回退的
  安全余量，不与活跃会话争抢内存。真实 Step 的复述属于概率性输出；本次用确定性
  SSE 回放验证处理与续跑，不宣称能令供应商永不生成这种内容。
- 四问：①模型输入、摘要标记与工具定义不变，仅修正助手输出侧丢弃范围；
  ②固定前缀增减 0；③不改 KV cache 前缀，后续回放不再纳入被拦截的伪回答；
  ④无新增注入项，流式丢弃态为固定长度常量，恢复提示仍用既有有界文案。

### 261027：来源头跨增量时先发布

- 完整来源头命中前，旧实现已把 `[block:test-block; ` 通过 PartDelta 发出；后续整条
  part 纠偏不能撤回已发布事件。事件级回归在修复前失败，并不代表完整摘要已经泄露。
- 发布前暂扣候选摘要头，最多保留 511 字符；确认命中后丢弃，普通示例或未完成的
  候选在正常结束及中断收尾时放行。代码引用继续遮蔽，同一 part 命中摘要后仍丢弃
  后续正文；超出既有扫描窗口的候选不保证拦截。
- 两个相关测试文件共 78 pass；覆盖跨分块、普通示例、短标记、超长候选和中断收尾。
  无模型输入、固定前缀或 KV cache 改动，也无新增注入项。
