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
