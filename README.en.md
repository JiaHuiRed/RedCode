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
[![TUI](https://badgen.net/badge/TUI/0.7.22/blue)](CHANGELOG.md)

[![Desktop](https://badgen.net/badge/Desktop/0.7.4/purple)](CHANGELOG.md)
[![License](https://badgen.net/badge/License/MIT/grey)](LICENSE)
[![Platform](https://badgen.net/badge/Platform/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

AI coding assistant, two entry points, one engine:

- **TUI** — terminal interface (`packages/opencode`)
- **GUI** — desktop window, Electron + SolidJS (`packages/desktop`)

Reads code, writes code, fixes bugs, runs commands. You speak Chinese (or any language), it does the work.

### Core capabilities

Code understanding (TypeGraph / jCodeMunch) · Multi-model (DeepSeek / OpenAI / Anthropic / Ollama) · File read/write/edit · Terminal execution · Web search · Vision analysis · Session management · Permission gating · Context compaction · Automated memory system · Goal tracking · Skill system · Anti-repeat loop detection · Custom AI personas

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
      "command": ["uvx", "jcodemunch-mcp"], // or: pipx run jcodemunch-mcp / pip install jcodemunch-mcp
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
| MCP | TypeGraph + jCodeMunch |

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## 💙 Acknowledgments

- Original project: [opencode](https://github.com/anomalyco/opencode) by sst.dev
- Code search powered by [jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp)
- License: MIT
