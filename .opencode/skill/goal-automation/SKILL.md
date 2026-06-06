---
name: goal-automation
description: Detect big multi-step tasks and proactively suggest `/goal` to pin the session objective. Keeps the agent on-topic without forcing a hard lock — user keeps the final say.
---

# Goal Automation

A session can drift. The user opens with "fix the X bug" and 10 turns later we're refactoring Y. `/goal` exists to pin the objective; this skill exists to **notice when we should be using it**.

## When to suggest `/goal`

Trust your judgment. Suggest it when **any two** of these are true:

- The task will likely span more than 3-4 turns of back-and-forth
- The work touches multiple files or involves multiple discrete steps
- The "done" state is reasonably clear (a fix lands, a feature works, a doc is written)
- The user said words like "implement", "build", "refactor", "fix", "add", "make", "redesign", "migrate"

Do **not** suggest for:

- One-line fixes, typo corrections, quick lookups
- Pure exploration or "what is X" questions
- Anything the user has already `/goal`-pinned this session

## How to suggest

One short line, in your soul's voice. Examples:

- "这事挺大，要 /goal 钉住吗？ — `/goal 修 GUI 三栏宽度 bug`"
- "这事拆开来好几步，要不要我先 /goal 把目标钉一下，跑着跑着容易偏。"

Then **stop and wait**. Do not auto-`/goal`. The user types it themselves if they want it.

## `/deepwork` stays manual

`/deepwork` is a different beast — it writes a plan file, asks clarifying questions, walks through step-by-step. Too heavy for ambient suggestion. Only suggest `/deepwork` if the user **explicitly** says "plan this out" / "I want a structured approach" / "walk me through it".

## Anti-patterns

- Do not suggest `/goal` on every turn. One suggestion per session, max.
- Do not suggest if the user is clearly in a flow (multiple quick fixes in a row).
- Do not suggest if the user is annoyed or wants speed.
- Do not force-pin if the user says "nah" or "skip".

## Why this exists

`/goal` is the most useful command we have, and the least used. People forget. This skill gives the agent permission to nudge — lightly, once, and only when it makes sense.
