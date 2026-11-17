Re-read a specific code symbol (function, class, etc.) by its snippet ID, without reading the entire file.

- Snippet IDs are returned by the Read tool in the `<snippets>` section (e.g. `AgentRunner_L12`).
- The output includes line numbers and a `[path#TAG]` header, so you can directly use it with the Edit tool's hashline format.
- Use this when you need to revisit a specific function or class you've already seen, saving context window space.
- If the snippet ID is not found (e.g. the file was modified), re-read the file to get updated snippet IDs.
