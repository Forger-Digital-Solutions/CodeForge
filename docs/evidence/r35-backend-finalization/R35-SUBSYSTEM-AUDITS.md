# R35 — subsystem audits (browser, terminal, GitHub, events, isolation, endurance)

Audit result: these areas were already hard. R35 added missing invariants and
one genuine security fix rather than rewrites.

## Browser backend (Mission L)

`packages/browser` — policy-driven navigation gate, SSRF denial matrix, session
isolation, crash/denial behavior all tested:

- `policy.test.ts` — https public + loopback http allowed; dangerous schemes,
  credential-bearing URLs, off-loopback plaintext, cloud metadata/link-local,
  RFC-1918 (unless opted in), unspecified/multicast, IPv4-mapped-IPv6, DNS
  rebind on resolve, fail-closed DNS all denied.
- `runtime.test.ts` — redirect-hop re-gating (the *request-level* gate, not just
  nav), implicit-failed-tab release, download quarantine with sha256 (never
  executed), console/failed-request capture without cookie/header leakage,
  prompt-injection treated as inert data, session limit, crashed-session refusal.
- `tools.test.ts` — all browser tools carry `network` permission + `network`
  executionClass; `BROWSER_NAVIGATION_DENIED` on policy refusal; untrusted
  wrapping on content.

## Terminal backend (Mission M)

`packages/terminal` — ANSI/ConPTY sequence handling, shell detection
(Windows/POSIX/WSL), prepared-spec mapping, exit codes (124 timeout, 130 abort,
spawn errors surfaced), tree-kill on timeout, 10× consecutive timeouts with 0
EPERM / 0 leaked children / 0 double-settlements, abort↔timeout race safety,
pre-aborted signals never spawn. `console-host.test.ts` covers PE subsystem
detection and CommandLineToArgvW-correct quoting (cmd metacharacter
neutralisation, delayed-expansion escaping).

Server-side command gating proven separately in `r21-autonomous-command-gate`
(denied command → no durable record, no side effect; `network:false` still runs
ordinary project commands).

## GitHub / auth (Missions N, P)

`packages/cloud-auth/test/auth.test.ts` — 30+ adversarial tests: fixed public
OAuth callback (never ephemeral loopback), server-held PKCE verifier,
canonical-redirect allowlist, CRLF rejection, replay/tampered state rejection,
single-use desktop codes, exact-one-of-N concurrent exchange, refresh-token
rotation with reuse detection, JWT verify, repeat-login stability,
denial-consumes-transaction. `github-app.test.ts` — repository-restricted
ephemeral tokens. `workspace-binding-guard.test.ts` — a conversation bound to
repo A refuses to continue on repo B (identity, not spelling).

`path-security.test.ts` — traversal/junction/prefix-sibling denial;
`persistence-secret-boundary.test.ts` — known secrets redacted across sessions,
turns, work items, events at the storage boundary.

## Events / activity (Missions S–U)

`event-store.ts` — global monotonic `seq` assigned in `append`; hydrate
re-sequences deterministically on collision (timestamp, then seq, then
persisted order) and never drops events. `/api/events` SSE: `lastSeq` cursor
replays missed events, optional `sessionId` filter confines the stream to one
session (no cross-session bleed). `session-isolation.test.ts` (new) proves
session B cannot observe session A's turns, work items, or events.

`run.outcome` is the single awaited terminal record; per-phase events precede
it; `status.changed`/`task.state_changed` now carry schema-correct vocabularies
on both sides (see R35-TASK-STATE-MACHINE.md).

## Security fix landed this mission

`start()` now refuses a non-loopback bind without `controlPlaneToken`. Before
R35, `CODEFORGE_BIND_HOST=0.0.0.0` silently exposed the whole unauthenticated
control plane — including approval resolution — to the LAN. The comment
documented the danger; nothing enforced it. Now it throws at bind time
(release-status.test.ts).

## Persistence (Mission AD)

Indexes: sessionId on turns/work_items/events; `kind` index added to SQLite
`work_items` (Postgres already had it — `getWorkItemsByKind` in recovery and
continuation stores no longer full-scans). ForgeVerify append-only trigger at
the storage layer. `sanitizeForPersistence` redacts every write.

## Endurance (Mission AA)

`r35-endurance.test.ts` — 50 sequential scripted agent turns through the real
runtime+persistence+EventStore: strictly monotone seqs, linear event growth,
zero non-terminal residue in live maps, bounded heap. Combined with R20 scale
emulation and the R33 1M-user reservation proof, this covers both the
per-session and fleet-scale growth stories.
