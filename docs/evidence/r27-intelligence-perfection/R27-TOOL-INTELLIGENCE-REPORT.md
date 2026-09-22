# R27 Tool Intelligence Report

Status: `R27_TOOL_COMMAND_TRUTHFULNESS_AND_LOOP_RECEIPTS_DETERMINISTICALLY_PROVEN`

## Finding

The terminal executor already returned process exit status, but `ToolBroker` converted every
non-timeout, non-spawn-error result into a successful tool call. A failing command could therefore
look like successful evidence. Separately, `run_command` was categorically mutation-shaped for
duplicate suppression, even when the existing command classifier had conservatively established
that an inspection command was read-only. The generic loop breaker also blocked without emitting
the standard no-progress receipt.

## R27 correction

`run_command` now returns `TOOL_EXECUTION_FAILED` for any nonzero exit, with its redacted exit
code and diagnostic output available to the runtime. Only an already-parsed command classified as
`read-only` becomes eligible for duplicate replay; the model does not self-classify. Mutating,
network-sensitive, unknown, and other command forms remain non-suppressible.

Both generic consecutive-loop and oscillation exits now persist a no-progress ledger interruption
and attach the ForgeGreen efficiency receipt before returning a blocked run. A deterministic
failed inspection repeats twice at most and then blocks; a successful repeat executes once and
replays the authoritative result once.

## Deterministic validation

Tool-package tests passed 15/15, focused runtime and command-gate coverage passed 36/36, and an
adjacent agent-runtime/orchestrator regression passed 32/32. Tools and Server typechecking passed.
All providers were scripted; no live or paid inference was used.

## Boundary

This proves command-result truthfulness, bounded duplicate behavior, and receipt production in the
deterministic runtime. It does not establish that live models select tools better, use fewer tokens,
or finish more engineering work. Those claims need paired live free-route runs with identical
repository state, budgets, verifiers, and completion criteria.
