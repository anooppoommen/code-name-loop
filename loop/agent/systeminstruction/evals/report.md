**Prompt Eval Report**

Source basis:

- database: `loop/loop.db`
- workspace: `code-name-agent`
- root conversations analyzed: `86`
- user turns converted into eval cases: `202`

**Why The Model Was Missing**

The failures were concentrated in tool choice and recovery, not basic intent classification.

- `exec_command` dominated the historical tool mix: `1936` calls vs `185` `read_file`, `121` `grep_files`, and `70` `list_dir`
- recent failure-heavy conversations showed repeated shell churn, approval churn, and correction loops rather than single bad turns
- the model usually understood that a task was a patch/debug task, but still started with shell search instead of the structured repo tools
- correction turns such as `That did not work`, `Try again`, and `still not fixed` often did not fully reset the approach; the model kept re-scanning or patching shallow layers
- long-turn follow-ups often forgot the active artifact and restarted discovery from the repo root

Observed failure clusters from the baseline suite run:

- `shell_first_when_structured_tools_fit`: `133` cases
- `forbidden_first_tool:exec_command`: `82` cases
- lowest scoring tag: `correction` at `37.8`

**Suite Artifacts**

- full generated suite: `agent/systeminstruction/evals/recent_conversations.v1.json`
- baseline results: `agent/systeminstruction/evals/results/v4-full.json`
- iteration 1 results: `agent/systeminstruction/evals/results/v5-full.json`
- iteration 2 results: `agent/systeminstruction/evals/results/v6-full.json`

Each case includes:

- reconstructed turn input
- prior-turn context
- expectations for intent, inspection behavior, and tool discipline
- original-run metadata from the real conversation

**Scores**

`v4` current prompt:

- average score: `64.4`
- pass rate: `42.1%`
- tool discipline: `2.47 / 5`
- correction tag average: `37.8`

`v5` prompt:

- average score: `74.1`
- pass rate: `63.9%`
- tool discipline: `3.37 / 5`
- correction tag average: `64.6`

`v6` prompt:

- average score: `73.0`
- pass rate: `62.4%`
- tool discipline: `3.27 / 5`
- correction tag average: `50.8`

`v7` prompt:

- average score: `76.8`
- pass rate: `67.8%`
- tool discipline: `3.57 / 5`
- correction tag average: `62.0`

**Decision**

Adopt `v7` as the default system prompt.

Why `v7` won:

- reduced `shell_first_when_structured_tools_fit` from `133` to `70`
- reduced `forbidden_first_tool:exec_command` from `82` to `42`
- reduced deterministic penalty events from `138` to `76`
- raised `named_artifact` from `61.4` to `70.6`
- raised `source_of_truth` from `62.4` to `76.7`
- raised overall pass rate from `42.1%` to `67.8%`

Why `v5` still mattered:

- it delivered the first large step-change by tightening first-response budgets and structured-tool defaults
- it lifted correction handling and cut obvious shell-first behavior sharply

Why `v6` lost:

- the extra continuation/scope language made the prompt longer but did not reduce shell-first behavior further
- it slightly regressed the high-priority `correction` slice and the overall pass rate

Why `v7` is still far from `90%`

The residual failures are no longer mostly about high-level intent. They are about state continuity and runtime affordances.

- remaining failed cases: `65`
- remaining `shell_first_when_structured_tools_fit`: `70`
- remaining `forbidden_first_tool:exec_command`: `42`
- most remaining failures are continuation/follow-up turns on a named artifact where the model should resume from the active working set

Why prompt-only improvements are hitting a ceiling:

- the model still has a strong prior to use shell for file discovery, grep, and git context even when the prompt says not to
- the runtime does not expose a clean structured way to ask “what files did I just touch in this task?”
- for many follow-up turns, the correct next move is to reopen the exact file changed in the previous turn; the transcript often does not surface that file name directly enough for the model to reliably remember it
- some score loss is from API timeouts (`run_error`), which are not prompt failures

System-level changes likely needed to push toward `90%`:

- add a structured `recent_files` or `working_set` tool that returns the files read/edited earlier in the current task
- persist and expose the agent's active working set between turns instead of relying on the model to infer it from long history
- tighten the `exec_command` tool description further or route shell search patterns through a guard that rejects grep/find/cat/ls usage when structured tools fit
- optionally provide a lightweight `search_symbols` or `find_component` tool so the model has a higher-signal alternative to shell grep on UI tasks

**Prompt Changes In V5/V7**

The winning prompt family adds:

- explicit first-response budgets
- stronger correction-turn reset behavior
- a structured-tools-first rule that sharply narrows when `exec_command` is acceptable
- stricter `update_plan` usage rules
- named-artifact and source-of-truth priority as hard defaults instead of soft guidance
- a general working-set model so follow-up turns continue from the active files/components instead of restarting from repo discovery
- answer-first behavior for explanation and `why` turns
