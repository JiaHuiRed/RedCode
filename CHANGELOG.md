# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [0.1.0] - 2026-05-24

### 新增

- **macOS 交通灯标题栏**：Windows 桌面端左上角红黄绿圆点，支持关闭/最小化/最大化
- **中文菜单**：三条线菜单全部中文化（文件/编辑/视图/导航/窗口/帮助）
- **中文斜杠命令**：`/models` 选择大模型、`/sessions` 切换会话 等 20+ 命令中文化
- **三套新主题**：米黄、护眼绿、深蓝
- **启动 Logo**：TUI 启动界面替换为 REDCODE 纯█点阵
- **版本号**：Sidebar 右下角显示硬编码 `0.1.0`
- **README 猫猫**：README 顶部猫猫 GIF + ASCII RedCode 并排显示
- **记忆系统**：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好

### 变更

- **货币符号**：`$` → `¥`（USD → CNY），用于 DeepSeek 等中国模型
- **Logo 颜色**：左面板 RED 与右面板 CODE 同色同粗，不再偏暗
- **Web UI 移除**：桌面端渲染器剥离 SolidJS Web UI 依赖，改用独立 HTML
- **桌面端构建修复**：修复 `vitefu` BOM 解析崩溃、Electron 路径重命名遗留问题

### 修复

- **TUI Proxy 崩溃**：`opencode.json` 格式错误导致 `TypeError: Proxy target should be Object`
- **桌面端白屏**：恢复 `loading.html`，修复 Vite 缓存导致的白屏
- **Logo 不清晰**：从 `█▀▄` 阴影风格改为纯 `█` 点阵 5×5 字模

## [0.0.1] - 2026-05-24

### 新增

- **项目 Fork**：基于 opencode (sst.dev) 二次开发
- **品牌重命名**：opencode → RedCode，全面替换包名、URL、环境变量
