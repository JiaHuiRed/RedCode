# ⚡ RedCode

<p align="center">
  <img src="docs/assets/chi-portrait.webp" height="360" alt="Chi, RedCode's mascot">
</p>

<p align="center"><sub><b>Chi</b> (赤) — RedCode's mascot. She's also both exe icons and the GUI splash.</sub></p>

> **A Chinese-native AI coding agent.** TUI (terminal) or GUI (desktop), speaks your language, plug in any model — DeepSeek, OpenAI, Anthropic, Ollama, domestic-first.
>
> Forked from [opencode](https://github.com/anomalyco/opencode) (sst.dev), with deep enhancements in **prefix cache optimization, multi-model pricing, Chinese UX, and runtime stability**.

[![Version](https://badgen.net/badge/Version/0.10.11/blue)](CHANGELOG.md)
[![License](https://badgen.net/badge/License/MIT/grey)](LICENSE)
[![Platform](https://badgen.net/badge/Platform/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)

---

## ✨ What is this?

An AI coding assistant. **Two entry points, one engine** — same server, same session database, same config. Start a session in the TUI, continue it in the GUI.

<p align="center">
  <img src="docs/assets/screenshot.png" width="760" alt="RedCode TUI screenshot">
</p>

| | |
| --- | --- |
| **TUI** `packages/opencode` | Terminal interface, single-file exe. A bare launch opens a workspace selector (mouse-clickable, scrollable, or type any path). Pluggable sidebar. |
| **GUI** `packages/desktop` | Electron desktop window. Home screen carries a **usage dashboard**; sessions get diff review, file preview (image / audio / PDF), and a context-usage tab. Tauri migration in progress — `src-tauri/` scaffolding is in place, build pipeline not yet wired. |

Reads code, writes code, fixes bugs, runs commands.

---

## 🧠 Core capabilities

| Area | What you get |
| --- | --- |
| **Code understanding** | jCodeMunch / TypeGraph indexing, cross-file navigation and blast-radius analysis |
| **Doing** | File read/write/edit · terminal execution · web search · vision (multimodal models read images directly; a subagent can also be delegated) |
| **Models** | DeepSeek / OpenAI / Anthropic / GLM / Qwen / MiniMax / Ollama… assignable per role |
| **Context** | Prefix cache freshness · automatic compaction · context usage visualization |
| **Organization** | Session management · goal tracking · automated memory system · Skill system |
| **Agents** | Four-role subagents (explore / architect / fixer / reviewer) · custom AI personas |
| **Safety** | Permission gating and guard rails — three postures below |

### Three permission postures

The dropdown under the prompt box *is* the permission axis. The three postures **differ only in permissions** — same prompt, same model:

| Posture | What it can do |
| --- | --- |
| **Plan** 🟦 | Read and propose only. `edit: deny` — it can hand you a plan but cannot land it. |
| **RedMind** 🟥 | The default. Acts, but asks first for destructive commands, directories outside the worktree, and `.env` reads. |
| **Auto** 🟧 | No interruptions; everything above is auto-approved. Only for tasks you've already vetted. |

### Highlights

- **Prefix cache freshness**: multi-layer caching (msgPin → modelMsgs → tools → system) keeps input cost low
- **Model pricing**: full DeepSeek cache billing tiers, fixes upstream `cacheReadInputTokens=0` under-report; ChatGPT / Codex plan quotas (5-hour window, 7-day window, reserve pool) get panels in both the TUI sidebar and the GUI context tab
- **Usage dashboard**: project-level totals on the home screen — cache-hit ring, sessions / requests / output tokens, active and streak days, an activity heatmap, and per-model stacked bars by day. Backed by a server-side aggregation endpoint rather than a client-side reduce over whatever sessions happen to be loaded
- **Chinese UX**: full Chinese docs and UI, trilingual i18n (zh / en / ja)
- **Domestic models first**: zero-config for DeepSeek, GLM, Qwen, MiniMax, Zhipu
- **Multi-machine sync**: machine-local override layer `redcode.local.jsonc` keeps synced configs machine-neutral
- **Stability work**: 0.10.0 landed a desktop performance pass — the bottleneck was synchronous I/O on the main process, not rendering. Startup-to-connected went 7.28s → 5.71s, first-screen chunk shrank by 1.26MB, and streaming re-parse per tick dropped to 1/16. Details in [CHANGELOG.md](CHANGELOG.md)

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

Output: `packages/opencode/dist/redcode-windows-x64/bin/redcode.exe` — double-click to run.

### 📱 From your phone

```bash
redcode web --hostname 0.0.0.0
```

Open the `Network access` URL printed in the terminal from any browser on the same LAN. **A password is mandatory for LAN-visible binds** — without one the launch is refused outright, not warned about and allowed through.

---

## ⚙️ Configuration

### Config File Locations

Listed in load order — **later entries override earlier ones**:

| Location | Purpose |
|----------|---------|
| `~/.redcode/redcode.jsonc` | Global config (cross-project) |
| `~/.redcode/redcode.local.jsonc` | Machine-local overrides — absolute paths, VRAM-dependent model tiers, machine-only MCP servers. Keep it out of version control when syncing `~/.redcode/` across machines |
| `project_dir/redcode.jsonc` | Project-level config |
| `project_dir/.redcode/redcode.jsonc` | Project-level config (`redcode.local.jsonc` works here too, same precedence rule) |

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
