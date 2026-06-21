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

> **A Chinese-native desktop AI coding agent — standalone GUI, speaks your language, plug in any model (DeepSeek / MiMo / domestic-first).**
>
> Author: Red · Forked from [opencode](https://github.com/anomalyco/opencode) (sst.dev).
[![TUI](https://badgen.net/badge/TUI/0.6.16/blue)](CHANGELOG.md)

[![Desktop](https://badgen.net/badge/Desktop/0.6.9/purple)](CHANGELOG.md)
[![License](https://badgen.net/badge/License/MIT/grey)](LICENSE)
[![Platform](https://badgen.net/badge/Platform/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

Open-source AI coding assistant with **terminal TUI** and **desktop GUI** interfaces. Reads your codebase, executes commands, edits files, searches code, and completes programming tasks through natural language conversation.

---

## 🧩 Features

- 💬 **Natural Language Coding** — describe requirements, auto-complete code
- 🔌 **Multi-Model Support** — DeepSeek, MiMo, OpenAI, Anthropic, Google Gemini, Ollama, etc.
- 🛠 **Tool System** — file read/write, code search, git status/diff/log, terminal commands, web search, environment info
- 🤖 **Smart Agents** — Build, Plan, General, Explore agents built-in, custom agents supported
- 📝 **Session Management** — history save, restore, fork
- 🎨 **Terminal UI** — syntax highlighting, streaming output, diff display
- 🖥 **Desktop GUI** — Electron standalone window with full graphical interface
- 📊 **MCP Servers**:
  - [TypeGraph](https://github.com/guyowen/typegraph-mcp) — TypeScript semantic navigation (type resolution, barrel file traversal, cycle detection)
  - [jCodeMunch](https://github.com/colbymchenry/jcodemunch) — structured code retrieval (60+ tools: symbol lookup, dead code detection, AST matching)
  - ~~Browser MCP~~ — browser automation (disabled, stability issues)
- 🔒 **Permission System** — tool call confirmation, auto-approve support
- 🌍 **Multi-language** — Chinese, English, Japanese, and 18 languages
- 🗣 **TTS** — MiMo TTS voice reading for AI responses

---

## 🖥 Desktop GUI

- **Three-column layout**: FileTree (left) + Chat (center) + Review (right), independently resizable
- **V2 Titlebar**: Tab-based session management, StatusPopover for token usage, `Cmd+T` / `Cmd+Shift+T` to switch sessions
- **Project shortcuts**: `Cmd+1` ~ `Cmd+9` to switch projects
- **Semantic color layering**: `theme.colors` grouped by text/surface/border/status/diff/markdown/syntax, customizable themes
- **ECC plugin integration**: Auto file change tracking, context compression optimization, safe auto-approval
- **Version auto-injection**: Titlebar version badge auto-injected from `package.json` at build time
- **Thinking hamster animation**: 🐹 running animation + Mona cat loading during AI thinking
- **Design system**: CSS design tokens (radius, shadows, typography), `text-wrap: balance/pretty`

---

## 🚀 Run from Source

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

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
| `~/.redcode/redcode.jsonc` | Global config (cross-project) |
| `project_dir/redcode.jsonc` | Project-level config |
| `project_dir/.redcode/redcode.jsonc` | Project-level config |

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
| MCP | TypeGraph + jCodeMunch + Browser MCP |

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## 💙 Acknowledgments

- Original project: [opencode](https://github.com/anomalyco/opencode) by sst.dev
- License: MIT
