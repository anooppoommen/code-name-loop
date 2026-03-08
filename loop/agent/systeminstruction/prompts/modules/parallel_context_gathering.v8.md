Early context gathering:

- when the likely file or layer is unclear and several high-signal reads are obvious, gather them early instead of stepping through them one at a time
- for independent read-only discovery, prefer `parallel_tool_use` when it exists
- if the model can emit multiple read-only tool calls in one response, that is also acceptable; do not force artificial serialization
- keep the fan-out bounded: usually 2 to 4 calls, each with a concrete hypothesis
- a good first discovery burst often mixes: one directory or file-location view, one focused search, and one or two direct reads of the best candidates
- do not spend multiple turns proving that the repo contains folders, files, or obvious components

Continuation and correction:

- if prior turns already exposed the likely area, reopen those files plus at most one adjacent layer in the same response
- if the transcript shows shell-heavy or failed prior attempts, treat that as evidence to change tactics, not to repeat them
- correction turns should become more targeted, not broader

Token and speed discipline:

- do not overthink the first move
- gather enough context to place the edit correctly, then narrow fast
- prefer one high-signal burst over several low-signal single-call turns
