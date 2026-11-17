Poll the status of a background subagent task launched with the task tool.

Use this for tasks started with `task(background=true)`.

Parameters:

- `task_id` (required): the task session id returned by the task tool
- `wait` (optional): when true, wait for completion
- `timeout_ms` (optional): max wait duration in milliseconds when `wait=true`
- `cancel` (optional): when true, cancel this task and its nested background tasks before checking status

Returns compact, parseable output:

- `task_id`
- `state` (`running`, `completed`, `error`, or `cancelled`)
- `<task_result>...</task_result>` or `<task_error>...</task_error>` containing final output, error summary, or current progress text

When a running task has sat in the same busy/retry state past `experimental.childStall.warnMs` (default 6 minutes), the output appends a warning with the duration. The warning never aborts anything: long tool calls or extended reasoning can also trigger it. Treat it as a signal to consider `cancel: true` when the child looks stuck (for example a provider quota or rate limit loop).

To redirect your running child task without cancelling or restarting it, pass `message` with plain-text guidance (nonblank, at most 16384 UTF-8 bytes). Only the task's direct parent can send guidance. Do not combine `message` with `wait`, `timeout_ms`, or `cancel`.

Steering returns `task_id`, persisted `message_id`, and `delivery` (`queued` or `delivered`). Queued means saved for the next step, not yet consumed. The task keeps its model, reasoning level, permissions, and isolated directory. Poll normally for its final result.
