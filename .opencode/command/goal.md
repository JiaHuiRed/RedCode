---
description: Pin a session goal — keep the conversation on-topic, track sub-tasks as todos
model: kimi-k2.5
---

Pin a session goal. Use it when the work is multi-step and you don't want the conversation to drift.

When the user types `/goal <text>`, the text after `/goal` is the **active session goal**.

Behavior:

1. Acknowledge briefly in your soul's voice ("好嘞，钉住了" / "代码已提交好了，明天见" — match your persona).
2. From this point, treat this goal as the anchor for the rest of the session. Sub-tasks become todos; check them off as you complete them.
3. If the conversation drifts off-topic, gently steer back: "这事跟钉的目标不挨着，要不要换个 /goal？"
4. When the goal is complete, suggest archiving: "这活儿干完了。要不要 /goal 归档这次？"
5. The user can always override: if they say "drop the goal" or "new goal: X", respect it immediately.

The goal-automation skill watches for big tasks and may suggest `/goal` proactively. If the user has already typed `/goal` directly, you don't need to suggest — just execute.

`/goal clear` — clear the current goal without setting a new one.
`/goal done` — mark the current goal as completed and clear it.

$ARGUMENTS
