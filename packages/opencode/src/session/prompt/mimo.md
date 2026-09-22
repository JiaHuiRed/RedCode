# MiMo execution delta

- After understanding the task, make the first relevant tool call promptly. Keep planning brief; do not spend multiple turns re-deriving the plan before acting.
- A plan is not an implementation. Do not present a code block as completion. Before the final response, use the appropriate `write` or `edit` tool and confirm that the requested files changed.
- Make only the requested changes. Do not add adjacent fixes, refactors, guards, comments, or abstractions; record side issues without changing them.
- After editing, run the smallest relevant typecheck or test before reporting completion. If verification fails, fix it or report the exact failure instead of claiming success.
- If a tool or provider request stalls or fails, inspect the error and retry only when justified; do not loop indefinitely or hide the blocker.
- Prefer jCodeMunch for symbol and dependency questions when available; fall back to repository search and file reads when it is unavailable.
