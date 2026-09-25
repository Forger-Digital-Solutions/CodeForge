# R35 — security sweep, secret scrubbing, lifecycle/leak audit

## Secret scrubbing (Mission AK)

`@codeforge/secrets` `redactSecrets` is applied at every trust boundary —
163 call sites audited. Enforcement invariants proven by tests:

- **Persistence boundary**: journal transcript conversion redacts message
  content, tool names, and tool arguments before write
  (`agent-runtime.ts:235-243`); persistence re-redacts on write.
- **Event boundary**: emitted tool results carry the post-redaction result only
  — the raw never leaves the process (`FG-1B` comment, `agent-runtime.ts:5174`).
- **Cache boundary**: only successful, redacted, *secret-free* results enter the
  ForgeGreen cache — a result whose redaction changed it is not cached
  (`agent-runtime.ts:4941-4943`).
- **Hash boundary**: ForgeVerify redacts output before hashing so a secret in
  the raw output cannot leak through the evidence record
  (`r21-forgeverify-integrity.test.ts` row 6).
- **Error paths**: spawn errors, edit failures, command stderr, recovery
  detail — all redacted before record/event/model.
- **Display boundary**: `errorMessage`/`details` fields surfaced to UI go
  through redaction.

Credential material (OpenRouter OAuth, GitHub App tokens, cloud tokens) lives in
`secure-credential-codec` + OS keychain paths; tokens are never written to
turn/event/work-item records.

## Security sweep (Mission AJ)

- Control plane: loopback default, origin allowlist, Host-header/DNS-rebinding
  rejection (421), timing-safe bearer compare, bearer never accepted from URL,
  per-process high-entropy token, `Origin: null` refused without bearer.
- Routable bind (`CODEFORGE_BIND_HOST=0.0.0.0`) without a token → `start()`
  throws — proven by `network-exposure.test.ts` + `release-status.test.ts`.
- Tool broker: `TOOL_WORKSPACE_ESCAPE`, `TOOL_PATH_ESCAPE`,
  `TOOL_SENSITIVE_PATH_DENIED`, `TOOL_PERMISSION_DENIED` — enforced at dispatch
  independent of schema filtering (`registry-authority.test.ts`,
  `role-boundary.test.ts`).
- Approval spoofing: unknown/cross-session approval IDs → error, durable write
  completes before HTTP 200 (`session-isolation.test.ts`).
- GitHub auth: single-use codes, token rotation, replay rejection, repo-scoped
  ephemeral tokens (`github-app-authorization.ts`).
- Workspace: worktree escapes, sensitive paths, and shell-injection vectors all
  tested; `git-exec-allowlist` constrains desktop git invocations.

## Leak audit (Mission AB)

- `capacityWaitTimer`: `unref`'d (never holds the process), cleared on capacity
  arrival and shutdown.
- `workflowTimer`: cleared via `clearWorkflowTimeout` on terminal phase.
- `server.stop()`: `closeAllConnections()` drains keep-alive/SSE sockets,
  `clients.clear()` drops SSE subscribers, runtime + workflow shutdown awaited,
  repository index aborted, cache store and persistence closed.
- 50-turn endurance soak (`r35-endurance.test.ts`): monotone event sequence,
  coherent persisted records, no per-turn residue growth.

## Retention (Mission AE — honest scope note)

Session-scoped deletion exists (`deleteSession` removes turns, work items,
events, capacity waits for that session — proven by session-isolation tests).
There is **no global retention/TTL policy** for events or work items across
sessions: the event table grows per-session and is bounded by session lifetime,
not by a rolling window. This is documented as a known limitation, not a defect:
records are needed for durable recovery and audit, and local SQLite growth is
linear and bounded by user activity. A retention policy is future work and is
not required for fail-closed correctness.

## Latency budgets (Mission AC)

Model calls carry per-request deadlines; commands default to bounded execution
(60 s tool timeout, tree-kill, exit 124); approval waits default 5 min;
workflow working budget re-arms per phase; capacity waits poll at
`capacityWaitPollMs` and remain cancellable. No unbounded `await` exists in the
turn loop — every blocking point has a timeout, abort signal, or durable wait
record behind it.
