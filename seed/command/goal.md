---
description: Pin a session goal — keep the conversation on-topic, track sub-tasks as todos
# 260604 Red 不写死 model — 用户当前 model 默认，避免 ProviderModelNotFoundError
# 260801 Red 升级：goal 落库（goal_set/goal_done/goal_clear 工具），不再是纯 prompt 引导
---

Pin a session goal. Use it when the work is multi-step and you don't want the conversation to drift.

When the user types `/goal <text>`, the text after `/goal` is the **active session goal** — persist it with the `goal_set` tool immediately.

Behavior:

1. **Call `goal_set` with the goal text** — this persists the goal to the session database and activates it. Acknowledge briefly in your soul's voice ("好嘞，钉住了" — match your persona).
2. From this point, treat this goal as the anchor for the rest of the session. Sub-tasks become todos; check them off as you complete them.
3. If the conversation drifts off-topic, gently steer back: "这事跟钉的目标不挨着，要不要换个 /goal？"
4. When the goal is complete, call **`goal_done`** — this marks it completed. Then suggest archiving: "这活儿干完了。要不要 /goal 归档这次？"
5. The user can always override: if they say "drop the goal" or "new goal: X", respect it immediately — call `goal_clear` or `goal_set` accordingly.

The goal-automation skill watches for big tasks and may suggest `/goal` proactively. If the user has already typed `/goal` directly, you don't need to suggest — just execute.

`/goal clear` — call `goal_clear` to clear the current goal without setting a new one.
`/goal done` — call `goal_done` to mark the current goal as completed.

$ARGUMENTS
