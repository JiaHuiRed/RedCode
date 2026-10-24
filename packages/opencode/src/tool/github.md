Interact with GitHub via the authenticated `gh` CLI — no extra tokens needed. Read PRs, review comments, CI checks, diffs, issues, and lists: enough to ingest reviewer feedback, triage, and verify CI without leaving the conversation. Read-only; never creates or modifies anything on GitHub.

When to use:
- A PR exists (after push or when reviewing): `pr_reviews` pulls review threads with inline comments mapped to `path:line`; `pr_checks` shows CI status; `pr_diff` the bounded patch; `pr` one PR's metadata and description.
- Triage: `list` open PRs/issues; `issue` reads an issue together with its comments.

Notes: runs from the current working directory — the repository is resolved from git remotes, so it only works inside a GitHub repo. Requires `gh` installed and authenticated (`gh auth login`). Outputs are bounded (diff ≤ 50KB, long bodies capped with a truncation marker).
