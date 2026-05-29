# ⚡ RedCode

<p align="center">
  <img src="packages/web/src/assets/lander/mona-loading.gif" width="80">
</p>
<pre align="center">
█████ █████ █████ █████ █████ █████ █████
█   █ █     █  ██ █     █   █ █  ██ █    
████  █████ █   █ █     █   █ █   █ █████
█  ██ █     █   █ █     █   █ █   █ █    
█   █ █████ █████ █████ █████ █████ █████
</pre>

> **Open-source AI coding assistant — terminal-based intelligent coding agent.**

[![TUI](https://img.shields.io/badge/TUI-0.3.2-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.3.4-0078d4)](CHANGELOG.md)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2011-lightblue)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

RedCode is an AI coding assistant (Coding Agent) that runs in the terminal. It can read your codebase, execute commands, edit files, search code, and complete programming tasks through natural language conversation.

Supports DeepSeek, OpenAI, Anthropic, Google, Ollama and many other model providers.

---

## 🚀 Run from Source

```bash
# Clone
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode

# Install dependencies
bun install

# Start
bun dev
```

---

## 💬 Usage

```bash
# Start interactive terminal
redcode

# Run a single task
redcode run "refactor src/utils.ts"

# Use a specific model
redcode run --model deepseek/deepseek-v4-flash "explain this code"
```

---

## 🧩 Features

- 💬 **Natural Language Coding** — describe requirements, auto-complete code
- 🔌 **Multi-Model Support** — DeepSeek, OpenAI, Anthropic, Ollama, etc.
- 🛠 **Tool System** — file read/write, code search, terminal commands, MCP servers (built-in [CodeGraph](https://github.com/colbymchenry/codegraph) code knowledge graph)
- 🤖 **Custom Agents** — Build, Plan, General agents built-in
- 🎨 **Terminal UI** — syntax highlighting, streaming output, diff display

---

## ⚙️ Configuration

Config file: `~/.config/redcode/config.json`

```json
{
  "provider": {
    "my-provider": {
      "type": "openai",
      "apiKey": "sk-xxx",
      "baseURL": "https://api.example.com/v1"
    }
  },
  "model": {
    "my-model": {
      "provider": "my-provider",
      "model": "gpt-4o"
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
| Terminal UI | Ink (React for CLI) |
| AI SDK | Vercel AI SDK |
| Database | SQLite (Drizzle ORM) |
| Build | Turborepo (monorepo) |

---

## 💙 Acknowledgments

Fork of [opencode](https://github.com/anomalyco/opencode) by sst.dev.

- License: MIT
