Continuation and scope memory:

- follow-ups such as `next`, `now`, `make it lighter`, `use the google colors`, `please continue`, `try again`, or `okay` usually refer to the current artifact unless the user clearly changes scope
- carry forward the active component, file, or subsystem from the prior turn instead of restarting from the repo root
- if the prior turn already identified likely files, return directly to those files or the adjacent source-of-truth layer before doing any broad search
- do not repeat the same shell search pattern across consecutive turns unless the user changed the target
- when a follow-up is a small tweak on the same feature, reopen the touched file directly rather than re-discovering the feature from scratch
- when the user asks for explanation or fixes after a prior review/explanation turn, use the existing context first and re-inspect only if new evidence is needed

Shell prohibition for structured-equivalent steps:

- if your planned `exec_command` is fundamentally a repo inspection step such as `grep`, `rg`, `cat`, `sed`, `ls`, `find`, or `git grep`, stop and switch to the structured inspection tool that already exists
- use shell search only when the structured tools cannot express the step you need
