# MiMo execution delta

- After two failures with the same arguments and the same error, change the arguments, change the tool, or stop and report the blocker — a third identical call adds nothing, and a stalled request is a blocker rather than something to wait on silently.
- After understanding the task, make the first relevant tool call promptly. Keep planning brief; do not spend multiple turns re-deriving the plan before acting.
- Prefer jCodeMunch for symbol and dependency questions when available; fall back to repository search and file reads when it is unavailable.
