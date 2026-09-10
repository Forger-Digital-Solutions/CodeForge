# CodeForge R5 — Real End-to-End Agent Loop Certification

- Verdict: **CODEFORGE_R5_REAL_AGENT_LOOP_CERTIFIED**
- Started: 2026-09-09T13:42:55.669Z
- Completed: 2026-09-09T13:43:14.746Z
- Provider: openrouter::cohere/north-mini-code:free

## Evidence

- PASS — live-free-provider-discovery: 21 verified-free models discovered from the live provider catalog
- PASS — free-route-selected: selected route is ForgeZero verified-free and $0
- PASS — model-selection-persisted: HTTP model selection round-tripped from durable runtime state
- PASS — real-workflow-terminal: durable workflow turn status=completed
- PASS — real-tool-loop: 21 durable tool events observed
- PASS — real-file-change: the disposable repository was changed by the agent
- PASS — real-verification: ForgeVerify/run inspection evidence persisted
- PASS — completion-event: task.completed was emitted after the workflow completion gate
- PASS — durable-final-response: final response is reconstructable from a persisted work item
- PASS — sse-reconnect: reconnect replay contained ordered, non-duplicate durable events
- PASS — event-sequence: durable events have strictly increasing unique sequence numbers
- PASS — steering-boundary: steering endpoint accepted=true
- PASS — approval-boundary: 2 real approval request(s) resolved through HTTP
- PASS — adversarial-verification-rejection: a failing verifier cannot pass the completion gate

## Durable trace

- Provider discovery: 431 live models, 21 verified-free models.
- Selected route: openrouter::cohere/north-mini-code:free.
- Durable event count: 147.
- Tool event types: tool.call_started, tool.execution_started, tool.execution_completed.
- Verification records: run_inspection, evidence.
- Persisted final response source: workflow.

## Negative control

- Failing verification gate outcome: failed.
- Blockers: verification_failed.
