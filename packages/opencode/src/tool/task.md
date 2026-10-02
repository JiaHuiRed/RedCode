Delegate a broad investigation or a well-scoped implementation to an available agent. Use file/search tools directly for a focused known-file or symbol lookup; do not delegate when no agent fits.

- Set `subagent_type` to an available agent type.
- A fresh invocation has a fresh context. Give it the objective, exact scope, constraints, read-only versus implementation mode, expected result, and verification. Do not assume it sees the parent conversation.
- Set `task_id` only to resume a supported subagent session; its prior context is preserved. `explore` does not accept `task_id` resumes.
- `isolation="worktree"` gives the agent a separate directory and branch. Its edits stay there; inspect and integrate them before treating the parent workspace as changed. Omit isolation for read-only investigation unless a separate environment is needed.
- Subagent output is not a user-facing reply. Inspect its evidence, verify consequential conclusions, then report the result to the user.
- Independent agents may run concurrently. Do not assign overlapping files or shared resources to concurrent mutating agents.
- Difficulty or the first failed attempt is not a stopping condition. Ask the agent to pivot on evidence and report only a concrete persistent blocker.
