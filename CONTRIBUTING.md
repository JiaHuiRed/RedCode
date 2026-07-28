# Contributing to RedCode

RedCode is a personal fork of [opencode](https://github.com/anomalyco/opencode), maintained by one person and **developed and tested only on Windows 10/11** — other platforms are neither built nor verified.

The repository is public for transparency and backup, not because it is looking for contributors. There is no automated issue/PR triage here, and responses depend on the maintainer's time. If you want to build on this, forking is usually the faster path.

## Development

Requirements: Windows 10/11, [Bun](https://bun.sh), Node 24.

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

Common commands:

```bash
bun dev                                       # start the TUI (from packages/opencode)
bun turbo typecheck                           # typecheck the whole repo
bun run script/check-version-consistency.ts   # verify version numbers agree
```

For a single package, run `bun run typecheck` in that package's directory. **Do not run `tsc` at the repo root** — this is a monorepo and the root has no usable tsconfig entry point.

Build output: `packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`.

See [MANUAL.md](MANUAL.md) for configuration, MCP servers and skills, and [AGENTS.md](AGENTS.md) for the working conventions given to AI agents. A Chinese version of this file is at [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md).

## Code style

- TypeScript, Effect v4 (a beta line — the API moves; check the version installed in `node_modules`)
- Follow the surrounding style; do not add abstraction layers without a concrete reason
- Typecheck before committing
- Comments explain *why*, especially where the code works around a specific trap

## Commits

Conventional Commits: `type(scope): summary`

Types: `feat` `fix` `docs` `chore` `refactor` `test`
Scopes: `core` `redcode` `tui` `app` `desktop` `sdk` `plugin`

Commits made by an AI agent are prefixed with `[Karina] ` or `[YuQi] `; human commits are not.

## CI

Three workflows, all Windows-only: `test` (unit + e2e), `typecheck`, and `audit` (daily dependency vulnerability scan). Upstream opencode's distribution channels, docs site and community bots have been removed.
