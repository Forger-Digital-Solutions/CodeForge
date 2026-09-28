# R53 no-progress and role failover assessment

The runtime already blocks several deterministic loops before a role budget is exhausted:

| Pattern | Current threshold | Boundary |
|---|---:|---|
| Same tool name and arguments | 3 consecutive calls | `AGENT_TOOL_LOOP_DETECTED` |
| Alternating same two calls | 6 calls | `AGENT_TOOL_LOOP_DETECTED` |
| Same successful read against proven unchanged state | Execute once, suppress once, then escalate | `AGENT_NO_PROGRESS_DETECTED` |
| Distinct empty/malformed/repeated read observations | 8 at one workspace state | `AGENT_NO_PROGRESS_DETECTED` |
| Consecutive writes with no effect | 4 | `AGENT_NO_PROGRESS_DETECTED` |

The duplicate supervisor binds reads to state evidence and invalidates a replay after an edit, a steer, or external workspace change. These rules tolerate rerunning tests after edits. They do not treat *distinct useful reads* as a loop.

The R52 healthy Reviewer made 10 tool calls but the receipt did not retain their identities or results. No deterministic loop signal fired. Applying a new generic turn-count penalty or forced early failover to that receipt would infer no progress without evidence. The only alternative role-qualified Reviewer at preflight was Groq Qwen, whose capacity was unmeasured; Mistral required data-policy consent and OpenRouter Lightning was role-ineligible. Early replacement was therefore not proven possible at that time.

R53 changed the Reviewer instruction to start with the supplied diff and return a structured verdict once evidence is sufficient. A fresh healthy mission then returned a valid verdict in 8 requests and passed ForgeVerify. This is a bounded convergence improvement, not early failover proof. Repeated *independent* current role failures now enter urgent requalification; one failure, provider 429, and recovered role quality do not.

Remaining telemetry gap: persist reviewer tool identity hashes and per-turn new-evidence counts in the mission receipt before asserting that a non-identical, ten-turn review made no progress. A future early rotation should require that evidence plus an admitted alternative route and a held-capacity transfer, then preserve the same review state. No such unproven switching path was added in R53.

The R53 refactor mission produced a second diagnostic case: its Coder used 26 model requests and 29 tool calls after one 429 failover, then hit `AGENT_MODEL_TURN_LIMIT` before verification. The recovery replayed that one witnessed `NON_CONVERGENCE` role observation and selected Nemotron Lightning under new capacity conditions; it too reached `AGENT_MODEL_TURN_LIMIT` after 25 requests and 31 tools. Neither reached ForgeVerify, and both independent post-run probes still failed on missing exports. The first two receipts do not retain tool names, arguments, interim file hashes, or edit outcomes, so counts alone cannot establish a duplicate loop. The preceding Groq 429 is capacity-only. R53's replay harness can seed either witnessed workspace escape or model-turn exhaustion into a fresh role decision without fabricating repeated failures.

A third live diagnostic of the same fixture now retains hashed tool arguments and outcomes. Groq GPT-OSS 120B made 19 requests and 18 tool calls during a 600-second bounded run. All 18 arguments were distinct. Two of three edit calls completed, and the worktree contained edits to `src/stats.mjs` and `src/report.mjs` before the harness cancelled; two command calls and the final edit failed. The run did not reach verification and its post-run probe failed. This evidence rules out a simple exact-argument duplicate loop in that diagnostic. It does not reveal the earlier two Coders' call sequences or justify a generic no-edit timeout: this Coder made real edits late in its budget. We therefore did not add a speculative early role switch or penalize distinct reads as no progress.
