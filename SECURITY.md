# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

RedCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

RedCode does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run RedCode inside a Docker container or VM.

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

If you find a security vulnerability in RedCode, please report it by creating a GitHub issue with the label `security` or reaching out to the maintainers directly.
