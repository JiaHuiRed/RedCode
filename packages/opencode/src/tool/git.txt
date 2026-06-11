Execute git operations with structured output. Use this tool instead of shell when you need to inspect repository state — it returns cleaner, more parseable output than raw git commands.

### Usage patterns

- **status** — working tree status (modified, staged, untracked files). Use BEFORE making edits to know the starting state.
- **diff** — diff against a reference (HEAD, a branch, a commit). Use to review what changed between commits or what's unstaged.
- **log** — recent commit history (default 10). Pass `maxCount` to get more or fewer.
- **show** — show file content at a specific ref or commit. Use to inspect historical versions.
- **branch** — current branch name and default branch.
- **stash list** — list stashes.

### Git operations are read-only in this tool. For committing, pushing, pulling, branching, merging, or any other write operations, use the shell tool instead so permission rules apply.
