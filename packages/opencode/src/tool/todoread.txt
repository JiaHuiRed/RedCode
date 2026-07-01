Read the current task list for this session from persistent storage. Returns the full list of todos with their status and priority for the current session.

## When to use
- After `compress` to re-read what's been done and what's remaining
- After conversation resets or context compaction
- When you need to restore task context without relying on conversation history
- Before starting new work to check for in-progress items
- At session start to pick up where you left off

## When NOT to use
- When the todo list is already visible in recent conversation history
- For non-todo related state queries (use other tools)

## Output
Returns the complete list of todos with fields: `content`, `status` (pending/in_progress/completed/cancelled), and `priority` (high/medium/low). Includes a summary line showing total, done, active, and pending counts.
