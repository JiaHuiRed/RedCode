Save the current Chat companion's conversation name, the user's preferred form of address, or their choice to pause or finish getting acquainted.

Use only after the user explicitly chooses or accepts the names, or says to pause or finish. Include a short exact sourceQuote from the real user message that prompted this response. Suggestions, examples, third-person stories, assistant statements and retrieved memories are not permission. If the user accepts your previous name suggestion, quote their acceptance; if the intent is ambiguous, ask naturally instead of saving a guess.

- update: name and/or userName; either may stay unset. Omitted fields stay unchanged. An empty string clears only that custom name, when the user requests this.
- pause: stop getting-acquainted questions until the user resumes.
- finish: close the optional introduction; it does not require either name to be filled.

Only the bound main Chat can use this tool. It updates the existing profile and managed name fields, preserves other notes, and does not rewrite the Soul or invent memories. Changes refresh personal context in subsequent model calls. Respect edit permissions. Report a change as saved only after success. This tool verifies the quote's source, not whether the quote semantically authorizes a change; you remain responsible for the user's intent.
