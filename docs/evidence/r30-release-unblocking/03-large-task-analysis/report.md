# R30 large-task failure analysis

## Inherited R29 evidence

R29 attempted the locked `ts-large-context-rename-config-key` task twice on OpenRouter Nemotron 3 Super. The first run changed seven source files, used the 30-request ceiling, passed only its syntax verifier, and ended with four plan steps unfinished. Its hidden verifier failed, but the retained receipt has no exact diff or hidden failure text, so the defective edit cannot be identified from that run. The second attempt made no edits after three provider-network failures. These are separate failure modes. R29's completion gate correctly blocked both runs.

## R30 executable attempts

The [attempt summary](../04-large-task-benchmarks/summary.json) includes every R30 run and links each raw receipt. All tasks used locked R23/R27 fixtures copied to disposable workspaces, real verified-free OpenRouter routes, request and wall-clock ceilings, the production WorkflowService → AgentRuntime path, and an independent hidden verifier run only after the workflow stopped. No task-level human intervention occurred. The first two R30 runs revealed that this restricted command environment denied the default repository-index cache under the user profile. The R30 harness now confines that cache to each disposable run directory; those failures remain counted.

| Task and route | Workflow / independent check | Isolated cause |
| --- | --- | --- |
| Feature, Cohere North Mini Code, first run | blocked / fail | Eight provider calls succeeded, followed by three HTTP 400 responses after a failed tool execution. The first receipt lacks the tool error detail; exact provider rejection body is unavailable. |
| Bug repair, Cohere, first run | blocked / fail | `repo_symbol` could not create its cache under the user profile (`EPERM`); subsequent repeated actions ended in no-progress blocking. Harness environment boundary, not a proven product defect. |
| Bug repair, Cohere, confined cache | blocked / pass (4/4) | The correct queue edit was made, but repeated post-edit actions prevented the implementation turn from finishing its plan. This is an agent handoff/loop reliability failure; the completion gate correctly refused success. |
| Feature, Cohere, confined cache | completed / fail (8/9) | The new stats command failed the `lines` semantic case. The configured visible check only parsed `src/cli.ts`, so product completion did not imply task correctness. |
| Refactor, Cohere, confined cache | completed / fail (10/12) | Three handlers were edited, but the independent `validator-shape-ok` and `validator-shape-bad` checks failed. Visible checks were syntax-only. |
| Large rename, Nemotron 3 Super, before safeguard | completed / fail (8/9) | The model correctly renamed the internal property in seven files but also changed the public `--max-retries` flag to `--retry-limit`. That violated the task's preserve-behavior requirement. The exact after-content is frozen in the receipt. |
| Large rename, Nemotron 3 Super, after general rename safeguard | completed / pass (9/9) | The model kept the CLI flag, mapped it to the renamed property, changed seven source files, and passed the independent check in 405,402 ms with 28 model requests and 23 tool calls. |
| Bug repair, Nemotron 3 Super, controlled first-call 429 | blocked / fail | One injected 429 was followed by successful real upstream responses, then the pinned route ended at CodeForge capacity with no edits. This does not establish end-to-end recovery. |

The successful large rename is evidence of one autonomous substantial task, not a defensible reliability rate. Across all eight attempts, only one satisfied both workflow completion and independent correctness. R30 has not demonstrated consistent feature/refactor completion, successful provider-failure recovery, or comparative subagent advantage. The locked tasks' syntax-only visible verifiers are a concrete acceptance gap; they were not changed to reveal hidden answers or make the benchmark easier.

## Reproduction boundary

Run `node benchmarks/r30/live-workflow-completion.mjs` from the repository root with `R30_LIVE_ENABLE=true`, `R30_LIVE_EVIDENCE_DIR=docs/evidence/r30-release-unblocking/04-large-task-benchmarks`, a locked `R30_LIVE_TASK_ID`, and explicit `R30_LIVE_PROVIDER` and `R30_LIVE_MODEL` for a currently verified-free route. The environment credential store needs the route's existing authorized credential. Set `R30_LIVE_MAX_REQUESTS` and `R30_LIVE_TIMEOUT_MS` within the script's hard ceilings; `R30_LIVE_INJECT_429_ONCE=true` reproduces the controlled failure case. Each run uses a disposable task copy and emits a complete receipt; `node benchmarks/r30/summarize-live.mjs` rebuilds the all-attempt summary. Do not count a run as successful unless both the workflow completion gate and independent hidden verifier pass.

## Remaining diagnostic limits

- R29's first run omitted exact edits and hidden failure output. R30 receipts now capture full fixture changes, including added files, after-content up to 12 KiB, tool names, block reasons, redacted failure events, model request outcomes, and available token usage.
- Provider records with outcome `started` and zero elapsed time contain no trustworthy token usage. They remain counted as dispatched attempts; telemetry is marked unavailable.
- The R30 harness uses one workflow implementation topology. It does not prove subagent explorer/planner/coder/reviewer efficiency, worktree isolation, or hosted admission behavior.
- Real provider request bodies and rejection bodies are deliberately absent from the receipts. The first feature run's HTTP 400 cause remains at the provider adapter boundary until a safe, redacted response-class diagnostic is added.
