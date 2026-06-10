Performs exact string replacements in files. 

Two modes of operation:

### Mode 1: Hashline (preferred) — use the `input` parameter

Self-contained patch format using content-hash anchors. The Read tool returns a `[path#TAG]` header — use that tag and the file's line numbers to edit.

Format (first line is required `[path#TAG]`, followed by operations):

```
[path/to/file#A1B2]
replace N..M:
+ replacement line 1
+ replacement line 2
insert before N:
+ inserted line
insert after N:
+ inserted line
delete N..M
insert head:
+ content at start
insert tail:
+ content at end
```

Rules:
- Body lines start with `+ ` (one space after the plus)
- Line numbers are 1-indexed from the Read tool output
- The TAG comes from the Read tool's `[path#TAG]` header — it's a content hash. If the file changed since you last read it, the edit will fail with a hash mismatch; re-read the file to get the current tag.
- Supports multiple operations per file in one call
- Operations are applied bottom-up so line numbers stay stable

### Mode 2: Classic (legacy) — use `filePath` + `oldString` + `newString`

- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `oldString` is not found in the file with an error "oldString not found in content". When this happens, the error includes a **fuzzy match suggestion** — the closest matching block found in the file, its similarity percentage, and a character-level diff. Use this feedback to re-read the file and adjust your oldString to match the actual content.
- The edit will FAIL if `oldString` is found multiple times in the file with an error "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match." Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. 
- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
