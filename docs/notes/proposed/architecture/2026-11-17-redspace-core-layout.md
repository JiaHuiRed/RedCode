# RedSpace 0.19.0 — shared engine source-layout migration (review candidate)

Status: **proposed**. Branch: `refactor/redspace-core-layout`.

## Decision
- `packages/opencode/` becomes `packages/redspace/`. The directory is the shared Chat/Code server and TUI harness, **not** a standalone TUI frontend.
- Preserve the existing `redcode` executable, `@redcode-ai/*` workspace package identities, local `~/.redcode` user data and configuration keys in this stage. Introduce `redspace` as an additional CLI alias. Do not make memory or provider authentication migrations an implicit consequence of a source-directory rename.
- Update root entrypoints, desktop Electron Node-sidecar bundling, developer tooling, documentation and CI to match the new physical directory.
- Retain OpenCode authorship and licensing history, and genuine OpenCode provider identifiers; this is product independence, not historical erasure.

## Review and acceptance
```powershell
git fetch origin
git switch refactor/redspace-core-layout
bun install
bun run check:redspace-layout
bun run script/check-version-consistency.ts
bun run check:entry-graphs
bun run typecheck
bun dev --help
bun run dev:desktop
```

Then verify TUI Chat/Code switching, imported companion read/write, GUI sidebar/Chat/Code switching, Electron sidecar boot, and existing `redcode` CLI compatibility. On Windows, inspect the generated binary packaging paths and update release scripts as needed.

## Remaining migration work
- End-user product labels now read RedSpace (window title, tray, installer, Start menu shortcut, exit prompt, startup-failure dialog; dev/beta/prod render as RedSpace Dev / RedSpace Beta / RedSpace). `appId`, deep-link scheme, settings directory, workspace package names, the `redcode` executable and telemetry identity keep RedCode identifiers so existing installs, local data and external links stay continuous.
- Historical architecture notes keep the previous paths for provenance.
- Third-party package/provider names containing OpenCode refer to real upstream integrations and must not be mechanically replaced.
- This refactor branch was prepared using GitHub source analysis, without a Windows/Bun runtime test; **do not merge until both TUI and GUI smoke tests pass**.
