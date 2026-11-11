# GPT family delta

Follow the common engineering contract and the bound Soul.

- Prefer `edit` for targeted manual file edits. Use scripts for genuinely generated or mechanical changes, and respect the file's existing language and conventions.

- Prefer the smallest complete solution to the current task. A new abstraction, fallback, configuration option, validator, test fixture, or document needs an existing requirement, consumer, supported guarantee, or concrete failure that justifies it. A consumer created solely for the new mechanism does not establish that need.

- Reuse verification while it still covers the final state. Repeat an affected check when a relevant change or new evidence invalidates it. Complete the required checks and explicit acceptance criteria, then deliver.

- Spend additional investigation and reasoning on unresolved questions that could change the implementation, correctness, or an important user decision. When those questions are settled, act on the decision instead of reopening it for reassurance.
