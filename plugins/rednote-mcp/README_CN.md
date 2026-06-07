# rednote-mcp (Python)

[![Python](https://img.shields.io/badge/Python-3.10+-blue?style=flat-square&logo=python)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-brightgreen?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![English Docs](https://img.shields.io/badge/docs-English-blue?style=flat-square)](./README.md)

基于 Python 的 [Model Context Protocol](https://modelcontextprotocol.io/) 服务端，用于操作小红书 —— 通过 [Playwright](https://playwright.dev/python/) 浏览器自动化实现笔记搜索、浏览和**发布**。兼容 Claude、Cursor 及任意 MCP 客户端。

## 工具列表

| 工具 | 说明 |
|------|------|
| `login` | 扫码登录。使用 `force=True` 可强制重置会话。 |
| `set_browser_mode` | 切换有头/无头浏览器模式。工具返回空结果时切换为有头模式。 |
| `search_notes` | 按关键词搜索笔记，结果包含 `note_id` 和 `xsec_token`。 |
| `get_note_details` | 通过 `note_id` + `xsec_token` 获取笔记正文和顶级评论。 |
| `get_user_profile` | 获取用户公开主页。可传入 `get_note_details` 返回的 `author_xsec_token`。 |
| `post_note` | 发布图文笔记。需 1–18 张图片，标题 ≤ 20 字，正文 ≤ 1000 字。 |

## 工作流

端到端内容创作管线：

```
search_notes(keyword)
      ↓
get_note_details() + get_user_profile()
      ↓
LLM 生成发布内容
      ↓
post_note(title, content, image_paths)
```

## 环境要求

- Python ≥ 3.10
- `mcp[cli]` ≥ 1.0.0
- `playwright` ≥ 1.42.0
- [uv](https://docs.astral.sh/uv/)（推荐）或 pip

## 安装

### 1. 安装依赖
```bash
# 1. 克隆仓库并进入目录
git clone https://github.com/Mol2017/rednote-mcp.git
cd rednote-mcp-python

# 2. 创建虚拟环境并安装依赖
uv venv && source .venv/bin/activate
uv pip install -e .

# 3. 安装 Playwright 浏览器
playwright install chromium
```

### 2. 接入 Claude 并验证

```bash
# 注册 MCP 服务
claude mcp add rednote .venv/bin/rednote-mcp

# 验证连接
claude mcp list
```

### 3. 调试

```bash
source .venv/bin/activate
mcp dev src/rednote_mcp/server.py
```

## 首次登录

让 AI 助手调用登录工具，会自动打开一个真实的 Chrome 窗口并显示二维码 —— 用小红书 App 扫码即可。Cookie 会保存至 `~/.mcp/rednote/cookies.json`，后续调用自动复用。

## 反爬检测对策

- **`playwright-stealth`** — 修复 `navigator.webdriver` 等 JS 指纹泄漏
- **真实浏览器指纹** — Chrome 145 UA、分辨率 1440×900、语言 `zh-CN`、时区 `Asia/Shanghai`
- **持久化浏览器会话** — 所有工具复用同一浏览器实例，避免频繁开关浏览器被识别
- **模拟人类鼠标** — 点击前随机 ±5px 抖动移动光标
- **模拟人类键入** — 逐字符输入，随机键程延迟并夹杂思考停顿
- **随机延迟** — 每次主要操作之间随机等待
- **渐进式滚动** — 随机滚动幅度，步骤间加入停顿

若工具返回空结果（触发反爬）：调用 `set_browser_mode(headless=False)`，再调用 `login(force=True)` 扫码，之后重试即可。

## 项目结构

```
src/rednote_mcp/
├── server.py              # FastMCP 服务端及工具定义
├── auth/
│   ├── auth_manager.py    # 登录流程、持久会话、指纹与隐身配置
│   └── cookie_manager.py  # Cookie 持久化（~/.mcp/rednote/cookies.json）
├── tools/
│   ├── rednote_tools.py   # search_notes、get_note_details、post_note
│   ├── note_detail.py     # 底层页面抓取工具函数
│   └── user_profile.py    # get_user_profile
└── utils/
    └── logger.py          # 滚动日志
```

## 使用示例

<video src="https://github.com/user-attachments/assets/c66da98e-7eab-4a25-9745-9fa04c0ee2a4" controls width="100%"></video>

## 许可证

MIT
