# Security

RedCode is a single-maintainer personal fork of [opencode](https://github.com/anomalyco/opencode),
developed and tested only on Windows 10/11. What follows describes how the tool actually behaves —
it is not a support commitment.

## Threat Model

### Overview

RedCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

RedCode does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run RedCode inside a Docker container or VM - see [containerization.md](packages/opencode/docs/containerization.md) for concrete recipes and their trade-offs (in short: both protect your host, neither protects API keys you pass into the sandbox from a compromised session).

### Trust Model

- **Local users** are considered trusted
- **Agent** is considered untrusted but operating under user supervision
- **Remote APIs** (LLM providers) may observe code context sent in requests
- **Third-party plugins** may have access to the same capabilities as the agent

### Tool Permissions

| Tool      | Requires Approval | Notes                |
| --------- | ----------------- | -------------------- |
| Read      | ❌                |                      |
| Write     | ⚠️  Configurable |                      |
| Edit      | ⚠️  Configurable |                      |
| Grep/Glob | ❌                |                      |
| Shell     | ✅                |                      |
| Web       | ⚠️  Configurable |                      |
| MCP Tools | ⚠️  Configurable | Depends on MCP server|

### Reporting a Vulnerability

Open a GitHub issue at [JiaHuiRed/RedCode](https://github.com/JiaHuiRed/RedCode/issues). There is one
maintainer and no triage automation, so response time varies.

If the issue affects **upstream opencode** rather than this fork specifically, report it there instead —
that is where it can actually be fixed for everyone.
