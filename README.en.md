# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>
<pre align="center">
██████ ██████ ██████ ██████ ██████ ██████ ██████
█   █ █     █  ██  █     █   █ █  ██  █    
██████ ██████ █   █ █     █   █ █   █  ██████
█  ██ █     █   █ █     █   █ █   █  █    
█   █ ██████ ██████ ██████ ██████ ██████ ██████
</pre>

> **Open-source AI coding assistant — terminal + desktop dual-mode intelligent coding agent.**
> Author: Red · Forked from [opencode](https://github.com/anomalyco/opencode) (sst.dev).

[![TUI](https://img.shields.io/badge/TUI-0.3.16-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.3.15-0078d4)](CHANGELOG.md)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightblue)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

Open-source AI coding assistant with **terminal TUI** and **desktop GUI** interfaces. Reads your codebase, executes commands, edits files, searches code, and completes programming tasks through natural language conversation.

---

## 🧩 Features

- 💬 **Natural Language Coding** — describe requirements, auto-complete code
- 🔌 **Multi-Model Support** — DeepSeek, OpenAI, Anthropic, Google Gemini, Ollama, etc.
- 🛠 **Tool System** — file read/write, code search, terminal commands, web search
- 🤖 **Smart Agents** — Build, Plan, General, Explore agents built-in, custom agents supported
- 📝 **Session Management** — history save, restore, fork
- 🎨 **Terminal UI** — syntax highlighting, streaming output, diff display
- 🖥 **Desktop GUI** — Electron standalone window with full graphical interface
- 📊 **MCP Servers**:
  - [CodeGraph](https://github.com/colbymchenry/codegraph) — code knowledge graph (symbols, call chains, impact analysis)
  - [TypeGraph](https://github.com/guyowen/typegraph-mcp) — TypeScript semantic navigation (type resolution, barrel file traversal, cycle detection)
  - [jCodeMunch](https://github.com/colbymchenry/jcodemunch) — structured code retrieval (60+ tools: symbol lookup, dead code detection, AST matching)
  - [Browser MCP](https://github.com/colbymchenry/browsermcp) — browser automation (navigation, screenshots, clicks, input, page content extraction)
- 🔒 **Permission System** — tool call confirmation, auto-approve support
- 🌍 **Multi-language** — Chinese, English, Japanese, and 18 languages
- 🗣 **TTS** — MiMo TTS voice reading for AI responses

---

## 🖥 Desktop GUI (v0.3.15)

- **Three-column layout**: FileTree (left) + Chat (center) + Review (right), independently resizable
- **Session shortcuts**: `Cmd+T` / `Cmd+Shift+T` to switch context sessions
- **Project shortcuts**: `Cmd+1` ~ `Cmd+9` to switch projects
- **Design system**: CSS design tokens (radius, shadows, typography), `text-wrap: balance/pretty`
- **V2 Titlebar**: Tab-based session management, StatusPopover for token usage
- **Thinking hamster animation**: 🐹 running animation + Mona cat loading during AI thinking

---

## 🚀 Run from Source

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# Build MCP indexes (first time only)
npx -y @colbymchenry/codegraph index

# Start TUI (interactive terminal)
bun dev

# Or start Desktop GUI
cd packages/desktop && bun run dev
```

---

## ⚙️ Configuration

### Config File Locations

| Location | Purpose |
|----------|---------|
| `~/.config/redcode/redcode.json` | Global config |
| `project_dir/redcode.jsonc` | Project-level config |
| `project_dir/.opencode/opencode.jsonc` | Legacy format (compatible) |

### Add Custom Provider

```jsonc
// redcode.jsonc
{
  "$schema": "https://redcode.dev/config.json",
  "provider": {
    "my-provider": {
      "type": "openai",
      "apiKey": "sk-xxx",
      "baseURL": "https://api.example.com/v1"
    }
  },
  "model": "my-provider/my-model"
}
```

### MCP Server Config

```jsonc
{
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["npx", "-y", "@colbymchenry/codegraph", "serve", "--mcp"],
      "enabled": true
    },
    "typegraph": {
      "type": "local",
      "command": ["npx", "tsx", "path/to/typegraph-mcp/server.ts"],
      "environment": {
        "TYPEGRAPH_PROJECT_ROOT": ".",
        "TYPEGRAPH_TSCONFIG": "./tsconfig.json"
      },
      "enabled": true
    },
    "jcodemunch": {
      "type": "local",
      "command": ["npx", "jcodemunch-mcp"],
      "enabled": true
    }
  }
}
```

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Language | TypeScript |
| Terminal UI | SolidJS (OpenTUI) |
| Desktop GUI | Electron + SolidJS |
| AI SDK | Vercel AI SDK |
| Database | SQLite (Drizzle ORM) |
| Build | Turborepo (monorepo) |
| MCP | CodeGraph + TypeGraph + jCodeMunch + Browser MCP |

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## 💙 Acknowledgments

- Original project: [opencode](https://github.com/anomalyco/opencode) by sst.dev
- License: MIT
