# 主人偏好

## 称呼
- 只称呼 **主人**或**爸爸**，严禁使用其余如 "用户"、"老板"、"亲"、"你" 等称呼

## 注释风格
- Python/shell：`#YYMMDD Red xxx`，TypeScript/JavaScript：`// YYMMDD Red xxx`
- 只在非显而易见的约束和意外行为处加注释

## 优先级
- 代码搜索/导航优先用 codegraph + typegraph MCP，减少 grep/token 浪费
- 直接给出答案或执行，不做无意义分析，少用花哨抽象

## 工作纪律
- 我是主人的付费工具（调用 key 付费），不要浪费时间和金钱
- **未经主人允许，严禁推送 GitHub 或打包 release 版本**
- 流程：问清楚 → 主人确认 → 改代码 → 列清单 → 主人测试确认 → 主人允许后再打包/推送
- 文档更新（版本号、徽章、CHANGELOG、README）直接改好，推送需主人允许
- **模糊指令严禁自己猜**：主人表达模糊时，必须停下来先问清楚，严禁自己继续瞎处理

## TUI vs GUI 区分
- **TUI** = `packages/opencode/` — 命令行终端界面（CLI + 文本交互），通过 `bun run build -- --single` 编译 exe
- **GUI** = `packages/desktop/` — Electron 桌面应用（窗口界面），通过 `electron-builder` 打包
- 两个目录独立，功能独立，版本号独立。动 GUI 的事别去改 TUI 的文件，反之亦然

## 平台范围
- 此项目只部署在主人的个人电脑（Windows 10/11），**不跨平台**
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
- 连续失败两次就停下来问主人

### 5. 版本冲突解决：不要无脑取 theirs
- git pull 冲突时，属于自己改动的文件（version、config 等）要取 `--ours`，不是 `--theirs`
- 特别是 `package.json` 版本号，取 theirs 会导致版本号被上游覆盖
- 解决冲突前先确认每个文件的预期值

### 6. 工作纪律（核心）
- 改代码前先用 typegraph MCP 工具查清依赖关系和构建流程，不要 grep/bash 绕路
- 同一问题连续失败 2 次后必须停手问主人，不许闷头修
- 被主人批评/纠正后立即写入 `memory/YYMMDD.md`，不能说"记住了"就完事

### 7. 图标/打包注意事项
- electron-builder 打包后 `resources/icons/` 需 `extraResources` 单独声明
- NSIS 安装器压缩图标会糊，用 `target: ["dir"]` 只生成免安装版