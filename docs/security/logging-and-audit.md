# Logging, Redaction, and Security Audit Trail

Phases 19 and 20 of the R1 campaign. Two mechanisms: a **redacting logger** that makes it
structurally hard for a secret to reach a log line, and a **security audit trail** that stays
useful after redaction.

## 1. Redaction at the boundary (`packages/secrets`)

### Text redaction — `redactSecrets(text)`
Pattern-based masking used on tool output, diffs, error strings, journal entries, and every log
message. Shapes covered (`packages/secrets/src/redaction.ts`):

| Shape | Examples (fake) |
| --- | --- |
| Provider keys | `sk-…`, `sk-proj-…`, `sk-or-v1-…`, `sk-ant-…`, `gsk_…`, `AIza…` (word-boundary anchored so identifiers like `task-header` are untouched) |
| Source-control tokens | `ghp_/gho_/ghu_/ghs_/ghr_…`, `github_pat_…`, `glpat-…` |
| CodeForge credentials | `cfr_…` refresh tokens, `cfa_…` desktop codes, JWTs (`eyJ….…`), `codeforge-session=` cookies, `x-codeforge-control-token:` headers |
| Payment | `sk_test_/sk_live_/rk_/pk_…`, `whsec_…` |
| Cloud/infra | `AKIA…`, `aws_secret_access_key=`, `postgres://…`, `mongodb://…`, `xox…` Slack tokens, `-----BEGIN … PRIVATE KEY-----` |
| Generic | `Authorization: Bearer …`, `Cookie:`/`Set-Cookie:` lines, `api_key=`, `access_token=`, `refresh_token=`, `client_secret=`, `password=`, `private key=` |

### Structural redaction — `redactValue(value)`
Walks any object/array/Error/Map/Set/URL: blanks values whose **field name** is sensitive
(`authorization`, `cookie`, `set-cookie`, `x-codeforge-control-token`, `apiKey`, `access_token`,
`refresh_token`, `client_secret`, `password`, `token`, `private_key`, `encryption_key`,
`session_token`, `stripe-signature`, `webhook_secret`, `code_verifier`, `database_url`,
`connection_string`, `jwt_secret`, …), pattern-redacts every string leaf, strips URL userinfo,
flattens errors to `{name, message, code, cause}` (no stack at info+), and bounds depth (6),
arrays (100), and strings (4 KiB).

### The logger — `createRedactingLogger()`
JSON lines (`ts, level, logger, msg, …fields`) written to stdout/stderr; every message and field
passes through the redactors before serialization; child loggers inherit redacted bindings;
levels `debug|info|warn|error|silent` from `CODEFORGE_LOG_LEVEL`. The Cloud API uses it for
unhandled-error logging (with a correlation id that is also returned to the client) and for the
audit stdout sink.

### Where redaction is applied today

| Surface | Mechanism |
| --- | --- |
| Agent tool results, command output, edit errors, journal messages, run titles | `redactSecrets` in `packages/server/src/agent-runtime.ts`, `edit-service.ts`, `filesystem-service.ts`, `autonomous-orchestrator.ts` |
| Provider error bodies | `packages/providers/src/redact.ts` (exact key + patterns); `GitHubAppClient` collapses bodies to codes |
| Cloud API unhandled errors | `logger.error(…, { error })` → redacted; client sees `INTERNAL_ERROR` + id |
| Cloud client-facing messages | `redactClientMessage` (redactor + 512-char bound) |
| Audit events | `sanitizeSecurityAuditEvent` (field bounds + redactor) |
| Startup config summary | `describeConfig` prints names/flags only |
| Desktop IPC errors | Truncated; no credential values are in scope |
| Packaged smoke output | Records PASS/FAIL markers, never the fixture secret |

Regression tests with fake secrets: `packages/secrets/test/redaction.test.ts`,
`packages/secrets/test/security-primitives.test.ts`, and ATTACK-006.

### Known limits
Pattern redaction cannot recognise an unprefixed high-entropy string as a secret. Field-name
redaction covers structured logs only. Third-party log platforms (Render) store whatever the
process prints — the process prints only redacted lines. There is no crash reporter or
telemetry SDK to protect (verified: none is installed).

## 2. Security audit trail

### Events (`packages/secrets/src/security-audit.ts`)

| Event | Outcome | Emitted by |
| --- | --- | --- |
| `auth.login.succeeded` / `auth.login.failed` | success / failure | `AuthService` (desktop and browser legs) |
| `auth.logout` | success | logout (desktop refresh token, browser cookie) |
| `auth.session.refreshed` | success | refresh rotation |
| `auth.session.replay_detected` | denied | reuse of a rotated refresh token (family revoked) |
| `auth.session.rejected` | denied | bearer with revoked/expired/unknown session; any 401 in the API |
| `auth.oauth.state_invalid` | failure | unknown, expired, replayed, or unsealed-verifier transaction |
| `auth.oauth.denied` | denied | user declined at GitHub |
| `account.settings.changed` | success | field names only |
| `account.deleted` | success | counts only |
| `github.app.authorized` / `github.app.authorization_failed` | success / failure | installation id, repo count, error code |
| `billing.checkout.started` / `billing.portal.opened` | success | plan id |
| `billing.webhook.signature_invalid` | denied | — |
| `billing.webhook.duplicate` / `.processed` / `.rejected` | info / denied | action + event type |
| `ratelimit.exceeded` | denied | path |
| `request.rejected` | denied | reason code (e.g. `billing_return_url_not_allowed`) |
| `crypto.decrypt.failed` | failure | purpose + leg |
| `crypto.key.rotation` | info | reserved for the re-wrap job |
| `tenant.access.denied` | denied | reserved; cross-tenant reads are indistinguishable 404s today and are not separately recorded |

Each event carries: type, outcome, opaque `userId` (never email/login), client IP, ≤16 small
redacted `details`, timestamp. Sinks: the `security_audit_events` table (append-only; user link
severed on account deletion — SECURITY_AUDIT retention class) and a redacted JSON line on
stdout (`[security-audit] {…}`) for platform log retention. Sink failures never fail the
audited request.

### Querying
`ICloudDatabase.listSecurityAuditEvents({ userId?, eventType?, limit })` (≤1000 rows, newest
first). No HTTP route exposes the trail (there is no admin API); operators query the database.

### Metrics (Phase 59)
`SecurityAuditLog.snapshot()` returns per-`type:outcome` counters for the process — failed
decrypts, invalid OAuth states, webhook signature failures, session rejections, rate-limit hits.
They are not exposed on an unauthenticated endpoint by design (they would reveal attack activity
to the attacker); surfacing them to an operator dashboard is a deployment task.

### What is deliberately not logged
Tokens, codes, verifiers, keys, cookie values, prompt text, repository content, GitHub emails
or logins, Stripe customer emails. Sessions store IP and user-agent for abuse investigation;
those appear in audit events as IP only.
