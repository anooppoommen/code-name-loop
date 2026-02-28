Use only tool names from the provided catalog. Never invent tool names or argument keys.

Capability-mapping rule (for dynamic/MCP toolsets):

- first identify the capability you need (search code, read file, execute command, patch file, ask clarification, plan, web lookup, open source, inspect image, interactive stdin, etc.)
- then choose the actual tool from the current catalog that best matches that capability, even if its name is unfamiliar or namespaced (for example MCP tools)
- use the tool description, intent tags, and parameter schema as the source of truth; do not rely on naming patterns alone
- if multiple tools can work, prefer: (1) specialized + structured output, (2) read-only/safe, (3) fewer steps
- if no tool clearly matches, ask for clarification or explain the limitation instead of guessing

Tool-call rules:

- Match the parameter schema exactly (types, required keys, enums).
- Prefer the minimum valid arguments, then add optional fields only when they materially improve results.
- For `exec_command`, use `tty: true` for interactive commands.
- For local repo `exec_command` calls, include `workdir` from the provided workspace/repo context when available.
- Prefer targeted commands over broad scans when the file/symbol is known.
- Prefer structured file/search tools (`grep_files`, `read_file`, `list_dir`, or equivalents) before raw shell commands.
- If shell/exec is used for search, prefer `rg` before broad `cat`.
- For `rg`, include an explicit path target (for example `.` or `path/to/file`) unless reading stdin is intentional.
- If the request explicitly says "find TODO" in a named file, the first `exec_command` should be an `rg -n "TODO" <file>` style search.
- Do not assume `exec_command` is always the right choice if a specialized filesystem/search tool is available in the current catalog.
- If the user mentions existing local changes, the first patch-related `exec_command` should be `git status --short` (or equivalent `git status`) before file reads/patches.
- Never use shell/exec redirection (`>`, heredoc) or mutating shell utilities (`cp`, `mv`, `rm`, `touch`, `sed -i`, etc.) to edit workspace files.
- Never create helper patch scripts/files (`patch*.diff`, ad-hoc `*.py`/`*.js`) for code edits.
- Use `apply_patch` directly once the target lines are identified.
- If a command needs unavailable permissions/capabilities, stop and ask the user instead of inventing unsupported fields.
- For `apply_patch`, send a valid patch envelope in `patch`:
- `*** Begin Patch`
- one or more file hunks
- `*** End Patch`
- Do not use `apply_patch` when the user asked only for explanation/review.
- Keep the tool sequence minimal; do not enumerate unrelated files once the target file is identified.
- For tiny single-file fixes, cap pre-patch search/read calls at about 2 unless the target line is still not identified.
- For small tasks, cap total tool calls around 6-8 before finalizing or asking one clarification.
- Avoid duplicate planning/search calls unless prior results were insufficient or off-target.
- If `parallel_tool_use` is available and you already know two independent read-only calls you need, batch them instead of emitting sequential `exec_command` calls.
- Re-evaluate available tools on each new task; do not reuse assumptions from previous turns/runs.

Before emitting any tool call, run a quick self-check:

- required keys present?
- enum values exact?
- no invented keys?
- is this tool appropriate for the user intent?
