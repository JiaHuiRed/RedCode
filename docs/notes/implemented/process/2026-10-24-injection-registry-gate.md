# 注入登记表：模型可见四问的机器门禁

- 日期：2026-10-24
- 状态：已实施（`docs/injection-registry.jsonc`、`script/check-injection-registry.ts`、`.husky/{pre-commit,commit-msg}`）
- 背景：ZCode 学习批的结论之一——同样「注入位置要管好」，ZCode 做成类型系统（编译期），
  RedCode 是提交纪律（模型可见四问，靠 review 执行）。按仓库红线「3 次以上必须机器门禁」
  的标准，四问本身就是欠账。本批把纪律的**可机检部分**升级为门禁。

## 机制

登记表 `docs/injection-registry.jsonc`，每个进入模型上下文的注入项一行（本批 24 项：
prompt.ts 的 11 个 system.push、6 个组装源、7 个输出侧/回放面）。三个不变量：

1. **锚点有效**：每行 `match` 必须仍能在 `file` 里找到。注入代码被改名/搬移/删除而登记表
   没跟上 → pre-commit 红。「误配置要响」落在注入面上。
2. **回链双向一一**：prompt.ts 每个 `system.push(...)` 上方 3 行内必须有
   `// injection-registry: <id>` 注释，与登记表 `push: true` 行互为镜像——新增注入忘了
   登记，push 那行就被拦（负测试实证：摘掉一条回链 → 2 个问题报出、exit 1）。
3. **上限必须声明**：cap 为具体字节数或 `bounded-by:<机制名>`（如 instruction_budget、
   MAX_SOUL_PROMPT_BYTES、check:tool-description-budget）。「没有上限就是缺陷不是待办」
   从红线变成断言。诚实申报的宽上限也入账（如 active-goal 的 goal 文本、mcp-guide）。

另有 commit-msg 门禁：staged 触及登记文件时，commit message 必须含「四问」——机器拦
「忘了问」，语义半（改了什么/token 增减/KV cache 影响）仍靠人答。

## 范围与已知边界

- 只守卫 `system.push` 这一个 API 面；组装源（env/skills/instructions/soul）靠锚点行，
  新增组装数组组件**不会被自动发现**（无 API 可 grep）——发现即补行的责任在 review。
- `appendNotice`（5 个调用点）登记为单行（helper 定义锚点），未逐调用点回链。
- 工具描述的上限由既有 `check:tool-description-budget` 承担，登记表只引用不重复。
- 运行时的字节级验证仍由 `session/prefix-shape.ts` 承担——本表是静态账本，两者互补。

## 模型可见四问（本批自身）

回链注释与登记表均为代码侧资产，不进模型上下文；①注入内容零变化 ②固定前缀零增减
③KV cache 不动 ④无新增注入项。

## 同批：gui-regression skill

GUI 驱动未引入新 MCP——审计发现 webqa（本仓 `webqa-server/`，Playwright headless）已具备
全部驱动原语（含 `eval` = page.evaluate，IME 组合事件与 pointer 序列靠它派发）。新增
`seed/skill/gui-regression`：起栈一条命令（`packages/app` `bun run dev` = 引擎 4097 +
vite 5173），五件套（长会话切换/连续流式/IME 组合输入/历史分页/面板拖拽）逐件给出
webqa 操作序列与通过判定，附加键盘方向/命令面板/思考块三个回归锚场景。已装至本机
`~/.redcode/skill/gui-regression/`。**有效性未实测**——首次真实使用（下一个 GUI 批次
收尾）时验证操作序列与选择器是否成立，尤其 `[data-component='chat-input']` 这类选择器
需以实际 DOM 为准修正。

## 回链

- 登记表：`docs/injection-registry.jsonc`（头部注释）
- 脚本：`script/check-injection-registry.ts`（头部注释）
- 钩子：`.husky/pre-commit`、`.husky/commit-msg`
- skill：`seed/skill/gui-regression/SKILL.md`
