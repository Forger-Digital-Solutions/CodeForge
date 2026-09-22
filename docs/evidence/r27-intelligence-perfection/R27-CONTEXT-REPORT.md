# R27 Context Freshness Report

Status: `R27_CONTEXT_STALENESS_INVALIDATION_DETERMINISTICALLY_PROVEN`

## Finding

AgentRuntime refreshed repository intelligence before a run but retained its initial context prompt
after successful edits. That allowed later model turns to see an old source excerpt or prior
`read_file` result as though it were current.

## R27 correction

After a successful `write_file`, `edit_file`, or potentially mutating command, the runtime refreshes
the repository index. It then removes the bootstrap repository excerpts and the associated exported
evidence. Reads of an edited file are replaced with a runtime invalidation marker. The next model
turn must obtain a current observation before relying on file content.

If index refresh fails, the behavior is still fail-closed: stale excerpts and observations remain
removed and the model receives a clear invalidation notice. The runtime deliberately does not
rebuild and retransmit a complete context pack after every edit; that would turn normal multi-file
work into repeated context overhead. The model can instead request the smallest fresh read it
needs. `contextRefreshes` and `staleContextInvalidations` make this behavior observable.

## Deterministic validation

The new production runtime test performs a read, edits that same file, and confirms the next
provider request contains neither the original bootstrap excerpt nor the stale read observation.
Focused context/runtime coverage passed 27/27, the full context package passed 55/55, and the
parallel worktree orchestration suite passed 4/4 under its unchanged timeout. Context and Server
typechecking passed. The broader five-suite orchestration regression also passed 39/39 in about
151 seconds. All providers were scripted; no live or paid inference was used.

## Boundary

This establishes deterministic stale-context invalidation, not live-model quality or token savings.
Live proof requires paired free-route runs with identical repository state, budgets, verifiers, and
completion criteria, with any route or quota failure recorded as a blocker.
