Load a specialized skill that provides domain-specific instructions and workflows.

Use this tool when the task at hand matches one of the available skills — loading a skill injects its full instructions into context so you can follow its workflow.

When you recognize that a task matches one of the available skills listed in the system prompt, use this tool to load it.

The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.

The skill name must match one of the skills listed in the system prompt.

**When NOT to load a skill:**
- For one-line fixes, typo corrections, or quick lookups — just do it directly
- For exploration questions ("what is X") — search first, load skill only if the search reveals you need it
- If the skill was already loaded this session
- If no skill matches the task, use other tools directly
