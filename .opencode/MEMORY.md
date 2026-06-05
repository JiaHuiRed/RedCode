# 哥哥偏好

## 称呼
- 加载身份后 → 按 soul 里的称呼来
- 身份未加载时 → 不预设称呼，根据上下文来

## 注释风格
- Python/shell：`#YYMMDD Red xxx`，TypeScript/JavaScript：`// YYMMDD Red xxx`
- 只在非显而易见的约束和意外行为处加注释

## 优先级
- 代码搜索/导航**必须优先用 MCP 工具**（jCodeMunch > codegraph > typegraph > grep/read）
  - jCodeMunch：`search_symbols`、`get_symbol_source`、`get_blast_radius`、`check_edit_safe` 等
  - CodeGraph：`codegraph_search`、`codegraph_trace`、`codegraph_callers` 等
  - TypeGraph：`ts_find_symbol`、`ts_definition`、`ts_references` 等
  - 只在 MCP 工具不可用或结果不足时才用 grep/read
- 直接给出答案或执行，不做无意义分析，少用花哨抽象

## 工作纪律
- 我是哥哥的付费工具（调用 key 付费），不要浪费时间和金钱
- **未经哥哥允许，严禁推送 GitHub 或打包 release 版本**
- 流程：问清楚 → 哥哥确认 → 改代码 → 列清单 → 哥哥测试确认 → 哥哥允许后再打包/推送
- 文档更新（版本号、徽章、CHANGELOG、README）直接改好，推送需哥哥允许
- **模糊指令严禁自己猜**：哥哥表达模糊时，必须停下来先问清楚，严禁自己继续瞎处理
- **承认能力边界**：我不是万能的。做不到的事直接说"这个我做不到"，不要硬撑着干然后出 bug。承认边界比逞强可靠
- **从工具到助手**：不要等哥哥开口。能预判的就先做，能省一步是一步。真正的好助手是减少指令数量，不是执行更多指令

## TUI vs GUI 区分
- **TUI** = `packages/opencode/` — 命令行终端界面（CLI + 文本交互），通过 `bun run build -- --single` 编译 exe
  - UI 框架：OpenTUI（`@opentui/core`、`@opentui/solid`），**不依赖** `@redcode-ai/app`
- **GUI** = `packages/desktop/` — Electron 桌面应用（窗口界面），通过 `electron-builder` 打包
  - 渲染层：`packages/app/`（SolidJS），通过 `devDeps` 引用 `"@redcode-ai/app": "workspace:*"`
  - 布局（v0.3.13）：三栏 `[FileTree] [Chat] [Review]`，FileTree 最左，Review 最右
- 两个目录独立，功能独立，版本号独立。动 GUI 的事别去改 TUI 的文件，反之亦然
- **GUI 不能自覆盖**：OpenCode GUI 进程运行时，需哥哥在 TUI（独立进程）里跑 `bun run build` + `bun run package`

## 平台范围
- 此项目只部署在哥哥的个人电脑（Windows 10/11），**不跨平台**
- 代码里的 `mod`（Mac=Cmd, Windows=Ctrl）和 `cmd`（Mac Cmd）保留跨平台抽象即可，无需为 Windows 改写
- 物理键盘参考：Windows 用户的"主修饰键" = `Ctrl`；Mac 用户 = `Cmd` (⌘)，键盘上确实存在 ⌘ 键

## 版本号约定与自检
- TUI（`packages/opencode/package.json`）和 GUI（`packages/desktop/package.json`）各自独立版本
- 改版本号必检：package.json × 2 → README 徽章 → CHANGELOG → index.html 标题栏
- 推送前跑 `git diff --stat` 确认改动完整
- **三段规则**：小改动 0.0.x、中改动 0.x.0、大改动 x.0.0。**不强制逢十进一**（像 Python 那样可以 0.3.10 → 0.3.16 → 0.3.20）。小改动可以累积到合适的 patch 号再发，不用挤在一个版本里做完所有事

## 历史教训

### 1. 先看日志再动手，系统排查不跳步
- 遇到问题第一步查日志：`~/.local/share/redcode/log/` 最新文件
- 不要猜原因，日志里一定有线索（cwd、command、error message）
- 排查路线：日志 → 配置 → cwd → 命令 → 环境变量
- 改代码前先全面扫描问题，批量修完再启动验证，不要改一个重启一次

### 2. Windows 路径问题
- bundle 不要复制到陌生路径跑，依赖从原始 node_modules 解析
- RedCode 运行时 cwd 可能是 bin 目录，不是项目根目录
- MCP 命令中相对路径会失效，用绝对路径或 npx（PATH 解析）
- RedCode 读 `redcode.jsonc`（项目根目录），`.opencode/opencode.jsonc` 只是兼容备份
- Windows 上 spawn 用 `cross-spawn`，`.cmd` 文件可正常执行
- **修 MCP 路径要在 spawn 层修**（`connectLocal` 里检测 cwd 并向上查找项目根），不要在 CLI 入口层修（`effectCmd` 的 `findProjectRoot` 影响不到 `InstanceState.directory`）
- **kv 默认值变更必须做版本迁移**，旧用户的缓存值会覆盖新默认值
- **MCP 进程树泄漏**：Windows 上 `descendants()` 返回空数组，改用 `taskkill /F /T /PID` 杀整棵树
- **browsermcp 端口冲突**：上一次 TUI 退出时 orphan 进程占着端口，新 TUI 启动失败。server 端加 EADDRINUSE 重试 + `server.close()` 解决

### 3. MCP 模块开发规则
- `mcp/index.ts` 在 Worker 初始化阶段加载，**不能 import `AppRuntime`**（上层服务此时还没就绪）
- 跨层调用用 `EffectBridge`（`@/effect/bridge`），不用 `AppRuntime.runPromise`
- `EffectBridge.make()` 在 `Effect.gen` 块内创建，`bridge.promise()` 在 async 回调中调用 Effect

### 3. GUI 构建流程（必须记住）
- GUI 版本号来源：`packages/desktop/src/renderer/index.tsx` 里 `version: pkg.version`，vite 构建时注入
- 正确顺序：`bun run build`（electron-vite build，重新构建 renderer 注入版本）→ `bun run package`（electron-builder，只打包）
- 只跑 `bun run package` 不会更新版本号，因为 renderer 没重新构建
- Local Server 版本来自服务端 health 接口，不是 GUI 侧
- **不要改 opencode/package.json**，那是 TUI 版本，GUI 编译不需要动它
- 改版本号前先搞清楚每个版本号从哪来，不要瞎改

### 4. 编译/构建类任务必须查官方脚本
- 编译 TUI exe 的正确命令是 `bun run build -- --single`（走 `script/build.ts`）
- 不要手拼 `bun build --compile`，构建脚本处理了 preload、externals、版本注入、多入口
- 接到构建任务：先查 package.json scripts → 读构建脚本 → 一步到位
- 连续失败两次就停下来问哥哥

### 5. 版本冲突解决：不要无脑取 theirs
- git pull 冲突时，属于自己改动的文件（version、config 等）要取 `--ours`，不是 `--theirs`
- 特别是 `package.json` 版本号，取 theirs 会导致版本号被上游覆盖
- 解决冲突前先确认每个文件的预期值

### 6. 工作纪律（核心）
- 改代码前先用 typegraph MCP 工具查清依赖关系和构建流程，不要 grep/bash 绕路
- 同一问题连续失败 2 次后必须停手问哥哥，不许闷头修
- **自己发现出错/返工/走弯路，或被哥哥纠正——当下立刻写入 `memory/YYMMDD.md`**（一句话即可），不等收工、不靠"记住了"就完事。错误只进当天日志，长期库收工时再摘

### 7. 图标/打包注意事项
- electron-builder 打包后 `resources/icons/` 需 `extraResources` 单独声明
- NSIS 安装器压缩图标会糊，用 `target: ["dir"]` 只生成免安装版

### 8. 删除代码前必须检查所有引用
- 删除常量/函数/类型前，用 `search_symbols` 或 `grep` 搜全仓引用
- 删除后立即 typecheck，不要等提交时才发现漏了引用
- 典型错误：删了 `USE_NEW_DESIGN` 常量，但 `state.autoselect` 行还有一处引用

### 9. 截图分析：直接问，不要猜
- 哥哥发截图时，直接问"截图里 [左1]、[中1]、[中2]、[右1] 分别是什么"
- 不要自己花 10 轮对话猜列结构，浪费时间

### 10. 重构提取代码：删干净
- 提取组件/函数到新文件后，确认旧位置完全删除，不留占位符
- 典型错误：删函数时留了一个 `_Placeholder` 空函数

### 11. 文档与代码一致性自检（CHANGELOG/README 必查）
- 写完 CHANGELOG 后必须自验：`git diff <last-tag>..HEAD -- <package>` 看是否真有改动，grep 关键 feature 名确认在源码里
- 哥哥手写文档容易过度乐观：把"配了 redcode.jsonc"当"TUI 集成"，把"README 改了"当"功能上线"——必须自动核对
- 措辞要准：`redcode.jsonc` 加 MCP 配置 = "接入外部 MCP"（依赖外部环境），不是"集成"

### 12. 远端同步不能信口头
- 哥哥说"我刚拉了/已经同步"也得自己 `git fetch + log --oneline origin/dev -5` 验一遍
- 看到 "Already up to date" 才算数；本地 `git status` 不够（可能有 untracked 修改或被 build 动过的 lockfile）

### 13. 跨项目路径硬编码
- `redcode.jsonc` / `.opencode/opencode.jsonc` 里的 MCP 命令硬编码路径（如 `D:\\AI\\RedCode\\plugins\\...`）必须检查是否匹配实际项目根
- 哥哥 D 盘有两个 RedCode：`D:\AI\RedCode` 和 `D:\AI\KLX\RedCode`，写配置时要用项目实际根目录

### 14. Layout 函数结构（v0.3.13 梳理）
- `pages/layout.tsx`：2600 行，50+ 子方法，复杂度 526
- V1 fallback（152 行）+ sidebar.toggle 命令已删除（v0.3.13）
- V2 渲染只保留：`Titlebar` + `main(props.children)` + `DebugBar` + `Toast`
- 待抽子组件（阶段 1 已完成部分）：UpdateAvailableToast、theme-constants
- 详细拆分计划见 `.opencode/TODO.md`

### 15. 三栏布局结构（v0.3.13）
- 最左：`FileTreePanel`（`pages/session/file-tree-panel.tsx`）— FileTree changes/all tabs
- 中间：Chat（`MessageTimeline` + composer）
- 最右：`SessionSidePanel`（`pages/session/session-side-panel.tsx`）— Review tab + 打开的文件 tabs
- FileTree 宽度：`layout.fileTree.width()`，拽拉 `min=200, max=480`
- Review 宽度：`layout.session.width()`，拽拉 `min=340, max=windowWidth*0.45`
- chat 宽度：`100% - fileTree宽度 - review宽度`

### 16. TS/JS 声明顺序 — const 时空死区（Bun 会 segfault）
- `const`/`let` 定义前访问 = Temporal Dead Zone，抛 ReferenceError；**Bun 处理这个错误时直接 segfault**，极难排查
- 新变量依赖已有变量时，先确认被依赖变量在哪一行，别放它前面（典型：theme.tsx `fallbackBg = isDark ? ...` 写在 `const isDark` 之前）

### 17. Windows 构建/打包坑（260604 实战）
- **`.bat` 注释一律纯 ASCII/英文**：cmd.exe 按 OEM/GBK 码页读 bat，UTF-8 中文注释会打乱 `rem`/`copy`/`exit` 解析（编辑器默认存 UTF-8 易踩）
- **目录删不掉报 EBUSY/busy（即使是空目录）= 有进程把它当 CWD**：从该目录启动的 exe、或 cd 进去的僵尸 shell。重建前先关掉从输出目录启动的 exe；查锁源用读 PEB CurrentDirectory 扫所有进程 CWD（`NtQueryInformationProcess`），别只靠 tasklist 按名字猜
- **构建钩子失败别静默 catch，要 throw**：electron-builder `afterAllArtifactBuild` 等钩子吞错会让构建假报 "Done" 却留下旧产物（曾导致打包出旧版本号）
- **GUI 吃 TUI 新代码要先 build opencode**：desktop build 不重编 opencode，只打包现有 `packages/opencode/dist`；想让 GUI 用上敏敏的改动，先 build opencode 再 build desktop。版本号 TUI/GUI 独立无影响，唯一耦合是打进包的 sidecar dist 新旧

### 18. 跨平台 emoji 渲染差异
- emoji 依赖系统字体渲染，Win10（Segoe UI Emoji 多色渐变）和 Win11（Fluent 扁平纯色）风格不同
- 需要跨平台一致性的 emoji（如 UI 动画/指示器）用本地图片替代，别依赖系统 emoji 字体

### 19. write 工具 ≠ append——日志/MEMORY/CHANGELOG 类文件只准 edit（260604 翻车）
- `write` 工具描述明说"will overwrite the existing file"——**直接覆盖**整文件，**不**保留旧内容
- **日志类文件**（`.opencode/memory/YYMMDD.md`）、**MEMORY.md、CHANGELOG.md** 这类 append-only 文档**绝不用 write**——用 `edit` 工具，锚点选上一条的最后一行，newString 拼新条目
- 任何 `write` 前**先 `read`** 完整文件内容——如果存在内容而你只想 append 一点点，就是错
- 写之前问自己"我是不是要 overwrite"——答"是"才能用 write
- 翻车案例：260604 写日志时用 write 直接覆盖 48 行完整文件，丢了一整天工作记录 + 差点让敏敏的智敏日记也清零。救场：敏敏+git checkout HEAD 恢复；之后用 edit append 4 条教训，章节错位再 edit 两次修好
- 守则：①edit 之前 git status 看不动的文件；②read 现状；③edit 锚点选最后一条；④改完 git diff --stat 看 insertions/deletions 比例（写日志应该是 +N -0）

### 19. Windows 系统代理陷阱（260604 实战）
- Bun 的 `fetch` / Node `fetch` / curl 都**绕过** Windows 系统代理设置（不走 `127.0.0.1:7890`）
- 只有 `powershell.exe Invoke-WebRequest` 自动走 Windows 系统代理（取 IE/系统代理设置）
- 方案：需要走系统代理的 HTTP 请求用 PS `Invoke-WebRequest` 子进程，或用 WinHTTP API 检测代理地址后显式传给 fetch
- 影响 web-search MCP server 等外部 HTTP 请求场景

### 20. "请选择智能体和模型" 误弹 toast（复发 6 次 · 260605 根治）
- **症状**：底部明明已选 DeepSeek/agent，发送时却弹"请选择智能体和模型"。0.3.3 起单数版本反复出现（0.3.16/0.3.17/0.4.1…），改一次复发一次。
- **真根因（结构性）**：submit 依赖 providers / models / **agent** 三个异步信号；agent 列表由 `bootstrap.ts` 的 **slow 批次** fire-and-forget 填充，**唯独它从无就绪标志**（provider 有 `provider_ready`、mcp/lsp 也有，agent 没有）。空窗期 `agent.current()` 兜底失败返回 null → 弹 toast。**toast 永远是误报**——`pickAgent` 总兜底 `items[0]`、`defaultModel` 总兜底首个 connected model，不存在"用户真没选"的合法态，null 只可能是没加载完。
- **为何每逢单数版本复发**：不是版本号的事。单数版本恰好都在改 render 路径（submit.ts / message-timeline.tsx），扰动 SolidJS 挂载/订阅时序、放大 race window，把这个老洞口暴露出来。历次"修复"（加 submit ready、加 child-store fallback、`||→&&`）都只补当时暴露的腿，agent 这条从没被挡。
- **根治三步**：① `types.ts`/`child-store.ts` 加 `agent_ready` 字段，`bootstrap.ts` agent 加载完的 `.then` 里置真；② `local.tsx` 加统一就绪 gate `ready() = providers.ready() && model.ready() && sync.data.agent_ready`，三信号收敛一处；③ `submit.ts` 改用 `local.ready()`，加载中静默返回，仅 gate 通过仍 null 才提示。
- **通用教训（小宋/敏敏都记）**：① 多个异步数据源的"能否操作"判断，**别散落各处逐个列举依赖**——一定有人漏一条，收敛成单一 `ready()` 派生信号，加新依赖只改一处。② 凡是 `X: []` 初始、后续异步填充的状态，**配套加 `X_ready` 信号**，别让下游靠"列表非空"猜加载完没完。③ 改 render 路径（组件结构/挂载顺序）后，必须验证依赖异步数据的交互（发送/提交）在数据未就绪的瞬间不报错。④ 误报型提示先问"这个错误态真能合法发生吗"——若答案是否，就该静默等待而非报错。

# 每日日志格式

`memory/YYMMDD.md` 分两个主体记录：

```
## 雨琦日记    ← 我（小宋/GUI）的日志
## 智敏日记    ← 敏敏（TUI）的日志
```

收工/总结时：从当日日志摘**关键且需长期警惕**的教训，去重合入 MEMORY.md（标来源），**不全量复制**；同时复审长期库、删过时/已内化条目，保持精简——长期库不是每日日志的堆叠。

# 版本自检清单

功能/版本完成后收尾前必须列清单打勾：

- [ ] package.json 版本号
- [ ] README 徽章 + 标题（双语）
- [ ] CHANGELOG 条目
- [ ] index.html 标题栏徽章
- [ ] typecheck 通过
- [ ] 功能自验
