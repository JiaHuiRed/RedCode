---
name: vision-autoagent
description: 当前模型不支持图片输入时的兜底——定位图片文件、派 explore 子代理审图。runtime 的 VISION CAPABILITY 已给 true/false 分流；true 时直接看图，本 skill 不适用。
---

# 视觉自动分析 (Vision AutoAgent)

runtime 注入的 `VISION CAPABILITY` 是权威分流：支持图片 → 直接看图描述；不支持（收到「不支持图片」报错）→ 按本流程兜底。

## 触发条件（唯一）

- "this model does not support image input"
- "Cannot read \"<filename>\""
- 任何提及用户发送了图片但模型无法处理的报错

## 执行流程

1. **定位图片文件**：报错里通常是系统占位名（如 `image.png`），在以下目录按修改时间倒序找最近 10 分钟内创建的图片（`*.png` `*.jpg` `*.jpeg` `*.webp`），取最新：
   - `%USERPROFILE%\Pictures\`
   - `%TEMP%\`
   - `%LOCALAPPDATA%\redcode\`
   - `%USERPROFILE%\.local\share\redcode\`
2. **派子代理审图**：task 工具派 explore 子代理（redcode.jsonc 已配），prompt 给完整图片路径 + 具体分析问题，让它 read 读图后精确描述；注明「不要重复刷工具」。大图/4K 先裁剪可疑区域再派（自动缩放会漏判小字/花屏）。
3. **回复用户**：直接给分析结果，不解释技术细节、不自贬（「先看看你发的图」）。

## 边界

- 失败重试或换问法，**不找替代工具**——本地 vision MCP 已退役，不存在 `vision_analyze_image` 之类工具。
- 找不到文件请用户重发；整个流程静默进行。
