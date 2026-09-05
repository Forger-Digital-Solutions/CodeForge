# Execution modes

CodeForge has two execution modes for `POST /api/send`:

- `agent` starts the complete autonomous workflow, including its existing approval, workspace, verification, and completion gates.
- `chat` starts the existing conversational `AgentRuntime` turn. Selecting Chat does not change that runtime's existing tool or permission policy.

Production clients send `executionMode` explicitly. Message contents never select or change the mode. The mode is snapshotted when a request is created, so changing the composer control affects only later submissions. Model selection is independent.

The Desktop and Web composer default to Agent and remember the last valid selection in local browser storage. Corrupt stored values restore to Agent.

For compatibility with older API clients, a missing `executionMode` on `/api/send` deterministically uses Chat. Invalid values fail with HTTP 400 and `INVALID_EXECUTION_MODE`; they never default or invoke a runtime. The fixed `/api/workflow/run`, mission, and parallel endpoints retain their explicit endpoint semantics.

If the selected runtime cannot start, the server returns a structured, sanitized failure and records `execution.start_failed`. It never starts the other mode as a fallback.
