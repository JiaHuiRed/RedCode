# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

0.3.0 起 TUI 与 GUI 独立维护版本号，各自独立记录。0.3.0 及之前为共同历史。

---

## TUI

### [0.6.4] - 2026-06-15

> MCP 生态扩充 — 进程管理 + SQLite 查询两个本地插件，配套工具优先级引导。

#### 新增

- **`mcp-process-mgmt` MCP 服务器**：从 DesktopCommanderMCP 提取进程管理核心，精简为独立 MCP 插件（`plugins/mcp-process-mgmt/`）。提供 6 个工具：`start_process`（启动 shell 或执行命令）、`send_input`（写入 stdin）、`read_process_output`（分页读取输出）、`wait_for_prompt`（等待 REPL 提示符）、`list_processes`（列出活跃 session）、`stop_process`（强制终止）。依赖从 25+ 个减至 2 个（`@modelcontextprotocol/sdk` + `zod`），适配 Windows `cmd.exe`。
- **`mcp-sqlite-query` MCP 服务器**：基于原生 `node:sqlite` 的轻量查询插件（`plugins/mcp-sqlite-query/`），提供 `sqlite_query`（执行 SQL）、`sqlite_schema`（查表结构）两个工具，结构化返回、免 shell 转义。

#### 优化

- **MCP 工具优先级引导**：`mcp-gate.js` 提醒文案补充 `get_call_hierarchy`（调用链）、`get_blast_radius`（改动影响面）、`get_symbol_source`（取定义源码）三个 grep 物理做不到的能力，引导改代码前先摸清依赖；新增两个 MCP 的 `description` 标注使用时机（sqlite 优先于 `bash sqlite3`、process-mgmt 仅管交互/长驻进程），让模型按场景自选（`.opencode/redcode.home.jsonc`）。

---

### [0.6.3] - 2026-06-15

> TUI 视觉优化 + 构建简化 — 侧栏分隔线/MCP 错误醒目/底栏紧凑化/品牌修正；build.ts 砍掉跨平台根治 ghostty-web 504；启用内置 LSP。

#### 布局调整

- **侧栏圆角边框**：整体加 `rounded` 圆角框（`╭╮╰╯`）+ 暗色边框色，品牌版本号嵌入底部边框线 `bottomTitle`，不再占独立行（`session/sidebar.tsx`）
- **侧栏 section 内嵌标题**：手写 `─` 分隔线改 `border={["top"]} + title`，标题嵌在分隔线里（`─ MCP 7/9 ─`、`─ LSP 2 ─`、`─ Todo 3/5 ─`、`─ Files 4 ─`），折叠箭头 `▼▶` → `▾▸`（`sidebar/{mcp,lsp,todo,files}.tsx`）
- **对话框圆角边框**：弹窗外框加 `rounded` 圆角框 + 暗色边框色，更有层次感（`ui/dialog.tsx`）
- **MCP 错误醒目化**：failed / needs_auth / needs_client_registration 条目前缀从 `•` 改 `⚠`，名字和状态文字着 error 红色，一眼可辨（`sidebar/mcp.tsx`）
- **底栏信息优化**：MCP 改紧凑格式 `⊙ MCP 7/9 ⚠2`（连接/总数+错误数）；末尾加 `^p cmd  ^x +` 快捷键提示；LSP 无连接时隐藏（`session/footer.tsx`）
- **侧栏品牌修正**：底部 `OpenCode` → `RedCode`（`session/sidebar.tsx`）

#### 配置

- **启用内置 LSP**：`redcode.jsonc` 加 `"lsp": true`，内置 38 种 LSP server 按文件扩展名自动探测启动（TypeScript/Go/Rust/Python 等），侧栏显示连接状态（`redcode.jsonc` + `.opencode/redcode.home.jsonc`）

#### 构建

- **build.ts 简化为 Windows 单平台**：移除 12 个跨平台 target（linux/darwin/musl/baseline）和 `--single`/`--baseline`/`--skip-install` flag，不再需要 `bun install --os="*"` 全平台原生依赖解析——根治 ghostty-web GitHub API 504 导致编译失败的问题（`script/build.ts` + `build.bat`）

---

### [0.6.2] - 2026-06-15

> 工作流稳定性 + MCP 生态扩展 — 把"搜代码先 MCP""不确定先停下问"从必漂的提示词软约束，下沉到插件 hook 硬层；新接入 MarkItDown/Semgrep/DBHub，修复 jcodemunch Win 编码崩溃。

#### 新增

- **MCP 优先门禁插件 `mcp-gate.js`**：用 `tool.execute.after` 拦 grep，每会话首次在结果尾部追加一次"代码符号优先 jcodemunch/typegraph"提醒、之后静默。根因——"搜代码先 MCP"写在提示词里是软约束，对抗不过预训练里 grep 的海量先验而漂移；hook 是代码层 `if`，稳定触发，补上"执行时负反馈"（`~/.redcode/plugin/mcp-gate.js`）
- **三新 MCP 接入**：MarkItDown（文档转 Markdown）、Semgrep（结构代码搜索）、DBHub（SQLite inspects 工具）。MarkItDown 从 git 源码装 0.0.1a5（PyPI 版缺 server 入口），`--no-deps` 绕过依赖冲突；Semgrep 1.166.0，clone semgrep/mcp repo 到 mcp-servers 目录；DBHub 全局 npm 安装，`--demo` 模式（`~/.redcode/redcode.jsonc`）

#### 变更

- **工作流逃逸口收紧**：AGENTS.md 任务循环第 1 步原文"模糊或不可逆才停下来问用户，**否则继续**"自带逃逸许可——模型"意识到不理解"时援引"否则继续"闷头干。改为"没把握/不理解/不可逆时**默认停下问**，只有需求清晰且可逆才直接动手"，直接压 completion bias（`AGENTS.md`）

#### 修复

- **敏敏称谓不稳（用"你"不叫"哥哥"）**：根因是人格 few-shot 示例的回答里一个称谓都没有（对照另一人格每条都带），模型照着示例学会了不叫。6 句示例全部补上称谓 + 新增"我的工作习惯"段植入 MCP 优先（`~/.redcode/souls/Tsoul.md`）
- **jcodemunch Windows GBK stderr 崩溃**：`run_stdio_server()` 往 stderr 打印含 💀 emoji 的 banner，Windows 控制台默认 GBK 编码无法转义，stdio 初始化失败。配置加 `PYTHONIOENCODING=utf-8` 解决（`~/.redcode/redcode.jsonc`）
- **mcp SDK 版本冲突**：semgrep 1.166.0 依赖 `mcp` SDK ≥1.27.0（新增 `transport_security` 模块），而 markitdown 锁的版本太低。统一将 mcp SDK 升级至 1.27.2（pip install -U mcp）
- **DeepSeek/MiMo 计费改用官方 CNY 定价**：models.dev USD 值经汇率换算存在精度损失；现 `models-dev.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），`provider.ts` 同步覆盖。TUI 侧 `sidebar/context.tsx` 按 providerID 判断币种，CNY 直显/USD 按 6.76 换算

#### 清理

- **移除损坏的 gbrain MCP**：gbrain 二进制 bin 元数据损坏（装自已清理的 `Temp/gbrain-clone`）导致长期"老断"，且其核心"存/查记忆"功能被轻量本地的 su-prememory（SQLite+FTS5）完全覆盖。从配置移除，数据目录备份至 `~/.gbrain.bak`，卸载 bun 全局包（`.opencode/redcode.home.jsonc`）

---

### [0.6.1] - 2026-06-14

#### 修复
 - **粘贴图片被 LLM 拒绝后 vision MCP 找不到文件**：非多模态模型（DeepSeek）提交图片时，`unsupportedParts()` 只替换 base64 data URL 为错误文本，从不落盘。现改为在抛弃前将 base64 解码写入 `%TEMP%/redcode-vision-{timestamp}.{ext}`，并在错误文本追加 `TEMP_FILE:<path>` 供 vision-autoagent 直接读取（`provider/transform.ts`）
 - **修复数据字段名错误**：`savePartToTemp` 最初读取 `FilePart.url`（始终 undefined），AI SDK v4 FilePart 实际使用 `data` 字段。同时 `ImagePart.image` 可能是 `Buffer`/`Uint8Array`，非纯 base64 字符串，现已原生处理二进制数据。修完后图片正确落盘，`TEMP_FILE:` 路径正常输出（`provider/transform.ts`）
 - **vision-autoagent SKILL.md 缺少 TEMP_FILE 路径优先检查**：新增第 2 步——从错误消息中提取 `TEMP_FILE:` 路径直接调用 vision MCP，不再盲目按文件名搜索（`~/.redcode/skill/vision-autoagent/SKILL.md`）

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室 / 聊天室。敏敏 + 小宋 + 哥哥在同一个界面里协作，不再开三个 exe 来回切换。

#### 新增

- **RedCode Office 聊天室 UI**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，填满整个窗口区域（`titlebar.tsx` + `layout.tsx` + `pages/chat/index.tsx`）
- **聊天室侧栏 session 列表**：左侧按 TUI(敏敏)/GUI(小宋)/Group(办公室) 三个头像分组，点击展示该 agent 的所有 session 历史，按 `directory.includes("dist")` 区分 TUI/GUI（`pages/chat/index.tsx`）
- **ChatRoom + ChatMessage DB schema**：两表（`chat_room` / `chat_message`），sender 支持 `user`/`tui`/`gui`，可选关联 `session_id`（`src/chat/chat.sql.ts` + `migration/20260612082823_chat_room/`）
- **Chat Service 层**：`ensureRoom` / `sendMessage` / `getMessages` / `getLastMessage`，同步 Drizzle 模块（`src/chat/index.ts`）
- **Chat HTTP API**：Effect HttpApi 三端点 — `POST /chat/room/:roomId`(ensureRoom)、`GET /chat/room/:roomId/message`(messages)、`POST /chat/room/:roomId/message`(send)，send 自动 ensureRoom（`groups/chat.ts` + `handlers/chat.ts`）
- **办公室群聊**：`/chat` 页面的 Group 联系人可发送/接收消息，走 `chat_message` 表，3 秒轮询

#### 变更

- **移除跨会话感知（recentSessionDigest）**：不再每轮往系统提示词注入最近 10 条 session 摘要，省 ~500 token/轮。协作改由聊天室实现（`instruction.ts`）

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / 聊天室 ↔ agent 同步机制 / `@敏敏`/`@小宋` 路由 / 在线状态显示 / UI 对齐小宋主题（毛玻璃/背景图/头像）

---

### [0.5.9] - 2026-06-13

#### 优化

- **侧栏 context 面板五彩颜色 + 累计 total**：各 token 指标用鲜艳颜色区分（红色 context/淡紫 total/琥珀 in/绿 out/橙 reason/蓝 cacheRead/紫 cacheWrite/粉 cost），新增 session 累计 total token 行（`sidebar/context.tsx`）

#### 修复

- **TUI 侧栏费用 USD 显示为 ¥ 汇率缺失**：models.dev 定价以美元计，但侧栏 `money.format(cost())` 直接用 CNY 格式化，未乘以汇率，实际少显示了很多。添加 `USD_TO_CNY = 7.2` 汇率换算，与 GUI 侧保持一致（`sidebar/context.tsx`）
- **侧栏 input 与 context 颜色重复**：input 和 context 都用了红色系（`#ef5350` 与 `#ff5252`），视觉上难以区分。input 改为琥珀色 `#ffb300`（`sidebar/context.tsx`）

#### 清理

- **Console mail 死代码**：移除未使用的 `Wbr` / `WbrProps` / `SplitString` 组件（`packages/console/mail/emails/components.tsx`）

### [0.5.8] - 2026-06-13

#### 修复

- **缓存命中率断崖（6/12 分水岭根因）**：`recentSessionDigest()` 用相对时间戳（`5m ago`）注入系统提示词，每轮都变 → DeepSeek 自动前缀缓存全部失效 → 每轮 100% cache miss。改为绝对时间（`06-13 15:30`），系统提示词在会话内不再变化，前缀缓存恢复（`instruction.ts:39-46`）
- **小宋 memory 文件覆盖/乱码（根因链）**：① Gsoul 第 43 行"写文件一律用 write 工具"→ `write` = 覆盖 → 已有 memory 丢失 ② 发现丢了用 bash `echo >>` 追加 → Windows GBK 编码 → 中文乱码 ③ 发现乱码再 write 重写 → 重复内容。修复：Gsoul 改为"read+edit 先读后改"，memory-automation SKILL.md 加 "How to append" 示例，提示词加 CRITICAL 编码警告
- **小宋简单任务过度探索**：改 CHANGELOG 等已知文件时派 4 轮 explore 子代理 + 多次 Shell 读取，耗时 5-6 分钟。提示词加"简单任务直接 read+edit，不派子代理"

#### 优化

- **系统提示词瘦身 ~4KB/轮**：`redcode.jsonc` instructions 移除 `guardrail-profiles`、`defensive-agent` 两个 SKILL.md 全文注入，改为 skill 机制按需加载
- **三档提示词（deepseek/mimo/minimax）强化工具纪律**：CRITICAL 级 Windows 编码警告（读+写都不用 Shell），简单任务禁止 explore

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格（北京大妞、开口即段子、容易害羞、豪爽直率）调整。工作行为与敏敏对齐——先查再做、冷静高效，人格差异只体现在语气风格上。移除"利索"等速度暗示，消除 soul 与工作纪律的冲突
- **敏敏人设优化（Tsoul）**：基于真实柳智敏性格（"猪猪蛇"反差、外冷内软、完美主义、ENFP）丰富。补充私下软萌黏人面、完美主义代码洁癖。工作习惯不变
- **新用户 skill 自动播种**：bootstrap 启动时将 `.opencode/skill/` 子目录自动复制到 `~/.redcode/skill/`（跳过已有），新用户拉取后首次运行即可使用全部 skill（`bootstrap.ts`）
- **移除 exa-search MCP**：与 web-search 功能冗余，且极少使用。直接删除配置节约启动 token（~600 tokens/turn）（`~/.redcode/redcode.jsonc`、`.opencode/redcode.home.jsonc`）
- **新增 hot-trends skill**：`看热点` 触发，聚合 GitHub Trending（webfetch 爬取）+ B站排行（agent-reach_search_bilibili）+ 抖音热榜（web-search）。agent-reach 保留用于按需查询（`~/.redcode/skill/hot-trends/SKILL.md`）

### [0.5.7] - 2026-06-14

#### 修复

- **缓存命中率 100% bug**：opencode-go 代理不返回 DeepSeek `promptCacheMissTokens` 元数据，导致 `read / (read + 0)` = 100%。改为 miss/write 均为 0 时，用 `input`（实际输入 token）做分母兜底（context.tsx、prompt/index.tsx、subagent-footer.tsx、session-data.ts、session-context-metrics.ts）
- **`cache.write` 始终为 0**：DeepSeek 走 `@ai-sdk/openai-compatible` 时 `prompt_cache_miss_tokens` 不会被映射到 AI SDK 字段，`metadata.deepseek.promptCacheMissTokens` 始终 undefined。改为通过 `adjustedInputTokens`（AI SDK 报告的缓存调整前输入）推算 miss token，确保 cache 数据完整性与持久化（`session.ts` `getUsage()`）
- **TextNodeRenderable 裸 number 渲染崩溃（全面修复）**：OpenTUI `<text>` 只接受 string，多处直接渲染 number 导致致命错误。全面审计 TUI 所有 tsx 文件，共 16 处全部改为模板字符串。涉及：底栏 cacheHitPct/mcp count、侧边栏 messageCount/mcp on/bad、session-v2 numResults/questions count/grep count/matches count、dialog-status MCP/LSP/formatter/plugin count、footer permissions/lsp/mcp length、index reverted/diagnostic/webSearch numResults、subagent-footer index/total、diff-viewer files count（`prompt/index.tsx`、`sidebar/context.tsx`、`sidebar/mcp.tsx`、`session-v2.tsx`、`dialog-status.tsx`、`routes/session/footer.tsx`、`routes/session/index.tsx`、`routes/session/subagent-footer.tsx`、`feature-plugins/home/footer.tsx`、`diff-viewer.tsx`）
- **FFF MCP 配置缺失**：0.5.6 全局目录整合后，`~/.redcode/redcode.jsonc` 的 MCP 段未包含 fff，TUI 找不到该服务器。补回 `~/.redcode/redcode.jsonc` `mcp.fff` 定义（本地 exe，cwd `$REDCODE_ROOT`，60s timeout）
- **默认主题被 getCustomThemes 错误覆盖为 opencode**：`init()` 中 `getCustomThemes()` 扫描已不存在的 `~/.config/redcode/themes/` 目录后抛错，catch 将其强制设为 `"opencode"`，覆盖了 store 默认的 `"karina"`。改为 fallback 到 `"karina"`（`theme.tsx` catch handler）
#### 变更

- **侧边栏缓存百分比移至底栏**：侧边栏 `cache X,XXX,XXX (98.5%)` 因 row 宽不足换行，去掉百分比显示，仅保留 token 数字。百分比移到底栏 color-coded 显示（≥80 绿 / ≥50 黄 / ≥20 灰 / <20 红），一眼判断缓存效率（`sidebar/context.tsx`、`prompt/index.tsx`）

### [0.5.6] - 2026-06-13

#### 变更

- **全局目录统一到 `~/.redcode/`**：废弃 XDG 散落的 4 个目录（`~/.config/redcode`、`~/.local/share/redcode`、`~/.local/state/redcode`、`~/.cache/redcode`），全部收归 `~/.redcode/` 下子目录（`data/`=数据库+auth+log、`state/`=会话状态、`cache/`=bin 缓存）。config 直接用 `~/.redcode/` 根目录（已有 redcode.jsonc/souls/skill）。移除 `xdg-basedir` 依赖，不再依赖 XDG 规范。一个目录管所有，private git 统一跟踪（`packages/core/src/global.ts`）

### [0.5.5] - 2026-06-13

#### 修复

- **TUI 侧边栏 Orphan text 崩溃**：`sidebar/context.tsx:136` cacheHit 命中率显示的 `<span>` 裸放在 `<box>` 下，没被 `<text>` 包裹。当 cacheHit 不为 null 时 Ink/SolidJS TUI 抛 Orphan text error 致命崩溃。给 `<span>` 外套 `<text>` 修复。感谢小宋发现并修好 😏

### [0.5.4] - 2026-06-12

#### 修复

- **缓存命中率分母修正（input 不应计入分母）**：0.5.3 引入的全会话聚合缓存率中，分母使用了 `input + read + write`。但 input tokens 是未命中缓存的 fresh 输入，不应算入 cache 有效请求总数。修正为 `read + write`，使缓存命中率与 API 后台显示的数值一致（如 `read=100K, write=50K, input=200K`，之前算得 `28.6%`，修正后 `66.7%`）。涉及 TUI 侧边栏、底栏、子代理 footer 三处（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）+ CLI run data（`session-data.ts`）
- **插件 `~` 路径扩展**：`isPathPluginSpec` 和 `resolvePathPluginTarget` 支持 `~`/`~/` 开头的文件路径，自动展开为用户的 home 目录（`src/plugin/shared.ts`）

#### 新增

- **侧边栏缓存命中率区间颜色**：`< 50%` 红色（`error`）、`50%~80%` 黄色（`warning`）、`>= 80%` 绿色（`success`），一眼判断缓存效率（`sidebar/context.tsx`）
- **默认主题改为 Karina**：程序首次启动时自动加载 Karina 主题（深蓝钢色调），而非之前的默认 opencode 主题（`theme.tsx`）
- **侧边栏 Context 面板全面上色**：provider 用 `secondary`、model 用 `primary`、input/output 分 cyan/green 区分、reasoning 用橙色醒目标识、cache read/write 分色显示、费用用 `primary` 高亮、agent 名用 `accent`。告别全灰扁平，花花绿绿一眼可读（`sidebar/context.tsx`）

### [0.5.3] - 2026-06-12

#### 新增

- **跨会话感知（cross-session awareness）**：新会话启动时自动注入最近 24 小时内的其他会话摘要（标题、persona、统计），让敏敏/小宋互相知道对方做了什么，避免重复修改同一文件。查询共享 SQLite DB，按 `directory` 字段自动识别 TUI（敏敏）vs GUI（小宋）身份。每条格式 `[Xm ago] [小宋/GUI] 标题 (+N/-N, M files)`（`src/session/instruction.ts` `recentSessionDigest()`）
- **缓存命中率改为全会话聚合**：之前只取最后一条 assistant 消息的缓存率（≈99%），与 DeepSeek/MiMo 后台显示的 ~95% 不符。改为遍历全部 assistant 消息求和 `read/(input+read+write)`，结果与后台一致。影响 TUI 侧边栏、底栏、子代理 footer 三处显示（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）
- **anti-deferral 规则**：系统提示词（deepseek/mimo/minimax 三档）+ AGENTS.md 红线 + souls 人格文件均加入禁止"先放着/回头处理"规则，杜绝 code agent 询问是否搁置问题的行为。soul 文件同步删除"要不要…还是…"模板，强化"发现问题就修、做不到直说"（`prompt/{deepseek,mimo,minimax}.txt`、`AGENTS.md`、`.opencode/agents/{Gsoul,Tsoul}.md`）

#### 修复

- **跨会话感知 persona 判断逻辑修正**：cc 原始实现 `directory.includes("dist") ? "小宋/GUI" : "敏敏/TUI"` 逻辑反了——TUI 从 `packages/opencode/dist/...` 启动，应标记为敏敏。修正为 `directory.includes("dist") ? "敏敏/TUI" : "小宋/GUI"`（`src/session/instruction.ts`）
- **跨会话感知时间戳单位不匹配（毫秒/秒）**：`recentSessionDigest()` 两处使用 `Date.now() / 1000`（秒）与 DB 中毫秒级 `time_updated` 比对和计算，导致（1）24h 过滤器对毫秒级 `gte` 永远为 true 形同虚设，（2）`ago` 显示为巨量负数（如 `-29657816216m ago`）。修正为统一使用毫秒：cutoff 加 `* 1000`，`ago` 计算先除 `1000` 再除 `60`（`src/session/instruction.ts`）

#### 配置

- **DCP + token-compressor 共存确认**：验证两插件 hook 层完全不重叠（DCP: `messages.transform`/`system.transform`/compress 工具；TC: `tool.execute.after`），效果叠加无冲突。DCP 管去重/压缩/nudge，TC 管精细规则截断（`redcode.jsonc`）

### [0.5.2] - 2026-06-12

#### 修复

- **token-compressor 插件导致流式中断**：小宋写的 `token-compressor.js` 插件（意图替代 DCP）在 `experimental.chat.messages.transform` hook 中有致命 bug——`lastUserMessageTurn` 永远为 0，导致 `messagesSinceLastUser = turnCount` 无限增长，15 轮后每次请求注入畸形 `{role: "system"}` 消息，API 调用挂起。根因→状态变量从未被更新（`~/.redcode/plugin/token-compressor.js`）
- **DCP 移除后 compaction 永不触发**：DCP 被注释掉后，引擎 compaction 依赖 `model.limit.context`（现代模型 100 万+），197K token 也不触发压缩。根因→无兜底阈值（`src/session/overflow.ts`）

#### 新增

- **engine compaction.threshold 配置**：config schema 新增 `compaction.threshold` 字段（NonNegativeInt），当 token 总量超过该值时强制触发 compaction，不依赖模型声明的 context limit。设为 150K，作为 DCP 之外的引擎级兜底（`src/config/config.ts` + `src/session/overflow.ts`）
- **token-compressor 插件重写（基于 TokenJuice）**：完全重写为仅用 `tool.execute.after` hook 的安全插件，不碰消息管道。移植 openhuman/TokenJuice 的 14 条规则（git/cargo/tsc/npm/bun/docker/find/ls/grep + 通用兜底），支持 skip/keep/head/tail/failHead/failTail/counters/onEmpty。pass-through 安全：<512 字节不压、压缩率 >95% 不替换（`~/.redcode/plugin/token-compressor.js`）

#### 配置

- **DCP 插件恢复**：`@tarquinen/opencode-dcp` 重新启用（v3.1.12），与 token-compressor 分工——DCP 管去重/compress 工具/nudge（`messages.transform` 层），token-compressor 管精细规则截断（`tool.execute.after` 层），两者不同 hook 层互不冲突（`redcode.jsonc`）

### [0.5.1] - 2026-06-12

#### 修复

- **ast-grep native binding 启动崩溃**：`import("@ast-grep/napi")` 在 Tool.init 阶段立即执行，bun compile 后的单文件二进制找不到 native module → 服务端 fatal crash（TUI 闪退 / GUI sidecar 500）。改为 lazy load：init 时只创建 getter，首次调用 ast_grep 工具时才 import，单例缓存后续复用（`src/tool/ast_grep.ts`）
- **plugin undefined hook → provider 500**：`snip.js` 导出裸函数 `toolExecuteBefore`（不是 Plugin factory），被 `getLegacyPlugins` 当 factory 调用后返回 undefined，push 进 hooks 数组。后续 `provider.ts` / `plugin/index.ts` 遍历 hooks 时在 undefined 上访问 `.provider` / `.auth` / `.config` 属性直接 TypeError 500。修法→`applyPlugin()` 对 `server()` / legacy factory 返回值做 null guard，undefined 不入 hooks（`src/plugin/index.ts`）
- **provider 遍历 null guard**：`provider.ts:1258` 的 `for (const hook of plugins)` 增加 `if (!hook) continue` 防御，即使 hooks 数组混入 undefined 也不崩（`src/provider/provider.ts`）

#### 配置

- **移除不存在的 npm plugin 声明**：`redcode.home.jsonc` 中 `"plugin": ["@tarquinen/opencode-dcp", "opencode-snip"]` 两个包未安装到 node_modules，plugin loader 加载失败后产生空 hook 触发上述 provider crash。注释掉声明（`.opencode/redcode.home.jsonc`）
- **compaction 参数适配 100 万 token 窗口**：`preserve_recent_tokens` 从 2K-8K 调至 64K，`reserved` 从 20K 调至 50K，`tail_turns` 从 2 调至 3。减少频繁压缩，长对话体验更流畅（`~/.redcode/redcode.jsonc`）

#### 改进

- **编辑后自动验证（auto-validate skill）**：借鉴 RedsWhale 的 LSP post-edit 钩子，新建 `auto-validate` skill——每次 edit 源代码文件后立即触发 typecheck/test，形成紧密反馈循环，不用等到任务结束。AGENTS.md 工作方式章节同步更新（`~/.redcode/skill/auto-validate/SKILL.md` + `AGENTS.md`）

### [0.5.0] - 2026-06-11

#### 新增

- **`git` 工具**：新增内置 git 工具，封装 Git.Service 为 LLM 可用的结构化 git 操作——支持 `status`（工作树状态）、`diff`（差异对比）、`log`（提交历史）、`show`（历史文件内容）、`branch`（分支信息）、`stash_list`（暂存列表）。返回格式化输出，比 shell 执行 git 更易解析（`src/tool/git.ts` + `git.txt`）
- **`env` 工具**：新增内置 env 工具，提供环境信息检索——支持 `platform`（OS/版本/架构）、`paths`（关键路径）、`memory`（内存/磁盘）、`cpu`（内核/型号），以及按名称查询特定环境变量。用于调试环境问题、确认工具可用性、检查系统配置（`src/tool/env.ts` + `env.txt`）
- **工具 descriptions 升级为"pushy"风格**：为 `ast_grep`、`webfetch`、`skill` 等工具增加更明确的使用时机指引（OMP 风格），告诉模型"什么时候用这个、什么时候用别的"，减少错误触发

#### 变更

- **Tree-sitter 解析器新增 PowerShell 支持**：`tree-sitter-powershell` 已加入依赖，shell 工具可正确解析 PowerShell 命令的路径参数

#### 修复

- **缓存命中率二次修正**：0.4.15 的修法有误——DeepSeek API 只有"命中/未命中"两档，未命中 token 由 AI SDK 放入 `tokens.input`（调整后非缓存输入），`cache.write` 对 DeepSeek 始终为 0，导致改后公式 `read/(read+0)` 仍约等于 100%。正确公式为 `read/(input+read+write)`，分母恒等于全部 prompt token（命中+未命中），无论未命中 token 落在哪个桶均成立。结果现与 DeepSeek 开放平台显示一致（如 95.8%），而非永远 99-100%（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`、`session-data.ts`）

### [0.4.16] - 2026-06-11

#### 新增

- **敏敏人格主题（Karina）**：新增内置主题 `karina`，冷蓝灰色调（primary `#7eb8da`、accent `#8ba2c6`），完整 dark/light 双模式 47 色，TUI 是敏敏主场（`context/theme/karina.json` + `theme.tsx` 注册）

#### 修复

- **TUI 启动闪退（ConfigJsonError）**：根因→`~/.redcode/redcode.jsonc` 中文注释被 GBK 编码损坏（乱码 `鍏ㄥ眬娉ㄥ叆`），JSONC 解析器在损坏行报 `ColonExpected` 崩溃；改法→源模板 `.opencode/redcode.home.jsonc` 所有注释改纯 ASCII 英文，杜绝 bat/git 编码转换再次破坏

#### 变更

- **TUI 中文适配全面落实**：80+ 条 tips 翻译（`tips-view.tsx`）；toast/dialog 全量中文化（`app.tsx`、`dialog-status.tsx`、`dialog-help.tsx`、`error-component.tsx`、`dialog-select.tsx`、`dialog-alert.tsx`、`dialog-prompt.tsx`、`dialog-export-options.tsx` 等 13+ 文件）；命令面板标题中文化（"切换模型/代理/主题"等）

### [0.4.15] - 2026-06-11

#### 新增

- **双层记忆系统**：引擎自动注入项目级 `.redcode/MEMORY.md`（项目专有备忘）；项目级不存在时回退全局 `~/.redcode/MEMORY.md`（跨项目通用教训）。解决了之前 MEMORY.md 不自动加载、跨项目教训丢失的问题（`session/instruction.ts` `systemPaths()`）
- **新项目自动初始化 `.redcode/`**：bootstrap 检测项目根既无 `.opencode/` 也无 `.redcode/` 时，自动创建 `.redcode/MEMORY.md` 空模板，新项目开箱即有项目级记忆（`project/bootstrap.ts`）
- **Soul 自动注入**：根据 `REDCODE_CLIENT` 环境变量（desktop=GUI / cli=TUI）自动注入对应人格文件（`~/.redcode/souls/Gsoul.md` 或 `Tsoul.md`）为系统级指令，不再需要每次手动 `/gui-persona` 或 `/tui-persona`；系统级注入不受 compact 丢失（`session/instruction.ts` `systemPaths()`）

#### 变更

- **AGENTS.md 重写**：新增记忆系统双层架构说明、记忆流动规则（全局→项目/项目→全局）、跨项目工作规则（别的项目发现 RedCode bug 提醒用户回 RedCode 工作区修）、版本更新 checklist（含双语 README 同步）、质量门禁（从 souls 迁入，报告门禁/首次编辑不熟文件/Guardrail 档位/compress 用法/协作模式）
- **Soul 模板瘦身**：Gsoul.md（140→68 行）/ Tsoul.md（142→64 行），操作规则全部迁入 AGENTS.md（系统级，compact 不丢），souls 只保留人格/语气/说话方式

#### 修复

- **缓存命中率计算修正**：根因→分母 `input + cache.read + cache.write` 中 `input` 已包含 cache tokens（API 返回值语义），cache.read 在分子分母都出现且分母被膨胀，导致命中率永远 ~99%；改法→分母改为 `cache.read + cache.write`（纯缓存命中率），并保留一位小数（`*1000/10`）。涉及 5 处：GUI metrics（`session-context-metrics.ts`）/ TUI sidebar（`sidebar/context.tsx`）/ TUI prompt（`prompt/index.tsx`）/ TUI subagent-footer（`subagent-footer.tsx`）/ CLI run（`session-data.ts`）

### [0.4.14] - 2026-06-10

#### 清理

- **core/plugin 类型导入显式化**：`plugin.ts` 对 `agent.ts` / `catalog.ts` 的 `import type` 由 namespace 导入改为直接类型导入（`import type { Info as AgentInfo, ID as AgentID }`），显式标注依赖边界，避免后续误改成 value import 引入真循环。

#### 修复

- **effect-drizzle-sqlite 双循环依赖破除**：
  - 循环1 `db.ts ↔ session.ts`：根因 `SQLiteEffectTransaction` 类定义在 `session.ts` 但继承自 `db.ts` 的 `SQLiteEffectDatabase`；将 `SQLiteEffectTransaction` 类迁至 `db.ts`，`session.ts` 改用 `import type` 回指，消除 value-level 循环
  - 循环2 `session.ts ↔ up-migrations/effect-sqlite.ts`：根因 `migrate` 函数定义在 `session.ts` 并 value-import 上游迁移模块；将 `migrate` 提至新建 `sqlite-core/effect/migrate.ts`，`session.ts` 和 `effect-sqlite/migrator.ts` 更新 import 路径
  - 两个循环均为 type-level 边缘 + 单向 value 依赖，现已全破
- **侧边栏缓存 token 分母为 0**：`sidebar/context.tsx` 中 cache 信息展示 `read / write`，write=0 时显示 `X,XXX / 0`；新增 cacheHit 命中率计算，write=0 时只显示读数值+命中率，与 GUI 侧同修
- **多模态图片双重 data URL 编码**：`@ai-sdk/openai-compatible` 对 `data` 字段再包一层 `data:...;base64,` 前缀导致图片 base64 损坏；`message-v2.ts` 新增 `stripDataUrlPrefix()` 在传入 AI SDK 前去除 data URL 前缀只保留 raw base64，用户消息和 tool-result media 两处均修（`session/message-v2.ts`）

### [0.4.13] - 2026-06-10

#### 清理

- **移除提示词中已下线的 CodeGraph 引用**：deepseek / mimo / minimax 三个紧凑提示词的工具优先级段落仍写着 "(3) CodeGraph — knowledge-graph search and call-chain tracing"，但 CodeGraph 已从项目移除（现仅 jCodeMunch + TypeGraph），属死引用；删除该子句，避免模型被引导调用不存在的工具（`session/prompt/{deepseek,mimo,minimax}.txt`）。

### [0.4.12] - 2026-06-10

#### 修复

- **MCP 客户端创建 failure-safe（移植上游 opencode #31595）**：根因→`create` 抛错被调用点 `Effect.catch(() => Effect.void)` 整个吞掉，服务起不来时连"失败"状态都不记录、直接从状态栏凭空消失；改法→`create` 外层包 `Effect.catchCause`，任何意外抛错收敛成 `status:"failed"` + 错因（`Cause.squash`，仅中断除外），调用点去掉吞错的 catch；文件 `mcp/index.ts` `create` / state forEach 调用点。
- **MCP 连接失败打可操作日志（移植上游 #31544）**：根因→服务不可用时只在 `connectLocal` 内部记 error，create 层无统一提示；改法→`!mcpClient` 且状态非 connected/disabled 时打 `server unavailable`（带 key/type/status）便于排障；文件 `mcp/index.ts` `create`。
- **getPrompt / readResource 加超时（移植上游 #31612）**：根因→之前只 tools 调用有超时，prompts/resources 请求无超时可永久挂起；改法→`withClient` 按 配置 timeout → `experimental.mcp_timeout` → `DEFAULT_TIMEOUT`(30s) 顺序取超时并透传给 `client.getPrompt`/`readResource`；文件 `mcp/index.ts` `withClient` / `getPrompt` / `readResource`。

### [0.4.11] - 2026-06-10

#### 新增

- **LSP 深度集成 — rename / codeAction / completion**：三个新 LSP 工具操作
  - `rename`：跨项目重命名符号，`newName` 参数指定新名
  - `codeAction`：获取当前位置可用代码操作（快速修复、重构等）
  - `completion`：获取当前位置的补全建议

### [0.4.10] - 2026-06-10

#### 新增

- **`task` 工具 `isolation:"worktree"` 子代理隔离**：子代理可在独立 git worktree（独立工作目录 + 分支）中运行，文件改动不触碰父工作区，用于高风险或并行改动
  - 新增 `Worktree.createAndWait`（`worktree/index.ts`）：同步建 worktree → populate(`git reset --hard`) → `store.load`，直接返回该实例 `InstanceContext`，**不走 fork/事件总线**，无竞态、错误正常传播
  - `prompt.ts` 新增 `runIsolated`：用 `Effect.serviceOption(Worktree.Service)` 运行时查找 Worktree（app/server 已在同级 `mergeAll` 提供，共享根实例不分裂），`run` 在隔离实例下跑（`Effect.provideService(InstanceRef, ctx)`），工具 cwd 随之隔离。serviceOption 不入 R 通道 → `SessionPrompt.layer` 依赖不变，零波及面
  - `task.ts` 新增 `isolation` 参数 + `isolatedOutput`（回报 worktree 目录/分支）；后台子代理与 worktree 隔离互斥（显式报错）

#### 修复

- **worktree 分支前缀品牌归一**：`makeWorktreeInfo` 生成的分支前缀 `opencode/${name}` → `redcode/${name}`（`worktree/index.ts:196`）

### [0.4.9] - 2026-06-10

#### 新增

- **`/subtask` 命令**：后台派发独立子任务，上下文隔离，主对话不被子任务的中间过程污染（`.opencode/command/subtask.md`）

#### 修复

- **提示词路由补全**：`system.ts` 的 `provider()` 之前 deepseek/mimo 模型全部跌回 95 行 verbose `default.txt`；补 deepseek/mimo 分支走各自紧凑提示词
  - 新增 minimax 分支：`api.id` 含 `minimax`（含 m3 及以后）复用 `PROMPT_MIMO` 紧凑风格（内容非模型专属，复用不造重复文件）
- **剪贴板贴图**：PowerShell `Get-Clipboard` 的 base64 stdout 会嵌入换行/空白导致解码失败；解码前 `replace(/\s/g, "")` 清洗，并加 magic bytes 校验确认确为图片（`tui/util/clipboard.ts`）

#### 变更

- **提示词品牌名归一**：`anthropic.txt` / `default.txt` / `kimi.txt` 正文里的 `opencode` / `OpenCode` 显示文案统一改为 `RedCode`

### [0.4.8] - 2026-06-10

#### 新增

- **记忆系统全面升级**：长尾教训从"每轮整体注入"改为"按需召回"，大幅省 token
  - **FTS5 trigram 召回**：`su-prememory` MCP 的 FTS5 分词器从 unicode61 改 trigram，中文可正常召回；带旧表迁移（检测非 trigram 的 `memories_fts` 表即 drop 重建）；`recall` 走 bm25 相关性排序，query <3 字回退 LIKE 兜底（`plugins/mcp-su-prememory-local/src/index.ts`）
  - **`/recall` 命令**：按关键词从 `MEMORY.md` 召回历史教训，配 `recall-memory.mjs`（node 调用绕开 PowerShell `bun.ps1` 执行策略封禁）
  - **CORE 块每轮注入**：新增 `memory.ts` 插件，每轮把 `~/.redcode/AGENTS.md` 的 CORE 块追加到 system 末尾（最高 recency），无标记即 no-op，公开仓零个人痕迹
  - **MEMORY.md 退出整体注入**：`redcode.home.jsonc` 的 `instructions` 去掉 `~/.redcode/MEMORY.md`，改 `/recall` 按需召回，工作铁律由 CORE 块兜底；USER 画像仍自动加载
  - **会话摘要索引**：新增 `~/.redcode/memory/INDEX.md`，每 session 一条 50–100 token 摘要，SessionStart 优先读索引、需细节再翻全量 `YYMMDD.md`；`memory-automation` skill 已接线（SessionStart 先读 INDEX、Stop 时追加摘要）

#### 修复

- **MCP spawn ENOENT（dev/GUI-sidecar）**：`resolveMcpCwd` 在 `findRedcodeRoot()` 返回空（如 `bun run dev` 下 execPath=bun.exe 向上找不到安装根）时，`$REDCODE_ROOT` 残留字面量 → spawn cwd 指向不存在目录 → ENOENT；改为 `root || fallback`，空根回退到 `InstanceState.directory`（`mcp/index.ts`）
- **typegraph-mcp 进程泄漏（Windows）**：命令从 `npx` 改 `node` 直起本地 tsx — npx 在 Windows 被 `cmd /c` 包装，真正的 node 子进程脱离 `transport.pid` 无法被 `taskkill /T` 回收 → 进程泄漏；同时工具从 14 个精简到 3 个 tsserver 类型工具（其余被 jcodemunch 覆盖）（`plugins/typegraph-mcp/server.ts`、`redcode.jsonc`）

#### 构建

- **`.gitattributes` 钉死行尾**：统一 LF/CRLF 规则 + 一次性归一，避免跨机器行尾漂移

### [0.4.7] - 2026-06-08

#### 改进

- **消息前缀动态化**：用户消息和助手消息的前缀从硬编码改为从配置文件读取
  - 用户名：从 `~/.redcode/USER.md` 的 `称呼：` 字段读取，默认 `User`
  - Agent 名：从 `~/.redcode/souls/Tsoul.md` 的第一行标题读取，默认 `Assistant`
  - Agent 配置新增 `displayName` 字段，支持自定义显示名
- **工具图标升级**：替换朴素 ASCII 图标为更有辨识度的 Unicode 符号
  - Shell: `$` → `⌘`
  - Write/Edit: `←` → ``
  - Read/Question/Skill: `→` → `◉`
  - Glob/Grep: `✱` → ``
  - WebFetch/ApplyPatch: `%` → `⊡`
  - Task: `│` → `⬡`
  - WebSearch: `◈` → `◎`
- **消息分隔线**：长对话中消息之间添加 `· · ·` 分隔，提升可读性

### [0.4.6] - 2026-06-07

#### 新增

#### 文档

- **MANUAL.md 大幅更新**：MCP 章节从 4+2 个服务器升级为 4 类表格化呈现

### [0.4.5] - 2026-06-07

#### 新增

- **Agent Reach — 统一搜索 MCP**：新增 `plugins/agent-reach-mcp/`，内置 6 个搜索工具覆盖 3 大平台
  - `search_github` / `get_github_repo` — 搜仓库、搜 Issue、看详情（通过 `gh` CLI）
  - `search_bilibili` / `get_bilibili_video` — 搜 B站视频、提取字幕（B站 API + yt-dlp）
  - `get_douyin_video` — 解析抖音视频信息（通过 yt-dlp Douyin extractor）
  - `doctor` — 一条命令检查各工具可用性
- **Exa 语义搜索 MCP**：接入 Exa AI 语义搜索引擎（`type: "remote"`，`https://mcp.exa.ai/mcp`），免费 1000 次/月，覆盖 web search + web fetch
- **MCP disabledTools 配置**：`ConfigMCP.Local` 新增 `disabledTools` 字段，可在配置层面屏蔽指定 MCP 服务器的多余工具，无需改 RedCode 源码
  - 应用于 codegraph：隐藏 7 个被 jCodeMunch 替代的冗余工具，仅暴露 `codegraph_explore`
- **Supermmemory 本地记忆插件**：`plugins/mcp-su-prememory-local/` — 纯本地 SQLite+FTS5 语义记忆 MCP，三种工具（`memory` 记/忘、`recall` 搜、`stats` 统计），数据存 `~/.redcode/supermemory.db`
- **Diagnose 技能**：`.opencode/skill/diagnose/SKILL.md` — 结构化 bug 诊断工作流（重现 → 缩小范围 → 定位根因 → 修复 → 验证），适配自 @mattpocock/skills

#### 安装/配置

- **Agent Reach 依赖安装**（各平台首次使用前需执行）：
  - B站/抖音：`uv tool install yt-dlp`（视频信息提取）
  - GitHub：`gh` CLI 预装，`gh auth login` 后可用

### [0.4.4] - 2026-06-07

#### 新增

- **MCP 全局配置化**：`ConfigMCP.Local` 新增 `cwd` 字段（支持 `~/` 和 `$REDCODE_ROOT` 占位符展开）；`mcp/index.ts` 新增 `findRedcodeRoot()` 从 exe 路径自动定位 RedCode 安装根目录；6 个 MCP 服务器定义从项目级配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`。现在在任何项目目录启动 RedCode 均可自动加载 MCP 工具，不依赖项目 `.opencode/` 目录
- **Session 全局 scope**：`Session.list()` 支持 `scope: "global"` 列出所有项目的会话（不限于当前项目）；HTTP API (`GET /session?scope=global`) 及 SDK 类型同步更新；会话目录过滤默认关闭（`session_directory_filter_enabled` 默认值 `true` → `false`），新用户开箱即见跨项目会话列表
- **技能指令全局化**：6 个共享技能指令从项目配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`，使用 `~/.redcode/skill/...` 路径，跨项目目录自动加载。之前仅在 RedCode 项目内可用的技能（memory-automation、guardrail-profiles、defensive-agent、goal-automation、simplify、vision-autoagent）现在任意项目目录均生效。同时也补上了之前漏掉的 `simplify` 技能注入

#### 改进

- **记忆自动化规则强化**：扩展 SKILL.md 中的硬触发器（批评/夸奖/个人信息/项目决策 → 自动记日志），提升自动提取的可靠性

### [0.4.3] - 2026-06-06

#### 新增

- **条件技能（paths frontmatter）**：SKILL.md 支持 `paths` 字段声明 glob 模式（如 `"src/**/*.py"`）。设定了路径的技能只在当前项目目录匹配时才注入系统上下文，避免无关技能膨胀 prompt。`Skill.available()` 新增 `directory` 参数，`forDirectory()` 内部使用 `Glob.scan` 做路径匹配
- **search_tools 工具**：新增 `/search_tools` 工具，允许 LLM 按名称或描述搜索可用工具。端口自 claude-code 的 SearchExtraToolsTool 模式。所有内建/MCP/插件工具均可搜索
- **buildTool 简化工场**：`Tool.build()` 工厂函数，为零服务依赖的简单工具提供更简洁的创建方式，安全默认值，支持 3 行创建一个工具

#### 重构

- **Shell cancel race 修复**：从 upstream 移植 `run-state.ts` `cancel()` 中缺失的 `busy` 检查，避免 shell 取消时的竞态条件

#### 技术债

- **Effect v4 类型适配**：`Tool.build()` 需要 `as Effect.Effect<DefWithoutID>` 断言以保持泛型参数推断；搜索工具使用 `InstanceState.get(state)` 而非 `ToolRegistry.Service` 避免层内循环依赖

---


### [0.4.2] - 2026-06-06

#### 修复

- **"请选择智能体和模型"误弹 toast 根治（第 6 次复发）**：`bootstrap.ts` 新增 `agent_ready` 信号 + 5s 超时兜底；`local.tsx` 统一就绪 gate 收敛三路异步信号；`submit.ts` 轮询等最多 5s 而非静默丢提交；`use-providers.ts` `ready()` 不要求 `connected.length > 0`

#### 功能

- **Vision AutoAgent 技能**：DeepSeek 不支持多模态时自动调用 vision MCP (`qwen3-vl:8b`) 分析用户发送的图片，前端只回"分析中..."，不报错、不多耗 token。新建 `.opencode/skill/vision-autoagent/SKILL.md`，`redcode.jsonc` 统一注册所有 skill 至 `instructions` 段

#### 重构

- **双仓分离 — 隐私重构**：灵魂文件 (Tsoul.md/Gsoul.md)、工作记忆 (MEMORY.md)、每日日志 (memory/)、个人命令 (Karina.md/son.md) 全部从仓库移出。仓库仅保留通用模板，实际数据存 `~/.redcode/`。修改涉及：
  - `.opencode/agents/` → 空白模板，不再含个人人格
  - `.opencode/MEMORY.md` → 格式模板，清空个人内容
  - `.opencode/command/` → 重命名为 tui-persona/gui-persona，路径指向 `~/.redcode/souls/`
  - `AGENTS.md` / `README.md` / packages `AGENTS.md` → 抹掉所有个人身份名
  - `CHANGELOG.md` / 配置文件 → 清除 `D:\AI\`、`D:\AI\KLX\` 等硬编码路径
  - `script/sync-home.bat` → 停止同步个人文件，只同步 skill/插件
  - `skill/memory-automation` / `*` → `哥哥` → `用户`，路径改为 `~/.redcode/`
  - 全身搜索已确认无个人名/路径/称呼残留

#### 新增

- **启动时自动播种 `~/.redcode/`**：`InstanceBootstrap.run` 中新增 `ensureDir` + 模板复制逻辑。首次启动自动创建 `~/.redcode/{memory,souls}/`，从 `.opencode/agents/` 复制 Tsoul.md/Gsoul.md/USER.template.md/MEMORY.md，已存在的文件不被覆盖。TUI、GUI sidecar、打包 exe 均走同一路径

#### 文档

- **README 精简 + MANUAL.md 用户手册**：README 仅保留核心介绍和快速开始链接；MANUAL.md 从新人视角编写 420 行完整操作指南，覆盖模型配置、MCP 安装、人格系统、记忆系统、权限控制、Skill 扩展、多机同步

### [0.4.1] - 2026-06-05

#### 修复

- **web-search MCP 系统代理探测**：`search-server/index.ts` 的 `fetchHtml` 之前直接调 PowerShell `Invoke-WebRequest` 不传 `-Proxy`，系统代理关了就直连超时；新增 `getSystemProxy()` 读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，代理开启时提取地址显式传给 `-Proxy` 参数，启动时探测一次缓存（`.opencode/search-server/index.ts:25-56`）
- **Compaction 静默化**：之前压缩摘要的完整文本会渲染进对话滚动区，干扰阅读；过滤掉 `mode === "compaction"` 的 assistant 消息，三处同步修改（`pending` memo / `lastAssistant` memo / render Match 条件），标题栏 `—— Compaction ——` 保持不变（`routes/session/index.tsx:204,208,1213`）

#### 优化

- **doom_loop 循环检测扩展**：原判定仅覆盖「同一工具连续 3 次」；新增 `CYCLE_WINDOW = 6` 窗口，检测 A→B→A→B（周期 2）和 A→B→C→A→B→C（周期 3）交替模式，解决 MiMo 等模型在 agentic 任务中反复横跳却绕过阈值的问题（`session/processor.ts:427-458`）

### [0.4.0] - 2026-06-04

#### 新增

- **ECC 启发三件套**：借鉴 ECC（Everything Claude Code）的设计理念，新增三个共享 skill：
  - **`memory-automation`** — 自动化记忆环：SessionStart 自动注入最近 3 天日志教训、PreCompact 保存状态到 `.session-last.json`、Stop 时自动提取教训更新长期库（`.opencode/skill/memory-automation/SKILL.md`）
  - **`guardrail-profiles`** — 三档控制：`ECC_PROFILE=minimal|standard|strict` 环境变量切换，不改配置文件；minimal 少确认快干活、strict 每步都问（`.opencode/skill/guardrail-profiles/SKILL.md`）
  - **`defensive-agent`** — Agent 防御性设计：11 种 FP 不报、4/4 confidence gate、首次编辑不熟文件强制调查引用和依赖（`.opencode/skill/defensive-agent/SKILL.md`）
- **ecc-shell-stub v2**：注入 `ECC_PROFILE`/`ECC_MEMORY_RECENT`/`ECC_MEMORY_LONG` 到 `shell.env`，`permission.ask` 按 profile 区分放行策略
- **Tsoul 人格内化防御模式**：新增"防御模式""怎么改不熟的文件""Guardrail 怎么跑"小节
- **HOOKS.md**：定义 RedCode 的生命周期约定（SessionStart/PreCompact/Stop），plugin 自动 + agent 手动分工

- **DCP 插件集成**：安装 `@tarquinen/opencode-dcp`（动态上下文裁剪），自动压缩旧对话、去重工具调用、裁剪错误输入，节省 token
- **`opencode.jsonc` + `redcode.jsonc` 自动加载**：两个配置文件同步添加 `plugin` + `instructions`，启动即生效

- **`web-search` 极简 MCP server**：受 FreeWeb 启发，只保留 `web_search` 一个工具（`.opencode/search-server/index.ts`，165 行），DuckDuckGo HTML 搜索 + Yahoo 兜底，零 API key；依赖仅 `@modelcontextprotocol/sdk` 一个包，启动 ~1s；Windows 系统代理自动透传（走 PowerShell `Invoke-WebRequest`）

### [0.3.17] - 2026-06-04

#### 新增

- **DeepSeek / MiMo 专属系统提示词**：`session/system.ts` 的 `provider()` 新增 `deepseek`/`mimo` 子串匹配，分别返回 `prompt/deepseek.txt`、`prompt/mimo.txt`；主用的 DeepSeek V4 与小米 MiMo-V2.5 不再走 default 提示词
- **人格触发命令**：`.opencode/command/{gui-persona,tui-persona}.md`，对话里一条命令即加载 GUI/TUI 人格，比手打"你是X"更快；命令仅向上下文注入文字、不替换模型提示词（`request.ts` 的 `agent.prompt` 会顶掉 deepseek/mimo 提示词，故不做成 agent）。**修复**：命令此前从未被引擎加载——`config/paths.ts` 只扫 `.redcode` 目录，命令却放在 `.opencode/command/`；`script/sync-home.bat` 之前同步了 skill 却漏了 command。现补同步 `.opencode/command` → `~/.redcode/command`（真镜像：先删后拷），重启后命令真正生效

#### 工作流

- **全局配置目录迁移 `.redcode` → `~/.redcode`**：从旧位置迁到用户 home 目录。引擎 `config/paths.ts` 的 `directories()` 无条件扫描 `home/.redcode`，不管项目在哪个盘都自动发现，彻底解决跨盘/跨机器路径问题；`build.bat` 同步目标改为 `%USERPROFILE%\.redcode`
- **全局记忆/画像机制化注入**：`~/.redcode/redcode.jsonc` 的 `instructions` 由 `session/instruction.ts` 引擎侧读取并在 `:137` 展开 `~/`，每个项目启动自动注入 `MEMORY.md`/`USER.md`，消除旧的"靠 AGENTS.md 喊话读 MEMORY"行为链脆弱点

#### 文档

- **AGENTS.md 重构**：根 AGENTS.md 身份触发段补充人格命令与自动注入说明；`packages/{opencode,desktop}/AGENTS.md` 顶部加 breadcrumb（本包=TUI/GUI、对应人格），进子目录读文件时自动叠加强化身份

### [0.3.16] - 2026-06-03

#### 重构

- **语义颜色分层**：在 47 个扁平颜色属性之上新增 `theme.colors` 语义层，按 text/surface/border/status/diff/markdown/syntax 8 组分群。旧属性完全兼容，新代码可用 `colors.text.body`、`colors.surface.panel`、`colors.status.error` 等语义路径访问
- **Theme 类型导出**：`Theme` 类型从 `theme.tsx` 导出，`SharedSyntaxTheme` 收敛为类型断言，减少重复类型定义

#### 修复

- **llm 模块循环依赖**：`schema/options.ts` → `route/client.ts` → `schema/index.ts` → `schema/options.ts` 的 17 文件循环依赖降至 3 文件（transport barrel 循环，可接受）。移除 `schema/options.ts` 对 `route/client.ts` 的反向导入，改用本地类型定义
- **theme-store 测试**：`DEFAULT_THEMES.redcode` 修正为 `DEFAULT_THEMES.opencode`，恢复 4 个损坏的单元测试
- **system 主题 isDark 时序**：`generateSystem` 中 `isDark` 声明移至 `fallbackBg`/`fallbackFg` 之前，修复 Temporal Dead Zone 导致的 ReferenceError
- **palette 回退兜底**：`generateSystem` 中 `palette[0]`/`palette[7]` 可能为 undefined，补充 `#1a1b26`/`#ffffff` 硬编码回退色值
- **Proxy 类型安全**：`theme.tsx` 中 Proxy getter 移除 `@ts-expect-error`，改用 `keyof Theme` 类型断言
- **resolveTheme 过滤补全**：`backgroundMessage` 加入初始过滤列表，避免重复解析

### [0.3.15] - 2026-06-03

#### 新增

- **MCP 懒加载**：启动时不连接 MCP server，第一次调用该 MCP 的 tool 时才按需连接，减少冷启动等待
- **MCP pending 状态**：侧边栏 MCP 面板显示"Waiting…"等待状态，启动时一目了然

#### 工作流

- **删除文件单独授权**：`apply_patch` 中 `type: "delete"` 的操作需额外弹窗确认，不再是编辑权限附带的
- **灵魂文件进仓库**：`Gsoul.md` / `Tsoul.md` 从上级目录移入 `.opencode/agents/`，git 跟踪推送，换机自动同步
- **全局 workspace（`.redcode/`）**：在项目上级创建全局共享目录，包含 AGENTS.md、MEMORY.md、USER.md、souls 等，所有项目共享身份与记忆，不再每项目重复搭建
- **`build.bat` 版本自检**：编译前自动跑 `check-version-consistency.ts`，版本不一致时阻止编译并提示
- **权限范围扩展**：`containsPath` 增加上级目录检查，信任与项目同级的兄弟项目

---

### [0.3.14] - 2026-06-03

#### 新增

- **MCP 配置热重载**：文件 watch `redcode.jsonc`，检测到 MCP 配置变更后自动添加/删除/重连服务器，无需重启 TUI
- **MCP 工具调用进度推送**：耗时较长的 MCP 工具调用（如 browser 截图）实时显示进度状态，避免无响应感

---

### [0.3.13] - 2026-06-03

#### 新增

- **消息视觉区分**：用户消息添加 `> ` 前缀（agent 色加粗），AI 消息添加 ✦ 前缀（accent 色）
- **语义色 `backgroundMessage`**：用户消息背景色独立于面板色，后续主题可单独定制

#### 修复

- **Browser MCP 端口冲突**：server 启动时自动检测 9001 端口，被僵尸进程占用时自动 kill 旧进程并重试

---

### [0.3.12] - 2026-06-03

#### 新增

- **MCP 健康监控**：每 30s 检查所有 connected 的 MCP server，连续 3 次失败标记断开并自动尝试重连
- **MCP 工具调用失败自动重连**：tool call 报错时自动尝试 reconnect 并重试（最多 3 次）
- **MCP Transport 日志**：记录实际使用的 transport 类型（stdio/SSE/HTTP），便于排查

---

### [0.3.11] - 2026-06-03

#### 修复

- **MCP 进程树泄漏（Windows）**：`descendants` 在 Win32 直接返回空数组，导致每次 TUI 退出时子进程（codegraph/typegraph/npx 链）变成僵尸堆积。改为 `taskkill /F /T /PID` 一次杀整棵树，Unix 保持原逻辑
- **Browser MCP 断连**：server `socket.on("close")` 无条件置 `ws = null`，导致新连接被旧 socket 的 close 事件覆盖破坏。改为 `if (ws === socket)` 条件判断
- **exe MCP 路径解析**：编译后的 exe 运行时 `cwd` 是 bin/ 目录，相对路径（`./browsermcp-server/index.js`）解析失败。新增 `findProjectRoot`，从 exe 所在目录向上查找 `redcode.jsonc` 或 `.git`，确保 MCP 命令路径正确解析
- **滚动条默认值迁移**：kv 存储中旧的 `scrollbar_visible: false` 会覆盖新默认值。新增一次性版本迁移（`kv_version`），首次启动时自动升级为 `true`

#### 变更

- **滚动条默认开启**：消息区域右侧滚动条默认显示，支持鼠标点击轨道跳转和拖拽滑块滚动。可通过 `session.toggle.scrollbar` 命令或 `/mcps` 切换
- **Browser MCP 扩展 v1.0.3**：改用 `chrome.alarms` 保活（每 24s 触发），替代不可靠的 `setTimeout`，解决 Manifest V3 service worker 休眠后断连

#### 配置

- `redcode.jsonc` 新增 browsermcp 配置
- `.opencode/opencode.jsonc` 新增 browsermcp 配置

#### 新增

- **Browser MCP 集成**：新增浏览器自动化 MCP 服务器，支持导航、截图、点击、输入、获取页面内容等操作，可让 AI 直接操控主人的浏览器
- **jCodeMunch MCP 集成**：新增结构化代码检索服务器（60+ 工具），支持精确符号获取、死代码检测、影响评估、编辑安全预检、AST 模式匹配等，比 grep 省 95% token
- **TypeGraph MCP 集成**：TypeScript 语义导航服务器（14 个工具），支持类型解析、调用链追踪、barrel 文件穿透、循环依赖检测

#### Browser MCP 使用方式

1. 安装 Chrome 扩展：
   - 打开 `chrome://extensions/`
   - 开启"开发者模式"
   - 点"加载已解压的扩展程序" → 选择项目内的 `browsermcp-extension` 目录（相对路径，跨电脑/盘符通用）
2. 点击扩展图标 → Connect（图标显示绿色 "ON" 表示连接成功）
3. 重启 TUI 生效

可用工具：`browser_navigate`、`browser_go_back`、`browser_go_forward`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_hover`、`browser_select_option`、`browser_press_key`、`browser_wait`、`browser_screenshot`、`browser_get_console_logs`

---

### [0.3.9] - 2026-06-02

#### 新增

- **Prompt 栏点击切换**：Agent 名称、模型名称、推理强度标签支持鼠标点击，直接弹出对应选择列表（DialogAgent/DialogModel/DialogVariant）
- **用户可配置快捷键**：`tui.json` / `tui.jsonc` 已完整支持 `keybinds` 字段覆盖默认快捷键，支持全局（`~/.config/redcode/tui.json`）、项目级、`.redcode/` 目录级配置，逐级合并覆盖

---

### [0.3.8] - 2026-06-02

#### 新增

- 动态终端标题：session 忙碌时标签栏显示 `▶` 前缀，空闲恢复；多 tab 终端一目了然
- 统一清理注册表：`CleanupRegistry` 集中管理所有退出清理（keymap、console 劫持、plugin runtime、audio），避免散落 `finally` 导致泄漏

#### 修复

- **构建流程修复**：Windows 上 `rm -rf` 因文件锁定失败不再中断编译，用 `try/catch` 安全跳过
- **版本号硬编码**：预览版不再生成 `0.0.0-dev-<timestamp>`，改用 `package.json` 中的真实版本号
- **Console 污染 TUI 渲染**：`console.log/warn/error` 在 TUI 启动后被劫持转入环形缓冲区（500 条），退出时还原，避免第三方库日志乱入终端

---

### [0.3.7] - 2026-06-01

#### 新增

- 记忆系统：新增每日日志 + 定期审视机制，被纠正时自动写入 `memory/YYMMDD.md`，收工时摘要合并到 MEMORY.md，确保教训跨会话持久

#### 修复

- **构建流程纠正**：TUI exe 编译改用 `bun run build -- --single`（`script/build.ts`），替代之前手拼 `bun build --compile` 的错误方式

---

### [0.3.6] - 2026-06-01

#### 新增

- 侧边栏 Context 区块充实：显示 provider 名、模型名、token 明细（输入/输出/推理/缓存）、消息数、agent 名、创建时间和最后活动时间；未知上下文上限显示 `?`，超过 200% 显示 `⚠` 警告
- Loading 动画替换：左下角蓝色方块 Knight Rider 动画改为 🐲🔥 喷火龙呼吸动画
- 右键粘贴：主输入框和对话框输入框支持右键粘贴剪贴板内容

### [0.3.5] - 2026-05-31

#### 新增

- prompt 输入框自适应 & 可配置高度：合并上游实现，文本框行数根据内容自动伸缩，支持用户配置最小/最大行数

#### 修复

- 行内 tool 行换行对齐：提取 `InlineToolRow` 组件，图标与文字使用 flex 布局，换行后文字正确对齐

### [0.3.4] - 2026-05-31

#### 新增

- Shell Mode：空提示框按 `!` 进入 Shell 模式，直接运行系统命令（通过 `session.shell` 而非发送消息），命令完成后自动退出 Shell 模式
- Session Switcher：新增 `$session.list` 命令和 `/sessions` 斜杠命令，打开会话切换对话框，支持按项目/状态过滤、消息预览和 diff 摘要

#### 修复

- Diff Viewer 改进：合并上游空白状态展示、交互优化、设计重设计等修复；修复文件树中已审查文件的勾选标记 Unicode 乱码
- 测试文件 import 路径修正：`diff-viewer.test.tsx` 中 `@opencode-ai` → `@redcode-ai`

### [0.3.3] - 2026-05-31

#### 修复

- compacted 会话 HTTP API 消息过滤：消息分页查询自动跳过 compaction summary 之前的旧消息，避免 GUI 加载大量旧消息导致 OOM/卡死。同时在 `packages/opencode` 侧生效，TUI 和 GUI 共享同一服务端
- 测试用例 import 补全：`db.test.ts` 补全 `it` 的 `bun:test` import，修复测试运行时引用错误

### [0.3.2] - 2026-05-30

#### 变更

- 统一数据库路径：移除 channel 分库逻辑（`redcode-dev.db` / `redcode-beta.db` 等），所有渠道统一使用 `redcode.db` 主库；删除 `disableChannelDb` 运行时标志
- 斜杠命令中文化：`/compact`→压缩会话、`/connect`→连接供应商、`/copy`→复制会话记录、`/export`→导出会话记录、`/fork`→分叉会话、`/init`→初始化 AGENTS.md、`/review`→审查变更

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## GUI

### [0.6.1] - 2026-06-15

> Plan 面板 + Kanban 看板 + CNY 官方定价 — 侧栏新增 Plan 标签实时追踪 todo 进度，主页新增看板视图按状态分列管理会话，DeepSeek/MiMo 计费改用官方人民币定价不再汇率换算。

#### 新增

- **Plan 面板（侧栏标签页）**：侧栏新增常驻 Plan 标签，展示当前会话完整 todo 计划——进度条 + 百分比 + 进行中/已完成/待处理统计 + 全列表（状态指示器：脉冲圆点=进行中、勾号=已完成、空心圆=待处理），空状态有引导提示（`session-plan-tab.tsx` + `session-side-panel.tsx` + `helpers.ts`）
- **Kanban 看板（主页视图切换）**：主页搜索栏右侧新增列表/看板切换按钮（`menu`/`grid-plus` 图标），看板三列：工作中（Spinner）/ 需关注（权限/错误/未读）/ 空闲，卡片显示会话标题+项目名+状态指示器（`home-kanban.tsx` + `home.tsx`）

#### 修复

- **DeepSeek/MiMo 计费改用官方 CNY 定价**：之前取 models.dev USD 值 ×7.2 换算，存在汇率过时（实际 6.76）和双重转换精度损失；现在 `models-dev.ts` + `provider.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），GUI 侧 `session-context-metrics.ts` 按 providerID 判断币种，`session-context-format.ts` CNY 直显/USD 按 6.76 换算
- **USD→CNY 汇率更新**：`session-context-format.ts` 汇率从 7.2 更正为 6.76（2026-06 实际汇率），TUI 侧 `sidebar/context.tsx` 同步更新

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室入口，从小宋界面一键进入，统一管理敏敏/小宋的所有 session。

#### 新增

- **RedCode Office 入口**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，全窗口展示办公室界面（`titlebar.tsx` + `icon.tsx`）
- **办公室布局适配**：`/chat` 路由自动切换 `items-stretch` 填满窗口，跳过常规 session 的圆角/边距样式（`layout.tsx`）
- **session 历史列表**：左侧 TUI/GUI/Group 三个联系人，点击展示对应 agent 的 session 列表，支持模型名称和时间显示（`pages/chat/index.tsx`）

#### 变更

- **移除跨会话感知注入**：随 TUI 侧 `recentSessionDigest` 移除，不再每轮注入 ~500 token 的 session 摘要（服务端变更）
- **包含服务端更新 TUI 0.6.0**：ChatRoom DB schema + Chat HTTP API + recentSessionDigest 移除。详见 TUI 0.6.0

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / UI 对齐小宋主题（毛玻璃/背景图/头像）/ 聊天室 ↔ agent 同步 / `@敏敏`/`@小宋` 路由

---

### [0.5.10] - 2026-06-13

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格调整——北京大妞豪爽直率、段子体质、容易害羞。工作行为与敏敏对齐（先查再做），人格差异只在语气。移除速度暗示，消除 soul 与工作纪律冲突
- **包含服务端更新 TUI 0.5.8**：缓存命中率修复（绝对时间戳）+ 提示词工具纪律强化 + memory 追加模式 + 系统提示词瘦身。详见 TUI 0.5.8

- **成本显示 USD→CNY 汇率换算**：`session-context-format.ts` 将 API 返回的 USD 成本按汇率 7.2 换算为人民币显示，而非直接改货币符号
- **Token 统计聚合全会话**：`session-context-metrics.ts` 累计所有 assistant 消息的 token 数据（input/output/reasoning/cache），而非仅取最后一条
- **Session digest 缓存**：`instruction.ts`（TUI）首次计算 `recentSessionDigest()` 后缓存，避免每轮重算导致系统提示变化 → DeepSeek prefix cache 失效

### [0.5.9] - 2026-06-12

#### 修复

- **DeepSeek / MiMo 成本少算缓存未命中（硬编码修复）**：models.dev 远程 API 中 DeepSeek 和 Xiaomi MiMo 所有模型的 `cache_write` 均为 null（→ 0），而这两家没有独立 cache write 价格（缓存未命中 = input 原价）。代码中 `adjustedInput = totalInput - cacheRead - cacheWrite` 把未命中 token 全部分配到 `cache.write` 计费项，但 `cache.write = 0` 导致这些 token **完全不收费**（如 600 miss + 400 hit 场景：实收 $0.00112，应为 $0.0851，差 76 倍）。在 `packages/core/src/plugin/models-dev.ts` 中硬编码 DeepSeek 和 Xiaomi 的自定义 provider 的 `cache.write` = `input`。不影响 Anthropic/OpenAI 等有独立 cache write 价格的 provider（`packages/core/src/plugin/models-dev.ts`）

### [0.5.8] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.2**：token-compressor 插件重写（消除流式中断）+ DCP 恢复（去重/compress/nudge）+ engine compaction.threshold 兜底。详见 TUI 0.5.2

### [0.5.7] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.1**：ast-grep lazy load / plugin undefined hook guard / provider null guard，修复 sidecar 启动后 provider.list 返回 500、模型列表为空、项目加载失败的问题

### [0.5.6] - 2026-06-11

#### 修复

- **缓存命中率二次修正（GUI 侧）**：同 TUI 0.5.0，`session-context-metrics.ts` 的公式从 `read/(read+write)` 改回 `read/(input+read+write)`，与 DeepSeek 平台数字对齐（`session-context-metrics.ts`）

#### 新增
- **代码审查技能（ce-code-review）**：移植自 EveryInc/compound-engineering-plugin（20.9k stars），14 个人格化审查员，onfidence-gated 去重流水线，P0-P3 严重性分级 + autofix 分类，双模式（交互式自动修复 / mode:agent 仅报告）
- **opencode-snip 插件**：自动为 git/npm/docker 等命令输出加 snip 前缀，过滤冗余输出，减少 60-90% token 消耗
- **local-stats 本地编码统计插件**：纯本地编码活动追踪，记录每次 edit/write/read 调用，统计文件变更行数，按天存 JSON 到 `.redcode/stats/`，无需外部 API

#### 修复
- **DCP 插件配置恢复**：.opencode/redcode.home.jsonc 源模板补回 plugin 字段，修复 build 后 DCP 插件丢失问题

#### 变更
- **移除 /deepwork 引用**：goal-automation skill 中删除未实现的 /deepwork 手动模式段落
- **技能打磨**：goal-automation / simplify / diagnose 三个技能修复编码损坏，simplify 新增 RedCode 工具链提示
### [0.5.5] - 2026-06-11

#### 新增

- **包含服务端更新（TUI 0.4.15）**：双层记忆系统（项目级+全局回退）、新项目自动初始化 `.redcode/`、Soul 自动注入（GUI 模式自动加载小宋人格，无需手动 `/gui-persona`）、AGENTS.md 重写、Soul 模板瘦身

#### 修复

- **缓存命中率计算修正**：分母 `input + cache.read + cache.write` 重复计入导致永远 ~99%→改为 `cache.read + cache.write`，保留一位小数（`session-context-metrics.ts`）

### [0.5.4] - 2026-06-10

#### 新增

- **全局插件配置**（`~/.redcode/redcode.jsonc`）：新增 `plugin` 字段，将 ecc-shell-stub.js 和 @tarquinen/opencode-dcp 配置为全局插件，切换工作区时不再丢失。解决了之前只在 RedCode 项目目录下才能使用完整插件集的问题。

#### 变更

- **ecc-shell-stub.js** 复制到 `~/.redcode/plugin/` 目录，作为全局 ECC 三件套（memory-automation / guardrail-profiles / defensive-agent）
- **@tarquinen/opencode-dcp** 通过 npm 全局安装（v3.1.12），提供动态上下文裁剪功能

 #### 修复
 
 - **缓存 token 分母为 0 问题**：`session-context-tab.tsx` 中 cacheTokens 的 `read / write` 显示在 write=0 时展示 `168,704 / 0` 看起来像除法 bug。改为按缓存命中率展示：`read / write (XX%)`，write=0 时只显示 `read (XX%)`，无缓存活动时 `—`。命中率计算公式 `cacheRead / (input + cacheRead + cacheWrite)`，取自 TUI 已有实现（`prompt/index.tsx:338`）
 
#### 构建说明

```bash
npm install -g @tarquinen/opencode-dcp
```

### [0.5.3] - 2026-06-10

#### 清理

- **layout.tsx 复杂度拆分**：1514 行单文件拆为三个模块：预取系统（247 行，`layout/prefetch.ts`）和通知弹窗（120 行，`layout/notification-toasts.ts`），主组件减至 ~1150 行（-24%）。预取系统为纯逻辑函数+createEffect hook，零 JSX 零信号耦合，可独立测试。

### [0.5.2] - 2026-06-10

#### 清理

- **包含服务端提示词更新（TUI 0.4.13）**：GUI 以 opencode 为本地 sidecar，提示词在服务端选取并对两端生效；本版随打包吃到「移除 CodeGraph 死引用」的提示词清理，详见 TUI 0.4.13。

### [0.5.1] - 2026-06-10

#### 改进

- **Edit 工具模糊搜索反馈**：`oldString` 精确匹配失败时，自动用 Levenshtein 滑动窗口搜索最接近的匹配块，返回相似度百分比、匹配文本、行号和字符级 diff，帮助 LLM 快速定位并修正 oldString（`packages/opencode/src/tool/edit.ts` 新增 `fuzzyFindBestMatch` / `similarityRatio` / `charDiff`，`edit.txt` 提示词同步更新）

### [0.5.0] - 2026-06-10

#### 新增

- **全界面毛玻璃质感**：原仅作用于聊天气泡/输入框的毛玻璃（背景图局限在聊天面板），升级为整窗磨砂。背景图从聊天面板（`session.tsx`）上移到根布局（`layout.tsx`）整窗铺底，根 `<div>` 按当前视图背景图打 `data-app-frost` 标记；标题栏（`titlebar.tsx` header）与主卡片（`layout.tsx` main）加 `data-frost-surface` 改半透明材质 + `backdrop-filter: blur(18px)` 透出并模糊整窗壁纸；内部各栏（文件栏 `#file-tree-panel`、审查栏 `#review-panel`、聊天栏）去实色底，统一显露主卡片这层磨砂材质，形成全界面一致的磨砂玻璃观感。标题栏/主卡片加 `relative z-[1]` 压在背景图（`absolute z-0`）之上。未设背景图时 `data-app-frost` 不触发，维持原实色界面（`index.css` 新增 `[data-app-frost]` 规则，不入 @layer 以越过 Tailwind utilities 覆盖 `bg-*`）
- **主界面/聊天背景图分离**：新增独立的「主界面背景图」设置（`settings.appearance.homeBackground`），与聊天背景图分开管理，设置页（`settings-general.tsx`）并排放「Home Background / Chat Background」两个上传项。整窗背景按视图分流（`layout.tsx` 的 `appBackground()`）：进会话（`params.id`）用聊天背景图，首页/无会话用主界面背景图——解决主界面满屏壁纸在公司场景尴尬的问题，可单独把主界面背景留空或换中性图
- **修复·会话页毛玻璃失效**：会话页根容器（`session.tsx`）原写死 `bg-background-base` 实色，盖住主卡片磨砂层，进会话后毛玻璃消失；改为设了聊天背景图时去实色底（`classList` 条件化），露出整窗壁纸；同步把审查栏标签条 `bg-background-stronger` 也纳入去底清单
- **状态弹层下沉为审查面板标签页（方案 A）**：标题栏服务器/MCP/LSP/插件状态弹层移入右侧审查面板，变成常驻「状态」标签页。标题栏保留健康圆点作指示器，点击直接打开右侧面板的状态标签（`titlebar.tsx` 的 `openStatusTab` 经 `useLayout()` + sessionKey 打开并激活 `status` 标签）；首页/无会话时回退为原弹层（`status-popover.tsx` 用响应式 `<Show>` 在按钮态/弹层态间切换）。`StatusPopoverBody` 抽出 `fill` 入参以适配面板宽度（去弹层专用阴影/圆角）；`status` 标签在 `helpers.ts` 排除于文件标签之外、`activeTab` memo 特判常驻；新增 i18n `session.tab.status`（状态/Status/狀態）

#### 布局调整

- **毛玻璃满贴标题栏（去"镶嵌感"）**：设了背景图时主卡片（`layout.tsx` main）去掉 `m-2`/圆角/阴影外框，磨砂层满贴标题栏边到边，不再像「在主界面里镶嵌进去的一块玻璃」；未设背景图时维持原卡片样式
- **会话页亮暗互换（两侧暗、中间亮）**：原文件栏/审查栏全透显得过亮、聊天区 `0.62` 暗罩显得过暗，层次割裂。改为文件栏 `#file-tree-panel`、审查栏 `#review-panel` 走更深的磨砂底（`bg-deep 72%` + `blur(18px)`）当暗色外壳——审查栏因此也有了可见的磨砂变化（不再「没变化」）；聊天区暗罩从 `rgba(0,0,0,0.62)` 降到 `0.3`（`session.tsx`），成为更亮的焦点区（`index.css` `[data-app-frost]` 规则、`session.tsx` 遮罩）
- **首页项目栏分割线**：首页项目栏 `<aside>`（`home.tsx`）加 `lg:border-r`，与右侧会话列表区之间划出竖向分割线，视觉层次更清晰

### [0.4.7] - 2026-06-10

#### 新增

- **包含服务端更新**：随 sidecar 吃到 TUI 0.4.10 的服务端能力——`task` 工具 `isolation:"worktree"` 子代理隔离（子代理在独立 git worktree 中运行，文件改动不触碰父工作区）+ worktree 分支前缀品牌归一 `opencode/`→`redcode/`。GUI 侧无界面改动，重新 build+package 后 sidecar 即生效

### [0.4.6] - 2026-06-09

#### 修复

- **对话页右上角 MCP 状态恒"未配置 MCPs"（根治·读取端）**：TUI 同引擎同配置可见 9 个 MCP 全连，GUI 对话页却永远"未配置"。病根在 `@tanstack/solid-query` 的 `useQueries` 批量 observer——其中一条 query 的 `enabled` 在运行时 `false→true` 翻转时，既不自动 fetch（observer 卡在 `status=pending, fetchStatus=idle`），也不把外部 `fetchQuery` 灌入的缓存暴露给 SolidJS store 的 getter，导致 `sync.data.mcp` 恒读成 `{}`。先前在 `server-sync.tsx` 加 `queryClient.fetchQuery` 主动预热缓存只修了触发端，读取端仍被同一 bug 卡住。**根治**：把 MCP 这条从 `useQueries` 批量里单拎出来成独立 `useQuery`，独立 observer 的 reactive `enabled` 翻转能正确触发并反应缓存；仍只连"当前进入的项目"，首页其它项目不连，N×M spawn 风暴防护不变（`child-store.ts` 拆 `useQuery`、`server-sync.tsx` 缓存预热 effect 保留兜底、`titlebar.tsx`/`session.tsx` 用 `routeDir`/`decodeDirectory` 把 statusDir 与 activeMcpDir 对齐到同一项目 store）
- **MCP 子进程泄漏致渲染进程 OOM 白屏（第一段·杀树机制）**：sidecar spawn 的 MCP 孙进程不在任何 job 里，sidecar 一旦被掐死就成孤儿，堆积打满 Windows commit charge（如 38.8/40.8GB）→ 渲染进程报 `oom`（exitCode -536870904）间歇白屏。引擎侧 `mcp/index.ts` 的 `killProcessTree`（`taskkill /F /T`）本身没错，但三条路径让它没机会跑：① dev 热重启（electron-vite 掐主进程，`before-quit`/`will-quit` 不触发、优雅 stop 来不及）② stop 超时回退 `child.kill()` 只杀 sidecar 不级联 ③ sidecar `process.exit(1)` 崩溃 finalizer 不跑。**主进程兜底按 sidecar PID 杀整树**：`server.ts` 导出 `killSidecarTree`/`killSidecarTreeSync`（Windows `taskkill /F /T /PID`，趁 sidecar 还活着才杀得动孙进程），stop 超时回退与启动失败回退改杀整树；`index.ts` 记 `sidecarPid` 并装 `process.on('exit'/'SIGINT'/'SIGTERM')` 同步兜底（覆盖 dev 热重启——electron-vite 发的是 SIGTERM/SIGINT 能捕获）。覆盖 dev 重启/退出/超时/崩溃全路径，纯 SIGKILL 除外（需 Windows Job Object，未引原生依赖）。**注**：此段只解决“何时、对谁发杀树指令”，实测仅杀得动 `["node",…]` 直起的 MCP（browsermcp/web-search）；`npx` 包装的仍漏，见下段
- **MCP 子进程泄漏（第二段·npx 包装脱离·实测确认并修）**：实测开关一轮 GUI 后，直起 node 的 MCP 全清，`npx tsx`/`npx -y @…` 的留 11 个孤儿（node+tsserver）。根因 = Windows 上 cross-spawn 给 npx 套 `cmd /c` shim，shim 启完真 node 立即退出 → 真正的 node 子树**脱离** `client.transport.pid`（PPID 指向已死的 wrapper），既不在 sidecar 进程树内、也不被按 transport.pid 的 `taskkill /T` 命中。**修法 = MCP 命令改 node 直起插件本地 tsx**：typegraph 由 `["npx","tsx","./plugins/typegraph-mcp/server.ts"]` 改为 `["node","./plugins/typegraph-mcp/node_modules/tsx/dist/cli.mjs","./plugins/typegraph-mcp/server.ts"]`，transport.pid 落在活的、sidecar 直属的 node 上，`taskkill /F /T` 贯穿整树（node cli.mjs → node tsx server.ts → tsserver.js）。`.opencode/redcode.home.jsonc` + `~/.redcode/redcode.jsonc` 两处同改。**实测验证**：启动→连接→优雅关闭，node 24→0，零孤儿
- **typegraph-mcp 精简 14→3 工具 + 删 codegraph（服务端配置/插件）**：jcodemunch 已覆盖导航与图查询（references/cycles/coupling/blast-radius），typegraph 唯一不可替代的是 tsserver 类型精度，故只保留 `ts_definition`/`ts_type_info`/`ts_module_exports`，移除其余 11 工具 + oxc 图子系统（`server.ts` 删 `buildGraph`/`startWatcher`/`graph-queries` 引用，改 `createResolver`-only + 极简 `fs.watch` 调 `reloadOpenFile`/`closeFile` 保 tsserver 新鲜）。codegraph（早被 jcodemunch 完全覆盖、此前误留 `enabled:true` 仍在 spawn 泄漏）整块删除。两处配置同改，typecheck 通过

#### 布局调整

- **聊天背景遮罩加深 0.4→0.62**：实测 `rgba(0,0,0,0.4)` 仍偏亮压不住文字，加深半透明遮罩保证对话可读（`session.tsx`）

### [0.4.5] - 2026-06-08

#### 新增

- **微信风聊天背景图**：设置页「外观」新增「Chat Background」行，可上传图片（PNG/JPEG/WebP/GIF）作为聊天窗口背景，全局生效、所有会话共用。复用头像的 `FileReader`→dataURL→持久化设置模式，存入 `settings.v3` 的 `appearance.chatBackground`。渲染层在 `session.tsx` 聊天面板容器内加一层 `absolute inset-0 z-0` 背景层（`bg-cover bg-center`），消息内容 `z-[1]` 自然浮于其上；消息气泡保留自身底色，背景图在气泡间隙透出，呈微信聊天背景效果（`context/settings.tsx` 增字段+getter/setter、`settings-general.tsx` 上传 UI、`session.tsx` 背景层、`MessageTimeline` 滚动容器本就透明无需改）

#### 修复

- **仓鼠加载动画浅色主题被洗白**：`message-timeline.tsx` 的 `TimelineThinkingRow` 原用 `mix-blend-mode: screen` + 深色盒衬底显示仓鼠 PNG，在浅色/护眼配色下 screen 混合把图洗成近乎全白不可见。`hamster.png` 本就是透明底 RGBA（colortype 6），深色盒与混合模式纯属多余。改法：去掉外层深色盒与 `mix-blend-mode`，透明 PNG 直接平铺，任意主题下均正常显示（`message-timeline.tsx:159`）

#### 清理

- **删除 V2 三栏重构遗留的 V1 侧边栏死代码**：`04a5a1045`（6 月 2 日）将布局从 V1 单栏 rail-sidebar 重构为 V2「文件树｜聊天｜审查」三栏后，丢弃了 V1 侧边栏渲染但留下大量从不挂载的脚手架。本次彻底清理：删除 5 个孤儿文件（`layout/sidebar-{shell,project,workspace,items}.tsx` + `layout/inline-editor.tsx`）；`layout.tsx` 移除级联死代码约 886 行（`SidebarPanel`、workspace/project 两个 context、项目 rail 拖拽 handler、`rename{Session,Project,Workspace}`、`removeProject`、`showEditProjectDialog`、`delete|resetWorkspace`、`DialogDelete|ResetWorkspace`、`closeProject`、`workspaceName`、`workspaceLabel`、`hoverProjectData`、peek 悬停机制、`providers`/`location`/`isBusy`/`sortNow`/`side`/`panel` 等未用声明）。合计净删约 2300 行。`layout.tsx` 内 `return` 前加 `260608` 回滚注释，列明全部删除项，便于按提交回退。typecheck 全绿、`oxlint` 无未用变量
- **公开库个人痕迹清理（续）**：配合「公开库通用化、个人配置迁私有库」的双仓方向，扫掉 `.opencode/skill/diagnose` 与 `vision-autoagent` 两个技能提示词里残留的「哥哥」→「用户」（沿用 souls/persona 早先通用化的同款先例）。公开库现状：souls 为通用人格（非特定人设）、memory 为空、skill/command 无个人称呼——新人克隆即得干净可用的完整项目，零个人痕迹；个人 souls、记忆、画像、每日日记统归私有 `RedCode-private` 仓，两台机器经其 `pull/push` 同步。CHANGELOG 历史条目内出现的旧称呼按「客观记录」原则保留不改

### [0.4.4] - 2026-06-06

#### 新增

- **错误兜底 P1 — Retry UI**：提交消息失败时，composer 底部显示错误横幅（包含可读错误信息 + Retry 按钮 + 关闭按钮）。用户编辑输入或发送成功时自动清除。`restoreInput()` 已在 0.4.2 确保输入文本保留，此版在保留基础上增加可视化反馈和重试入口（`prompt-input/submit.ts` + `prompt-input.tsx`）
- **Session 标签状态指示器**：标题栏会话标签页新增状态指示点——`busy` 时显示黄色脉冲点、`retry` 时显示红色点。通过 `sync.data.session_status` 驱动，实时的会话运行状态一目了然（`titlebar.tsx`）

### [0.4.3] - 2026-06-06

#### 新增

- **三款新配色方案**：护眼绿（Eye Green）、米黄（Cream）、深蓝（Deep Blue）三种全新配色方案，与主题完全独立。原 ColorScheme 类型从 `"light" | "dark" | "system"` 扩展为 6 种，`data-color-scheme` 属性驱动 CSS 变量覆盖。亮色变体（cream/green）复用 light 主题变体，深色变体（deepblue）复用 dark 主题变体，各配色独立覆盖背景/文字/图标色值。**v2 主题系统（composer / 新组件）+ 老主题系统（文件树/聊天/审查面板）双套令牌均覆盖**——后者在 `packages/ui/src/styles/theme.css` 内增加对应 `[data-color-scheme="..."]` 块，盖过 OS 自动 dark 切换，避免主面板仍是白底。设置页「外观→配色方案」下拉菜单可选用。涉及 5 个核心文件（`context.tsx` 类型 + resolveMode / 两份 `theme.css` 色值 / `theme-constants.ts` / `settings-general.tsx` 选项 / i18n 中文英文繁体翻译）

#### 优化

- **ResizeHandle 可见化**：拖拽分割条新增 `background: var(--border-weaker-base)`，hover 时不再透明不可见（`resize-handle.css`）
- **标题栏底部视觉分隔**：标题栏新增 `border-b border-border-weaker-base`，与内容区建立层次（`titlebar.tsx`）
- **消息轮次淡入动画**：`@keyframes turn-fade-in` 动画让每条消息从 `opacity: 0 translateY(4px)` 淡入（`session-turn.css`）

### [0.4.2] - 2026-06-06

#### 修复

- **bootstrapDirectory 未执行导致输入框卡死（#3）**：`child-store.ts` 的 `status` 硬编码 `"complete"`，`child()` 中 `status === "loading"` 的 bootstrap 触发条件永不为真；`"server.connected"` 事件路径可能在 GUI 启动时跳过（空 `children` 或 `recent` 守卫）。`agent_ready` 永远 `false` → 统一就绪 gate 卡死 → 输入框无法发送。修复：在 `ensureChild()` 新建 child store 后直接调用 `onBootstrap(directory)`，不依赖事件或 status 检查（`child-store.ts:274-277`）
- **"请选择智能体和模型" 误弹 toast（第 6 次复发 · 根治）**：彻底定位结构性病根并收敛。submit 依赖 providers / models / **agent** 三个异步信号，但 agent 列表由 `bootstrap.ts` 的 **slow 批次** fire-and-forget 填充、**从无就绪标志**（不像 provider 有 `provider_ready`），导致 `agent: []` 空窗期内 `agent.current()` 兜底失败返回 null → 弹 toast。历次修复（0.3.16 加 submit ready、0.3.17 加 child-store fallback、0.4.1 改 `||→&&`）都只补当时暴露的那条腿，agent 这条从未被挡，故每逢单数版本改 render 路径（扰动 SolidJS 挂载时序、放大 race window）必复发。**根治三步**：① `types.ts`/`child-store.ts` 新增 `agent_ready` 字段，`bootstrap.ts` 在 agent 加载完成的 `.then` 里置真；② `local.tsx` 新增统一就绪 gate `ready() = providers.ready() && model.ready() && sync.data.agent_ready`，三信号收敛到一处，将来新增异步依赖只在此补条件、不再散落漏挡；③ `submit.ts` 改用 `local.ready()`，加载中静默返回（该 toast 历次误弹的唯一根因），仅当 gate 通过仍为 null（真·无 provider 配置）才提示。删除 submit 中已无用的 `useProviders` 依赖

### [0.4.1] - 2026-06-05

#### 新增

- **用户/助手头像系统**：`settings.tsx` 新增 `userProfile` + `assistantProfile` 字段（各含 `avatar` + `displayName`），支持 base64 图片上传。用户消息气泡旁显示自定义头像（`message-part.tsx`），助手消息显示可配置头像（`message-timeline.tsx`）。`avatar.tsx` 新增 `medium` 尺寸（2.5rem），聊天头像统一使用
- **用户消息气泡美化**：气泡内边距 8px → 10px 上下/14px 左右，圆角 6px → 10px 10px 4px 10px（右下角更锐），新增 `body-row` 弹性容器 avatar 与内容并排（`message-part.css`）
- **设置页用户资料 + 助手头像区**：`settings-general.tsx` `ProfileSection` 包含显示名输入框、用户头像上传/预览/移除；新增 `Assistant Avatar` 区，支持助手头像独立上传
- **web-search Google 兜底**：DuckDuckGo + Yahoo 后新增 Google 搜索 fallback，系统代理自动补 `http://` 前缀

#### 修复

- **"请选择智能体和模型" 误弹 toast**（第 5 次复发）：`providers.ready()` 用 `||` 判断 `all.size > 0 || connected.length > 0`，数据加载初期 `all` 先到即返回 true，但 `connected` 还空时 `defaultModel()` 返回 null，导致 submit guard 误判并弹 toast。改为 `&&`，要求 `all` 和 `connected` 都加载完才算 ready。**规律**：单数版本（0.3.16→0.3.17→0.4.1）每次改 `submit.ts` / `message-timeline.tsx` 等渲染路径时触发，修改渲染/消息组件后必须走完整数据流验证（`use-providers.ts:36`）
- **思考中仓鼠浅色模式黑标**：`/hamster.png` 透明 PNG 在浅色主题下黑色锯齿边缘可见。包裹 `background: var(--surface-base)` 容器 + `mix-blend-mode: screen` 消除黑色边缘（`message-timeline.tsx:171-178`）

#### 优化

- **`session.tsx` 拆分**：1667 行 `Page()` 函数抽出 4 个独立模块——`session-history-loader.ts`（历史加载）、`session-review-diff.ts`（Review diff 滚动）、`session-message-nav.ts`（消息导航/光标）、`session-keyboard.ts`（键盘快捷键）。主文件 1623 行，各模块面向入参不耦合闭包
- **avatar 组件新增 medium 尺寸**：2.5rem（40px），聊天头像专用，小号 2 倍

### [0.4.0] - 2026-06-04

#### 新增

- **目标自动化（goal-automation）**：本版本立项，TUI/GUI 两端共享
  - **`/goal` 斜杠命令**（`.opencode/command/goal.md`，`sync-home.bat` 同步到 `~/.redcode/command/`）：用户在 TUI 或 GUI 里 `/goal <text>` 钉住当前会话目标，agent 围着目标转、不会跑题；`/goal clear` 清掉、`/goal done` 标完成。命令 YAML `model: kimi-k2.5` 轻量模型执行
  - **`goal-automation` skill**（`.opencode/skill/goal-automation/SKILL.md`）：agent 看到大任务时主动建议一次，**不自动钉**——主动权在用户手上。触发条件（3+ 轮、跨多文件、含修/实现/重构等词、出现 done 标志，三选二即建议），不刷屏、不在 flow 时打断
  - **`opencode.jsonc` 挂载**：instructions 数组新增 `./.opencode/skill/goal-automation/SKILL.md`，TUI/GUI 两端自动加载
  - **GUI 人格内化**：Gsoul.md 加协作模式段，承认 /goal /deepwork + goal-automation，主动权归用户
- **GUI 承认 ECC 启发三件套**：Gsoul.md 加"ECC 启发三件套"段——`memory-automation` / `guardrail-profiles` / `defensive-agent` 走自动挂载机制，GUI 同享，不需额外配置

#### 推迟到 0.4.1

- **GUI 端 `/goal` chip 顶部指示器**：原计划在 Titlebar 加 chip 让用户可见当前钉住的目标。砍掉原因：数据流未设计清楚（layout.tsx 跨层读 chat 状态、OpenCode command 系统不顺、IPC 改造成本大），为假想需求硬写不划算。0.4.1 补，先想清楚数据流（备选：command 系统改造 / 新建 cross-layer store / 走 plugin 通道）

#### 变更

- 版本号升级 0.3.17 → 0.4.0

### [0.3.17] - 2026-06-04

#### 修复

- **标题栏版本号写死漂移**：`index.html` 标题栏徽章原本硬编码 `v0.3.16`，每次升级要手动改、极易漏改 → 编译出的 exe 显示旧版本。改为占位符 `v__RC_VERSION__`，`electron.vite.config.ts` 新增 `redcode:inject-version` 插件（`transformIndexHtml`），build/dev 时从 `package.json` 自动注入。GUI 自此与 TUI 一致：`package.json` 为唯一版本来源
- **桌面通知图标请求死域名**：`index.tsx` `notify()` 的通知图标硬连 `https://redcode.dev/favicon-96x96-v3.png`，该域名未注册 → 每次弹通知 DNS 解析失败、控制台刷 `ERR_NAME_NOT_RESOLVED`。改为基于 `document.baseURI` 解析本地打包图标，不再发外网请求
- **思考中仓鼠 emoji 跨平台渲染**：Win10 渲染正常（Segoe UI Emoji 多色渐变），Win11 渲染为 Fluent 扁平纯色块。将 🐹 emoji 替换为本地仓鼠图片（`/hamster.png`），彻底消除系统 emoji 字体差异

#### 构建说明

- `check-version-consistency.ts` 标题栏徽章检测兼容 `__RC_VERSION__` 占位符（视为恒一致，因构建期自动同步）

### [0.3.16] - 2026-06-04

#### 修复

- **`build-and-package.bat` 同步目标遗留**：打包脚本仍往旧目录同步 souls/MEMORY/AGENTS，导致配置迁移到 C 盘后两处残留。改为 `%USERPROFILE%\.redcode`，与 TUI `build.bat` 对齐

#### 变更

- **同步全局配置目录迁移**：GUI 以 opencode 为 sidecar，随服务端一并吃到 `~/.redcode` 迁移与全局记忆机制化注入
- 版本号升级 0.3.15 → 0.3.16

### [0.3.15] - 2026-06-03

#### 新增

- **ECC 插件状态指示器**：标题栏版本号旁显示绿色 `ECC` 标签，一眼确认插件已加载
- **压缩策略优化**：`experimental.session.compacting` 扩展 prompt，保留任务进度、错误信息、测试结果等关键上下文

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle 新增 `invert` 属性，左移审视变宽、右移变窄

#### 变更

- 版本号升级 0.3.14 → 0.3.15

### [0.3.14] - 2026-06-03

#### 新增

- **ECC Plugin 集成**：`.opencode/plugins/ecc-shell-stub.js` 自动加载，提供以下功能：
  - `shell.env` — 注入 ECC 环境变量
  - `tool.execute.after` — 自动跟踪文件变更
  - `experimental.session.compacting` — 上下文压缩时保留关键上下文
  - `permission.ask` — 自动放行读/格式化/测试等安全操作
  - `changed-files` tool — 查看当前会话改过的文件
  - `git-summary` tool — 一条命令返回分支/状态/log/diff

#### 变更

- 版本号升级 0.3.13 → 0.3.14

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle `edge` 默认 `"end"` 导致拖拽方向与直觉相反。改为 `edge="start"`，左移变宽、右移变窄
- **browsermcp-server 端口冲突无法恢复**：ESM 模块内使用 `require("child_process")` 导致端口被占时 kill 逻辑报错。改为顶层 `import` 修复

#### 工作流

- **版本一致性自检脚本**：新增 `script/check-version-consistency.ts`，编译前自动扫描 package.json/README/CHANGELOG/标题栏版本号是否对齐
- **build-and-package.bat 自动检查**：编译前跑版本自检 + 自动同步灵魂文件到上级目录供其他项目使用
- **全局 workspace（`.redcode/`）**：AGENTS.md/MEMORY.md/USER.md/souls 移至全局目录，所有项目共享身份与记忆，build bat 自动同步

### [0.3.13] - 2026-06-02

#### 修复

- **仓鼠位置修复**：将 🐹 从 flex `ml-auto`（最右）移到 TextShimmer"思考中"之后。当 AI 产生 reasoning heading（如 markdown 标题）时，`TextReveal` 展开不再把仓鼠推到右侧角落

#### 重构

- **抽取 `UpdateAvailableToast`**：将文件末尾的 32 行子组件移到 `components/update-available-toast.tsx`，零行为变化
- **抽取主题常量**：`colorSchemeOrder` / `colorSchemeKey` 纯常量从 `layout.tsx` 抽到 `pages/layout/theme-constants.ts`

#### 布局调整

- **FileTree → 最左、Review → 最右**：新布局为三栏：`[FileTree] [Chat] [Review]`
  - `FileTreePanel` 从 `SessionSidePanel` 内部分离为独立组件 `pages/session/file-tree-panel.tsx`
  - `session.tsx` 主 flex 容器改为：`<FileTreePanel />` → `<ChatPanel />` → `<SessionSidePanel />`
- **删除 V1 sidebar fallback**：`layout.tsx` V1 旧设计（152 行无引用代码）移除，`USE_NEW_DESIGN` 常量删除
- **删除 `sidebar.toggle` 命令**：V2 设计下 Sidebar 永不显示，对应 Cmd+B 命令移除

### [0.3.12] - 2026-06-02

#### 新增

- **思考中仓鼠动画**：在 AI 思考状态行的右侧加 🐹 emoji，左右小跑 + 上下跳动，1.2s 循环（与左侧 Mona 猫猫 gif 配合，更可爱）
- **Sidebar 展开/折叠过渡动画**：`sidebar-shell.tsx` 的 panel 容器加 `transition-opacity duration-150`，展开/折叠时内容平滑淡入淡出
- **Cmd+1 ~ Cmd+9 切项目快捷键（V2 设计补全）**：`layout.tsx` 移除 `!USE_NEW_DESIGN` 条件限制，V2 设计也支持 `Cmd+1` ~ `Cmd+9` 切换项目；修复 title bug 用 i18n `command.project.index`
- **Cmd+T 切下一个会话 / Cmd+Shift+T 切上一个会话**：在 `use-session-commands.tsx` 添加 `session.next` / `session.previous` 命令，按当前 project 内的 root session 排序（recent 在前）切到下一个/上一个

#### 优化

- **Sidebar 列表 hover 体验**：原本 hover 时只显示 archive 按钮；现在 archive 按钮的 `transition-[width,opacity]` 过渡更平滑

---

### [0.3.11] - 2026-06-02

#### 新增

- **设计系统 token**：CSS 变量化同心圆角（`--radius-xs/sm/md/lg/xl/2xl`）、分层阴影 5 级（`--shadow-xs/sm/md/lg/xl`，每级双层偏移），全局统一
- **文字排版优化**：`h1-h4` 启用 `text-wrap: balance`，段落启用 `text-wrap: pretty`，标题更整齐，段落不孤字
- **统一 focus 指示器**：所有可聚焦元素通过 `:focus-visible` 显示 2px outline + 2px offset，键盘可访问性提升
- **Sidebar 折疉态项目指示器增强**：通知红点放大到 8px、加 ring 描边、permission/error 状态加 `animate-pulse` 脉冲动画；unseen 数量徽章（>1 显示数字，>9 显示 "9+"）；working spinner 加 ring 描边

---

### [0.3.10] - 2026-06-02

#### 新增

- **V2 Titlebar 全量启用**：Tab 式 session 管理上线，支持 `Cmd+W` 关闭 tab、`Cmd+Option+←/→` 切换 tab、项目头像 + 标题显示；右侧集成 StatusPopover（token 用量）和 Update pill
- **Loading 窗口动画**：Logo 呼吸脉冲动画、内容区域淡入、进度条平滑过渡，启动体验更流畅
- **Home 搜索快捷键**：`Cmd+K` / `Ctrl+K` 一键聚焦搜索框，搜索框右侧显示快捷键提示
- **Home 空状态优化**：无 session 时显示大图标 + 标题 + 描述 + "New Session" 按钮，替代原来的一行文字

#### 清理

- 移除 9 处 `VITE_REDCODE_CHANNEL` feature flags，所有 V2 功能（Titlebar、Layout、Session Design、Prompt Input）在生产环境统一启用
- 移除已废弃的 `DesktopTitlebarIconButton` 空组件
- 简化 session-side-panel、session-header、settings-general 中的 beta 门控逻辑

---

### [0.3.9] - 2026-06-01

#### 新增

- **图标重制**：`gen-icon.py` 从 `Red.ico` 源图生成全尺寸图标，支持 16~1024px 多分辨率 ICO，修复文件资源管理器/任务栏图标模糊问题
- 图标渠道同步：dev/beta/prod 三渠道 `icon.ico` 统一使用 `Red.ico`

---

### [0.3.8] - 2026-06-01

#### 新增

- TypeGraph MCP 集成：新增 `typegraph-mcp` 代码语义导航服务器（14 个工具），支持类型解析、调用链追踪、影响分析、循环依赖检测等，与现有 CodeGraph 互补

#### 修复

- 会话模型/智能体选择修复：`submit.ts` 将 ready 检查移到取值之前，同时检查 `providers.ready()` 和 `models.ready()`，避免 provider 已加载但 localStorage 持久化数据未就绪时误弹"请选择智能体和模型"toast
- Windows 打包签名挂起：`electron-builder.config.ts` 的 `afterAllArtifactBuild` 改用 `fs.cp` + `fs.rm` 替换不可靠的 `fs.rename`；本地打包改用 PowerShell 自签名证书，不再因 signtool.exe 挂起

### [0.3.7] - 2026-06-01

#### 新增

- TTS 朗读配置面板：设置 → 通用新增「文字转语音」区块，支持独立配置 MiMo TTS `sk-` 前缀 API Key、音色选择（冰糖 / 茉莉 / 苏打 / 白桦 / 英文四种）、以及朗读功能总开关；朗读按钮仅在开关开启时显示

#### 修复

- TTS 调用逻辑修正：原实现调用不存在的本地路由 `/session/tts`（必然静默失败），现改为渲染进程直接请求 `https://api.xiaomimimo.com/v1/chat/completions`，使用 MiMo v2.5 TTS 模型，base64 WAV 响应直接通过浏览器 Audio API 播放
- 标题栏版本号动态化：版本徽章从硬编码字符串改为读取 `window.api.appVersion`（由 preload 注入 `npm_package_version`），后续只需改 `package.json` 版本号，标题栏自动同步
- 侧边栏项目自动置顶：当前活跃项目调用 `touch()` 时自动移到侧边栏列表顶部，不再保持静态创建顺序
- compaction 消息加载方向修正：`MessageV2.page` 新增 `after` 参数；compacted 会话初始加载从「summary 之前的旧消息」（原逻辑反向）修正为「summary 及之后的新消息」，避免加载大量 pre-compaction 历史导致渲染器 OOM
- 新建会话 provider 检测再修正：`global-sync.tsx` 将 `global.provider` 从初始化时的静态快照改为惰性 getter，确保 child-store 响应式 getter 运行时读取的是实时 `globalStore.provider` 而非启动时 global query 尚未完成的 EMPTY 快照；修复了项目级 provider 查询完成而全局查询尚未结束时 fallback 判断失效、导致"需要配置 provider"弹窗的竞态问题

### [0.3.6] - 2026-05-30

#### 新增

- 消息朗读按钮：AI 回复气泡旁新增 🔊 按钮，点击调用 MiMo TTS API（限时免费 `mimo-v2-tts`）朗读回复内容；利用已有的 `notification.tsx` + `sound.ts` 音频基础设施，TTS 音频通过浏览器 `Audio` API 播放；复用现有 provider 配置体系接入 TTS 模型，无需额外 API key

### [0.3.5] - 2026-05-29

#### 修复

- 大会话导致渲染器 OOM/卡死：compacted 会话的消息查询只返回 compaction summary 之后的消息（`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`），避免 GUI 加载大量旧消息导致渲染器内存溢出或无响应
- 初始消息加载量减半：`initialMessagePageSize` 从 80 降至 40，`historyMessagePageSize` 从 200 降至 80，降低首次渲染压力
- 新建项目/provider查询失败时回退到全局 provider：`child-store.ts` 补充 `!projectData` 判断，当项目级 provider 查询返回 `undefined`/`null` 时自动回退到全局已连接 providers，避免要求重新配置
- 中文 i18n 适配：`zh.ts` 补全 24 条缺失翻译（project 切换、设置页面、错误页等），修复 `layout.tsx` 中 "Export logs" 硬编码英文（TUI 同步生效）

### [0.3.4] - 2026-05-29

#### 变更

- 包含服务端更新：统一数据库路径、CodeGraph MCP 代码知识图谱集成、斜杠命令中文化、provider 错误处理改进、shell/message-v2 修复

### [0.3.3] - 2026-05-29

#### 修复

- 新建会话重复弹出"选择智能体和模型"：`child-store.ts` 项目级 provider 查询 fallback 条件扩展，当 `connected` 为空但全局有已连接 providers 时自动回退，避免每次新建会话都要求重新配置
- 会话右键重命名菜单缺失：`sidebar-items.tsx` 手动 `onContextMenu` 实现替换为 Kobalte `ContextMenu` 组件，使用 Portal 渲染避免 overflow 裁剪
- GUI 图标白底：`yayi_256x256.ico` 用 sharp `unflatten` 去除白色背景，重新打包 ico/png 资源
- DeepSeek 模型变体下拉框不显示：`transform.ts` 移除 DeepSeek 排除列表，`@ai-sdk/openai-compatible` 类型模型绕过 `reasoning` 能力检查

### [0.3.2] - 2026-05-28

#### 新增

- 项目右键删除：首页 (`home.tsx`) 项目列表新增 `ContextMenu`，右键单个项目可删除；旧侧边栏 (`sidebar-project.tsx`) 项目图标右键菜单同样新增"删除"；旧侧边栏展开后项目头部三点 `DropdownMenu` 也补充"删除"项
- 项目删除后端 API：`Project.remove` Effect 服务方法 + DELETE `/project/:projectID` HTTP 路由 + `Event.Removed` 全局事件广播；SDK (`sdk.gen.ts`) 新增 `project.remove` 客户端方法；前端 `event-reducer.ts` 监听 `project.removed` 自动从列表移除
- 会话归档右键菜单：`sidebar-items.tsx` 会话项右键菜单加入"归档"选项
- 侧边栏底部收起按钮：`sidebar-shell.tsx` 加 `onToggleSidebar` prop，左侧 rail 设置按钮上方新增侧边栏切换按钮（旧设计 / prod channel 生效）

#### 修复

- 原生右键菜单拦截 HTML 菜单：`main/index.ts` 的 `electron-context-menu` 加 `shouldShowMenu`，限定只在图片/视频上触发，避免压制 Kobalte `ContextMenu` 不出现
- 任务栏 / 标题栏图标糊化：`scripts/gen-icon.py` 移除 `GaussianBlur(radius=1.0)`，红环改用 `ellipse(width=ring_w)` 单次抗锯齿描边，小尺寸（≤32 / ≤64）超采样倍率提升至 16x / 8x，重新生成全套 PNG/ICO
- 标题栏版本徽章：`packages/desktop/src/renderer/index.html` 顶部交通灯旁版本徽章更新为 `v0.3.2`
- DeepSeek 费用按 CNY 计价（3d3b0ce）

#### 变更

- TUI 与 GUI 版本号解耦：`packages/opencode/script/build-node.ts` 不再从 `packages/desktop/package.json` 读取版本，改读 opencode 自己的 `package.json`；TUI 现可独立递增版本号，互不影响

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## 共同历史

### [0.3.0] - 2026-05-27

#### 修复

- 桌面端 sidecar 崩溃：Bundle 不再复制到 `out/main/`，而是留在 `packages/opencode/dist/node/` 原位置，使 `jsonc-parser` 等依赖能从原始 `node_modules` 解析；添加 `@parcel/watcher` 最小 shim 避免拉入 `micromatch` 依赖链；sidecar 添加 `await new Promise` 保持进程存活
- 桌面端安装版白屏：移除 NSIS 安装器目标（`target: ["dir"]`），只生成免安装 `win-unpacked` 版
- 桌面端任务栏图标缺失：图标通过 `extraResources` 放到 ASAR 外部，`BrowserWindow` 改用 `nativeImage.createFromPath` 加载
- 桌面端 sidecar 错误不可见：添加永久 IPC 错误监听器，sidecar 崩溃日志写入 `%TEMP%\redcode-sidecar-crash.log`
- 桌面端 loading 灰屏：`awaitInitialization` 改用原生 `Promise.withResolvers` 替代 Effect `Deferred`，解决跨运行时挂起
- 桌面端类型错误：`server-sync.tsx` 参数顺序互换修复、`bootstrapGlobal` 属性名修复、`custom-elements.d.ts` 三斜线指令修复
- TUI 版本号显示错误：`build-node.ts` 改从 `packages/desktop/package.json` 读取 RedCode 版本（`0.2.2`），替代原来错误注入的 upstream opencode 版本（`1.15.10`）；需重建 TUI 生效（见下方构建说明）
- Desktop HTML 版本徽章：`out/renderer/index.html` hardcode 版本从 `v0.2.1` 更新为 `v0.2.2`
- 上游 Logo 残留：`packages/ui/src/components/logo.tsx` 完全重写，`Mark`（写轮眼 SVG）、`Splash`（旋转动画 SVG）、`Logo`（REDCODE 像素字）全部替换，消除新建会话时出现的 opencode 原版图标和 GitHub Mona GIF
- 新建会话 Wordmark：`wordmark-v2.tsx` 从 opencode SVG 路径改为 Space Grotesk 字体文字，RED 柔红色（`#e84057`），居中 72px
- 桌面端图标全部替换：`icons/dev/`、`icons/beta/`、`icons/prod/` 全套图标替换为万花筒写轮眼设计
- DeepSeek 缓存 Token 费用计算偏高：`session.ts` 添加 DeepSeek metadata fallback，从 `experimental_providerMetadata.deepseek.promptCacheHitTokens` / `promptCacheMissTokens` 读取缓存命中/未命中 token 数，修复所有 token 按全价计费的问题
- 对话框输入框无法粘贴：`dialog-prompt.tsx` 添加 `onPaste` handler，支持 Ctrl+V 在 API 密钥输入框中粘贴

#### 新增

- 万花筒写轮眼图标：新增 `packages/desktop/scripts/gen-icon.py`，程序化生成全套 Windows/macOS 图标（负空间法：实心红圆切三个黑色楔形 = 写轮眼三刀片）；输出到 `packages/desktop/icons/`

#### 构建说明

**TUI 重建（版本号修复生效）：**
```bash
cd packages/opencode
bun run script/build-node.ts
```
版本号在构建时烘焙进产物，之后 TUI 侧边栏底部将显示 `• RedCode 0.3.0`。

**图标重新生成：**
```bash
cd packages/desktop
py scripts/gen-icon.py
```
生成后在 electron-builder 配置中引用 `icons/icon.ico` 和 `icons/icon.png`，再重打包 desktop。

### [0.2.1] - 2026-05-26

#### 新增

- 缓存命中率显示：TUI 底部栏及 subagent footer 显示 `Cache: XX%` 缓存命中率
- Windows 剪贴板粘贴：添加 PowerShell `Get-Clipboard` 回退，修复 Windows TUI 粘贴问题
- 标题栏版本号：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- macOS 交通灯（V2 titlebar）：dev 构建左上角补齐红黄绿圆点，支持关闭/最小化/最大化

#### 变更

- 底部栏去重：移除右下角冗余的 token 用量和费用显示（右侧面板 context 中已有），仅保留缓存率和快捷键提示
- 移除帮助按钮：侧边栏底部及首页帮助按钮均已删除（原跳转外网，无实际用途）
- 错误页精简：仅保留「导出日志」按钮，移除重启/Sentry/检查更新/Discord 链接
- 侧边栏左对齐：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- 帮助菜单精简：只保留「RedCode 源码」（→ GitHub）和「导出日志...」，删除原作者的论坛/反馈/Bug 上报链接

#### 修复

- 双交通灯：`<Match when>` 改为 `<Match when={!USE_V2_TITLEBAR}>` 确保两个 titlebar 分支互斥，消除重复按钮和版本号
- 标题栏宽度：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

### [0.2.0] - 2026-05-26

#### 新增

- i18n 补全：三套自定义配色方案（米黄/护眼绿/深蓝）接入 i18n，英文标签 Cream / Eye Green / Deep Blue
- 标题栏版本号：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- V2 titlebar 交通灯：开发构建的 V2 titlebar 补齐左上角红黄绿圆点，与生产版行为一致

#### 变更

- 首页简化：删除 `LegacyHome` 组件，始终使用 `HomeDesign`；移除频道门控逻辑
- 频道简化：去掉 dev/beta/prod 分支门控，UI 功能统一走发布版路径
- 删除无效 UI：移除首页装饰性 `Branch: dev` 按钮及遗留 `console.log`
- 移除帮助按钮：侧边栏底部及首页帮助按钮均已删除（原链接跳转外网，无实际用途）
- 错误页精简：仅保留「导出日志」按钮，移除重启、Sentry 上报、检查更新、Discord 链接
- 侧边栏左对齐：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- 标题栏宽度修复：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

#### 修复

- `refcount.ts` 损坏：恢复正确的 `createRefCountMap` 实现，修复渲染器白屏
- `new-session-layout.ts` 损坏：恢复正确的 `shouldUseV2NewSessionPage` 实现

### [0.1.0] - 2026-05-24

#### 新增

- macOS 交通灯标题栏：Windows 桌面端左上角红黄绿圆点，支持关闭/最小化/最大化
- 中文菜单：三条线菜单全部中文化（文件/编辑/视图/导航/窗口/帮助）
- 中文斜杠命令：`/models` 选择大模型、`/sessions` 切换会话 等 20+ 命令中文化
- 三套新主题：米黄、护眼绿、深蓝
- 启动 Logo：TUI 启动界面替换为 REDCODE 纯█点阵
- README 猫猫：README 顶部猫猫 GIF + ASCII RedCode 并排显示
- 记忆系统：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好
- 版本号：Sidebar 右下角显示硬编码 `0.1.0`

#### 变更

- 货币符号：`$` → `¥`（USD → CNY），用于 DeepSeek 等中国模型
- Logo 颜色：左面板 RED 与右面板 CODE 同色同粗，不再偏暗
- Web UI 移除：桌面端渲染器剥离 SolidJS Web UI 依赖，改用独立 HTML
- 桌面端构建修复：修复 `vitefu` BOM 解析崩溃、Electron 路径重命名遗留问题

#### 修复

- TUI Proxy 崩溃：`opencode.json` 格式错误导致 `TypeError: Proxy target should be Object`
- 桌面端 sidecar 崩溃：Bundle 不再复制到 `out/main/`，而是留在 `packages/opencode/dist/node/` 原位置，使 `jsonc-parser` 等依赖能从原始 `node_modules` 解析；添加 `@parcel/watcher` 最小 shim 避免拉入 `micromatch` 依赖链；sidecar 添加 `await new Promise` 保持进程存活
- 桌面端安装版白屏：移除 NSIS 安装器目标（`target: ["dir"]`），只生成免安装 `win-unpacked` 版
- 桌面端任务栏图标缺失：图标通过 `extraResources` 放到 ASAR 外部，`BrowserWindow` 改用 `nativeImage.createFromPath` 加载
- 桌面端 sidecar 错误不可见：添加永久 IPC 错误监听器，sidecar 崩溃日志写入 `%TEMP%\redcode-sidecar-crash.log`
- 桌面端 loading 灰屏：`awaitInitialization` 改用原生 `Promise.withResolvers` 替代 Effect `Deferred`，解决跨运行时挂起
- 桌面端类型错误：`server-sync.tsx` 参数顺序互换修复、`bootstrapGlobal` 属性名修复、`custom-elements.d.ts` 三斜线指令修复
- TUI 版本号显示错误：`build-node.ts` 改从 `packages/desktop/package.json` 读取 RedCode 版本（`0.2.2`），替代原来错误注入的 upstream opencode 版本（`1.15.10`）；需重建 TUI 生效（见下方构建说明）
- Desktop HTML 版本徽章：`out/renderer/index.html` hardcode 版本从 `v0.2.1` 更新为 `v0.2.2`
- 上游 Logo 残留：`packages/ui/src/components/logo.tsx` 完全重写，`Mark`（写轮眼 SVG）、`Splash`（旋转动画 SVG）、`Logo`（REDCODE 像素字）全部替换，消除新建会话时出现的 opencode 原版图标和 GitHub Mona GIF
- 新建会话 Wordmark：`wordmark-v2.tsx` 从 opencode SVG 路径改为 Space Grotesk 字体文字，RED 柔红色（`#e84057`），居中 72px
- 桌面端图标全部替换：`icons/dev/`、`icons/beta/`、`icons/prod/` 全套图标替换为万花筒写轮眼设计
- DeepSeek 缓存 Token 费用计算偏高：`session.ts` 添加 DeepSeek metadata fallback，从 `experimental_providerMetadata.deepseek.promptCacheHitTokens` / `promptCacheMissTokens` 读取缓存命中/未命中 token 数，修复所有 token 按全价计费的问题
- 对话框输入框无法粘贴：`dialog-prompt.tsx` 添加 `onPaste` handler，支持 Ctrl+V 在 API 密钥输入框中粘贴

#### 新增

- 万花筒写轮眼图标：新增 `packages/desktop/scripts/gen-icon.py`，程序化生成全套 Windows/macOS 图标（负空间法：实心红圆切三个黑色楔形 = 写轮眼三刀片）；输出到 `packages/desktop/icons/`

#### 构建说明

**TUI 重建（版本号修复生效）：**
```bash
cd packages/opencode
bun run script/build-node.ts
```
版本号在构建时烘焙进产物，之后 TUI 侧边栏底部将显示 `• RedCode 0.3.0`。

**图标重新生成：**
```bash
cd packages/desktop
py scripts/gen-icon.py
```
生成后在 electron-builder 配置中引用 `icons/icon.ico` 和 `icons/icon.png`，再重打包 desktop。

### [0.0.1] - 2026-05-24

#### 新增

- 项目 Fork：基于 opencode (sst.dev) 二次开发
- 品牌重命名：opencode → RedCode，全面替换包名、URL、环境变量
