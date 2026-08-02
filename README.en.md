# ⚡ RedCode

<p align="center">
  <img src="docs/assets/screenshot.png" width="720" alt="RedCode TUI screenshot" style="border-radius: 8px;">
</p>

> **A Chinese-native AI coding agent.** TUI (terminal) or GUI (desktop), speaks your language, plug in any model — DeepSeek, OpenAI, Anthropic, Ollama, domestic-first.
>
> Forked from [opencode](https://github.com/anomalyco/opencode) (sst.dev), with deep enhancements in **prefix cache optimization, multi-model pricing, Chinese UX, and runtime stability**.

[![TUI](https://badgen.net/badge/TUI/0.8.7/blue)](CHANGELOG.md)
[![Desktop](https://badgen.net/badge/Desktop/0.7.13/purple)](CHANGELOG.md)
[![License](https://badgen.net/badge/License/MIT/grey)](LICENSE)
[![Platform](https://badgen.net/badge/Platform/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

AI coding assistant, two entry points, one engine:

- **TUI** — terminal interface (`packages/opencode`)
- **GUI** — desktop window, Electron (`packages/desktop`; a Tauri migration is in progress, not yet buildable)

Reads code, writes code, fixes bugs, runs commands. You speak Chinese (or any language), it does the work.

### Core capabilities

Code understanding (jCodeMunch / TypeGraph) · Multi-model (DeepSeek / OpenAI / Anthropic / Ollama) · File read/write/edit · Terminal execution · Web search · Vision analysis · Session management · Permission gating · Context compaction · Automated memory system · Goal tracking · Skill system · Anti-repeat loop detection · Custom AI personas

### Why RedCode?

| vs upstream OpenCode | RedCode |
|---|---|
| Cache hit rate | **97%+** (multi-layer prefix cache: msgPin → modelMsgs cache → tools cache → system cache) |
| Model pricing | Full DeepSeek cache billing tiers (miss/write/hit), fixes upstream `cacheReadInputTokens=0` under-report |
| Chinese UX | Full Chinese docs, Chinese UI, bilingual README |
| Stability | Event loop drift detection, independent sidecar health monitoring, DCP double-compaction guard |
| Domestic models first | Zero-config for DeepSeek, GLM, Qwen, MiniMax, Zhipu, plus NVIDIA-hosted third-party |

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

### Build (Windows single-file exe)

```bash
cd packages/opencode && bun run build
```

Output: `packages/opencode/dist/redcode-windows-x64/bin/redcode.exe` — double-click to run. A bare launch (no directory argument) opens a workspace selector: pick a registered project, or use "Open a different directory..." to type or paste any path (since 0.7.31).

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
