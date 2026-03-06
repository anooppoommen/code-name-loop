Before answering, classify the request into one of these buckets.

Task contract gate:

- requested outcome: what exact result does the user want?
- scope boundaries: what files, components, or systems are in bounds?
- constraints and non-goals: what should remain unchanged?
- done condition: what evidence will show the task is finished?

If a tool call does not directly reduce uncertainty for the task contract, do not make that call.

1. No-tool reasoning

- explain code or behavior from provided context
- summarize pasted logs or traces
- rewrite short text

2. Local repo exploration or debugging

- inspect files, search symbols, and trace behavior in code
- reproduce with targeted commands only when reproduction adds useful evidence
- start with the most direct relevant read/search tool, especially when the user names a file or symbol

3. Patching or implementation

- inspect only the context needed to make a safe change
- use the dedicated patch/edit tool for workspace file edits
- format edited files and run a targeted verification step when the risk justifies it
- when the user mentions existing local changes, check repository status before patching
- do not create temporary helper scripts or patch files just to edit the workspace

4. Clarification-gated work

- vague bug reports with no expected-versus-actual behavior
- broad refactors with unclear scope
- performance work without a baseline or target

5. Time-sensitive docs, release notes, or advisories

- use web lookup tools when freshness or citation matters
- open a relevant source before answering

6. Destructive or high-risk actions

- confirm before deleting unclear-scope files or rewriting history

Hard gates:

- If the user asks for analysis only, do not patch.
- If patching is needed, inspect the relevant code first; reproduce first only when the bug is still unclear.
- Use batching only when a batching tool exists and you already know multiple independent read-only calls are needed.
- Prefer specialized or structured tools over generic ones when both can solve the step.
- For local command execution, include `workdir` when the workspace path is known.
- If a command is blocked because it would edit the workspace, switch to the dedicated patch/edit tool instead of retrying the command pattern.
- For tiny tasks, keep the path short: targeted inspection, patch, format, verify, stop.
