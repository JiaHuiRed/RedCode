# rednote-mcp (Python)

[![Python](https://img.shields.io/badge/Python-3.10+-blue?style=flat-square&logo=python)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-brightgreen?style=flat-square)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![中文文档](https://img.shields.io/badge/文档-中文版-red?style=flat-square)](./README_CN.md)

A Python [Model Context Protocol](https://modelcontextprotocol.io/) server for RedNote (小红书 / XiaoHongShu) — search, browse, and **post notes** via browser automation with [Playwright](https://playwright.dev/python/). Works with Claude, Cursor, or any MCP-compatible client.

## Tools

| Tool | Description |
|------|-------------|
| `login` | Authenticate via QR code scan. Use `force=True` to reset the session. |
| `set_browser_mode` | Toggle headless/headed browser. Use headed if tools return empty results. |
| `search_notes` | Search notes by keyword. Returns results with `note_id` and `xsec_token`. |
| `get_note_details` | Fetch full note body and top-level comments using `note_id` + `xsec_token`. |
| `get_user_profile` | Fetch a user's public profile. Pass `author_xsec_token` from `get_note_details`. |
| `post_note` | Post a picture-and-text note. Requires 1–18 images, title ≤ 20 chars, content ≤ 1000 chars. |

## Workflow

End-to-end content creation pipeline:

```
search_notes(keyword)
      ↓
get_note_details() + get_user_profile()
      ↓
LLM generates post content
      ↓
post_note(title, content, image_paths)
```

## Requirements

- Python ≥ 3.10
- `mcp[cli]` ≥ 1.0.0
- `playwright` ≥ 1.42.0
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

## Installation

### 1. Install the package
```bash
# 1. Clone and enter the directory
git clone https://github.com/Mol2017/rednote-mcp.git
cd rednote-mcp

# 2. Create a virtual environment and install dependencies
uv venv && source .venv/bin/activate
uv pip install -e .

# 3. Install Playwright browsers
playwright install chromium
```

### 2. Add to Claude and verify

```bash
# Register the MCP server with Claude
claude mcp add rednote .venv/bin/rednote-mcp

# Verify it is connected
claude mcp list
```

### 3. Debug

```bash
source .venv/bin/activate
mcp dev src/rednote_mcp/server.py
```

## First-time login

Ask the agent to log in to RedNote. It opens a real Chrome window with a QR code — scan it with the RedNote app. Cookies are persisted to `~/.mcp/rednote/cookies.json` and reused automatically.

## Anti-bot detection

- **`playwright-stealth`** — patches `navigator.webdriver` and other JS fingerprint leaks
- **Realistic browser fingerprint** — Chrome 145 user-agent, viewport 1440×900, locale `zh-CN`, timezone `Asia/Shanghai`
- **Persistent browser session** — one browser instance reused across all tool calls
- **Human mouse behaviour** — cursor moves with random ±5px jitter before each click
- **Human typing** — per-keystroke random delays with occasional thinking pauses
- **Random delays** — randomised sleep between every major action
- **Incremental scrolling** — random scroll amounts with pauses between steps

If tools return empty results: call `set_browser_mode(headless=False)`, then `login(force=True)`, scan the QR code, and retry.

## Project structure

```
src/rednote_mcp/
├── server.py              # FastMCP server & tool definitions
├── auth/
│   ├── auth_manager.py    # Login flow, persistent session, fingerprint & stealth config
│   └── cookie_manager.py  # Cookie persistence (~/.mcp/rednote/cookies.json)
├── tools/
│   ├── rednote_tools.py   # search_notes, get_note_details, post_note
│   ├── note_detail.py     # Low-level page scraping helpers
│   └── user_profile.py    # get_user_profile
└── utils/
    └── logger.py          # Rotating file logger
```

## Usage Example

<video src="https://github.com/user-attachments/assets/c66da98e-7eab-4a25-9745-9fa04c0ee2a4" controls width="100%"></video>

## License

MIT
