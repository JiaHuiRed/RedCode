# DSH 设计采纳路线图

> 2026-08-14 定向:主力模型即 DeepSeek,官方 harness([deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),本地镜像 `E:\AI\deepseek-harness`)与 V4 系列协同设计——模型的 agent 后训练对着它调,它的机制反过来兜模型短板(如长程早停)。RedCode 不迁移、继续独立演进,但系统性吸收其设计,保留自身特色。
>
> 本文件是采纳工作的权威底本(模式同 `tauri-migration-plan.md`),每项落地后更新状态;来源审计详情见 810f2dad 会话(2026-08-14 两轮)。

## 保留的特色(明确不搬)

- **毛玻璃/壁纸 GUI 视觉路线** —— DSH 是克制企业风(三层 token:static→alias→specific,dark 只翻 alias 层),流派不同;token 分层纪律可参考,视觉不搬。
- **中文优先体验与文档**。
- **多模型支持与按模型分档提示词** —— DSH 的两句话 persona(`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`)前提是只服务自家后训练模型;RedCode 面向多模型,`prompt/*.md` 分档是对的。
- **Effect 架构与 SQLite 消息存储** —— Cordis 全插件化 / 事件溯源是重写级,不动;吸收其"渲染时投影"等价技巧即可(head+tail 截断就是这么落的)。

## 已落地

| 项 | DSH 来源 | RedCode 落点 | 提交 |
|---|---|---|---|
| 重复调用递进提醒软层(3/5/8,tool output 尾部注入,todo 工具对链透明,与 doom_loop 硬层互补) | `guard/repeat-tool-reminder` | `session/repeat-tool-reminder.ts` + processor 接线 | 89e85f3 |
| 压缩摘要截断 head-only → head+tail 4:1(尾部错误栈/退出码保住) | `compaction/compaction-tool-result-pruner` | `message-v2.ts` `truncateToolOutput` | 17a7304a |
| 提示词减脂:机制落地后删对应规则条(不再占固定前缀) | "行为规范写代码不写提示词"哲学 | deepseek.md 删 re-fetching 条 | 89e85f3 |
| 测试纪律"证据面匹配 + 永不默认全量"入规 | 根 AGENTS.md "Run relevant checks locally" | AGENTS.md | 9981d03e |
| 决策记录制度(notes) | `.agents/notes/`(1369 篇,四态,同 PR 附 note) | `docs/notes/` | 9981d03e |
| timeout-policy(工具自声明 timeoutMs + wrap 层 cooperative 拦截,首个声明方 repo_clone) | `guard/timeout-policy` | `tool/tool.ts` TimeoutError | 16f606b2 |
| 插话/排队可选(`busy_enter`:steer=中途注入(原行为),queue=真排队;附 stall nudge 退役收敛三层空转提醒为两层) | `ui-input-trigger` 双模 | `config.ts` + `session/prompt.ts`,note ×2 | 0856fb9b |
| 工具输出截断 head-only → head+tail 4:1(尾部错误栈/测试结果保住;压缩摘要侧 17a7304a 已落,工具输出侧补齐) | `spill-policy` + `compaction-tool-result-pruner` | `tool/truncate.ts` 默认 both | 待 commit |

## 第二批(小机制,高性价比)

- [x] **goal 语义三件套**进子代理派活提示词/机制：blocked 必须同一阻塞条件持续 ≥N 轮才准标；"难/不确定/还有活"明文不算 blocked；resume/fork 后自动缴械、需用户明说才续跑。对冲 V4 长程早停。参考 `goal/goal` + `goal/tool-goal` guidance。
  - [x] 260817 ①+② 提示词落地：`session/prompt.ts` activeGoal 注入段加 Blocked rules（同一具体条件持续 ≥3 轮 + 说明具体条件；difficulty/uncertainty/remaining work 明文不算）；`tool/task.md` 加派活纪律第 7 条（子代理同规则）。note 见 `docs/notes/implemented/feature/2026-08-17-goal-semantics-three-piece.md`
  - [x] ③ resume 缴械：**天然覆盖无需做**——RedCode 会话推进靠用户输入（runtime.ts eagerStream 只是连接），resume 后用户不发消息就没有 idle 续跑事件；用户 resume 后第一条消息即 DSH 所说 "human asks to continue in any wording" 的隐式 rearm。无 fork（Pi 清单未实现）。
- [ ] **指令文件加载细节**:同目录 AGENTS.md/CLAUDE.md 内容去重(trim 后同文只渲染一次);变更/移除注入 "Updated/Removed instructions from";预算裁剪"先丢整个较宽文件再截最具体文件 + 可见通知"。参考 `context/agent-instructions`。
  - [x] 同目录去重：RedCode 本就 first-match-wins 不堆叠，天然规避（无需做）
  - [x] ~~预算裁剪~~：**260817 哥哥否决**——全局指令不长、缓存命中率稳定 97%+，无膨胀问题；截断丢规则的风险不值。现 64K 只告警不截断保持。
  - [ ] 变更/移除通知：~~260817 曾落地~~ **已回退（260818）**——每轮读盘对比 + system 尾注入通知会破坏前缀缓存（哥哥在家实测 19b2bed3 对命中率造成破坏性损伤）；需另想不破前缀的通知方式
- [ ] **翻 `dsh-trim-cot-leakage` skill**,对照 step-3.7 思维链泄漏三条防线补手法。

## 第三批(结构性)

- [ ] **动态上下文快照通道**:会变的内容不进 system prompt,走"supersedes 早先快照"的独立消息、只在变化时重发。先对照 prefix-debug.log 找该走此通道的断裂源。参考 `core/system-prompt` PromptContext + agent-loop runtime-context。
- [ ] **hooks 声明式 subprocess 层**:kimi-hooks 研究的未竟半边;DSH `hooks/hook-protocol` + `hooks-claude-code` 是现成参考(7 个 hook 点映射、fail-open 不崩 boot、CC hooks.json 直接兼容可白嫖生态)。
- [ ] **"Model Experience 三问"文档规矩**:凡改模型可见内容(提示词/注入/工具 schema),PR/commit 说明需回答 What the model sees / Token effect / KV Cache effect。
- [ ] **UI 交互三件**(TUI/GUI 通用):Think 行流式期"最新非空行"滚动 summary(展开即停跟随;与现有 reasoningTitle 粗体标题叠加,优先级:标题>最新行>时长);连续重试折叠为单行状态(倒计时锚定客户端接收时刻);压缩 checkpoint 原位折叠行、展开显示摘要与 token 估算。参考 `client/ui-conversation`。
- [ ] **busy_enter 的 UI 收尾**:~~TUI 斜杠~~(138aa422)、~~GUI 斜杠+设置面板下拉~~(本批,DSH 同款形态);剩 steer 模式"已送达"徽标(QUEUED → 送达,需 user 消息 schema 字段 + sync 推送 + 双端渲染)。
- [ ] **subagent-report 两档投递**:子代理回执 wakeup(唤醒父开新轮)/quiet(仅注入不触发请求)部署级策略,对照现有后台子代理通知机制。

## 记账(等痛点/等时机)

- [ ] **Code Mode**:工具集折叠为 `run_code` + 按 scope 确定性生成 TS/Python SDK(byte-identical 缓存友好),中间值不进上下文,子调用重入完整权限管线。MCP 工具定义成本的终极解法,实现重。参考 `core/tools` Code Mode + `code-runtime`。
- [ ] **workflow 工具**:模型写 JS 编排脚本 fan-out 子代理。参考 `workflow/tool-workflow`。
- [ ] **token-meter 式 projectedTokens**:provider usage 锚点 + 启发式只算增量,压缩落地立即反映下一请求成本。用量面板已有基础,等口径重构时对照。
- [ ] **压缩日志锁括号**:compaction start/end 括号日志,crash 留可检测孤儿锁而非假完成。对照现有 compact 实现评估。
- [ ] **文档预算/生成式 catalog 门禁**:单人仓文档量未到痛点,缓。
