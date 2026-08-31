# CodeForge Cloud — Global Staging Certification

> **Verdict:** `CODEFORGE_CLOUD_GLOBAL_STAGING_CERTIFIED` — **YES — CERTIFIED**

| Field | Value |
| --- | --- |
| Certification timestamp | `2026-08-31T12:22:47Z` (UTC) |
| Repository SHA | `85bb4efe06b33dc49804c9107d4c5e875c09f6d2` |
| Runtime serving SHA | `85bb4efe06b33dc49804c9107d4c5e875c09f6d2` |
| Branch | `feat/codeforge-cloud` |
| Render deployment | `dep-daalod8n74is73bbt54g` |
| Public endpoint | `https://codeforge-cloud-staging.onrender.com` |
| Repository blockers | **0** |
| External blockers | **0** |
| Known active leaked credentials | **0** |
| Owner cash spent | **$0.00** |

## Executive certification statement

CodeForge Cloud staging is certified as a working, publicly reachable, zero-cost deployment
serving the exact commit recorded in this document. Every capability listed below was exercised
against the live remote deployment — not mocked, stubbed, or simulated — and the supporting
receipts were verified numerically before this record was published.

The certification covers a full credential-rotation closure. Two staging credentials had been
exposed and were confirmed still active at the start of the closure. Both were rotated, both old
credentials were then proven dead by direct authentication attempts, replacement credentials were
verified, and staging was redeployed and re-validated on the new database credential with all
durable account state intact.

This document and its machine-readable companion are sanitized by construction: they contain no
API keys, connection strings, passwords, client secrets, tokens, or authorization codes, and no
sensitive account identifiers.

## Evidence classification

Every claim carries one of the following classes:

| Class | Meaning |
| --- | --- |
| `REAL REMOTE` | Executed against the live public staging deployment over the network. |
| `PACKAGED REAL LOCAL` | Executed against a real packaged desktop build on a local machine. |
| `CI` | Executed by GitHub Actions on hosted runners. |
| `CARRIED FORWARD` | Certified in an earlier session at a prior SHA; re-verified as still applicable. |

## Public staging architecture

```
GitHub OAuth (server-brokered PKCE)
        │
        ▼
Render Free web service ──────────► Supabase Free PostgreSQL 17.6
codeforge-cloud-staging             us-east-1 · Session pooler · TCP 5432
srv-daa481tg1s2s73c3htsg            TLS with certificate verification enforced
        │
        ├── /health/live · /health/ready · /v1/meta · /v1/hosted/models
        ├── /v1/auth/{start,github,exchange,refresh,logout}
        └── /v1/hosted/inference  (progressive SSE)
                │
                ▼
        Hosted provider capacity
        openrouter · groq        (GEMS present but fail-closed / offline)
```

Container entrypoint is `apps/cloud-api/dist/index.js`, built from `Dockerfile.cloud`.

### Runtime SHA advance — verified equivalence

Render auto-deploy is disabled, so staging had been serving an earlier commit (`d925819`) while
the repository head had advanced. The post-rotation deploy built branch tip `85bb4ef`, aligning
runtime with the certified repository SHA. That advance was proven non-impacting rather than
assumed, by three independent checks:

1. `apps/cloud-api` resolves to the **identical git tree object** `4d5710585e2ad1ed07f217822a3d89cac696b085` at both SHAs.
2. `Dockerfile.cloud` and `render.yaml` are unchanged across the range.
3. The packages changed in the range (`server`, `ui`, `workflow`) have **zero intersection** with
   the 16-package transitive workspace closure of `apps/cloud-api`.

Cloud runtime behaviour is therefore unchanged, and all carried-forward cloud evidence remains valid.

## Deployment status — `REAL REMOTE`

| Item | Result |
| --- | --- |
| Render service | `codeforge-cloud-staging` (`srv-daa481tg1s2s73c3htsg`) |
| Plan | **Free**, `not_suspended` |
| Deploy ID | `dep-daalod8n74is73bbt54g` |
| Deploy status | `live` — finished `2026-08-31T10:50:57Z` |
| Deploy trigger | Explicit; polled by exact deploy ID, not "latest" |
| `GET /health/live` | `200` |
| `GET /health/ready` | `200` — `database: connected` |
| `GET /v1/meta` | `200` |
| `GET /v1/hosted/models` | `200` — 34 models, 30 verified-free |

Startup configuration observed in deploy logs:

```
env=staging  db=postgres  dbTls=true  host=0.0.0.0:10000
publicUrl=https://codeforge-cloud-staging.onrender.com
github=configured  stripe=disabled  providers=[openrouter,groq]
```

Log audit: 5/5 required positive markers present; **0/9** forbidden patterns present
(no authentication failures, no TLS chain warnings, no credential-shaped strings).

## Database — `REAL REMOTE`

| Item | Result |
| --- | --- |
| Engine | PostgreSQL **17.6** |
| Provider plan | Supabase **Free** |
| Region | `us-east-1` |
| Connection type | **Session pooler**, TCP **5432** |
| TLS | Certificate verification **enforced** — CA-pinned, `rejectUnauthorized=true`, SNI set |
| Prohibited TLS relaxations | none present (`sslmode=no-verify`, `rejectUnauthorized=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` all absent) |

### Migration integrity — 3/3 present, 3/3 checksums validated

| Version | Name | Checksum (SHA-256) |
| --- | --- | --- |
| 001 | `001_initial_cloud_schema` | `58f208efe2a8c9740349e819d33b1afbddf5f70d42171478feaf5e4a748d8882` |
| 002 | `002_credit_ledger_monotonic_seq` | `e368259df2215c3acf930a2d055d58a37e8e4dce30daf8f1392bc05afba1bcbf` |
| 003 | `003_server_brokered_oauth` | `d84f792009518beeb1ca6b32c702816eda6096489dd84148c54e8b110a9da4f2` |

Checksums were captured before the credential rotation and re-read after it through the new
credential; all three matched byte-for-byte.

### Durable state across rotation

| Table | Before rotation | After rotation + 1 request |
| --- | --- | --- |
| `users` | 1 | 1 |
| `identities` | 1 | 1 |
| `entitlements` | 3 | 3 |
| `schema_migrations` | 3 | 3 |
| `credit_ledger` | 25 | 27 *(+2: reservation, release)* |
| `usage_events` | 12 | 13 *(+1)* |
| `hosted_requests` | 12 | 13 *(+1)* |

Anonymized user-set fingerprint `8533038eb54b9b7ff9fcc75c3809a41d` is **unchanged** across the
rotation, proving the same account identity survived. Credit-ledger sequence is strictly
increasing `1 → 27`. Growth is exactly attributable to the single post-rotation request.

### Database fail-closed behaviour — `REAL REMOTE`

With the database made unreachable, the service refuses work rather than degrading into an
unauthenticated or unmetered mode. Recorded transparently, this test required two attempts:

| Attempt | Outcome |
| --- | --- |
| First DB-outage attempt | **INVALID** — a Render environment-variable update alone does not restart the running container, so the probe observed a still-healthy process holding its original connection. The result proved nothing and was discarded. |
| Corrected DB-outage test | **PASS — `REAL REMOTE`** — each phase explicitly triggers a deploy and polls *that* deploy ID to a terminal state before probing, so the container genuinely runs against the unreachable database. |

This same lesson — that an environment-variable write must be followed by an explicit deploy and
polled by exact deploy ID — was applied to the credential rotation itself.

## Authentication — real GitHub OAuth — `REAL REMOTE`

Server-brokered GitHub OAuth with PKCE (`S256`). Authorization was completed by a human in a real
browser against real GitHub; no token was fabricated, minted, or replayed.

| Check | Result |
| --- | --- |
| Real GitHub authorization → session exchange | PASS |
| Session established post-rotation | PASS |
| Logout | PASS — `HTTP 200` — `CARRIED FORWARD` |
| Refresh after logout rejected | PASS — `HTTP 401` — `CARRIED FORWARD` |
| Desktop authorization-code replay rejected | PASS — `HTTP 401` — `CARRIED FORWARD` |

## Hosted Free zero-setup user flow

A new user signs in with GitHub and immediately gets working inference with **no API key, no
payment method, and no configuration**. Free capacity is server-verified rather than
self-declared: 30 of 34 catalogued models are verified-free at certification time.

### Post-rotation Hosted Free request — `REAL REMOTE`

The decisive proof that database-backed identity and accounting still function on the rotated
credential.

| Field | Value |
| --- | --- |
| Request ID | `df8a0b52-5848-4858-b4ce-81e26a805ddf` |
| Turn ID | `1399d8ab-82d3-418d-bad3-61f1a6ea2988` |
| Provider / model | `groq / openai/gpt-oss-20b` |
| Routing | **Exact** — provider and model pinned; no fallback path reachable |
| Verified-free | `isEligibleFree=true`, `accessClass=free` |
| Server-recorded access class | **`FREE_ALLOWANCE`** |
| `providerCostUsd` | **`0`** |
| Tokens | 78 in / 53 out / 0 cached |
| Latency | 280 ms |
| Status | `completed` |
| Completion text | exactly `ROTATION_OK` |

Requesting an exact provider and model makes paid fallback structurally impossible: no automatic
model substitution can occur, so a zero cost cannot be an accident of routing.

### Server-authoritative accounting

Credits are reserved before work and settled after it, on the server. The client cannot assert
its own balance.

| Ledger seq | Event | Amount | Balance after |
| --- | --- | --- | --- |
| 26 | `CREDIT_RESERVED` | `-5000` | `491257` |
| 27 | `CREDIT_RELEASED` | `+4816` | `496073` |

Reserved `5000` − released `4816` = **`184` settled**, matching `actual_credits=184` on the
request row and `credits_consumed=184` on the usage event. The reservation/settlement pair
balances exactly, and `providerCostUsd` is `0` because the model is genuinely free — credits meter
usage, they do not represent money spent.

### Progressive SSE completion

```
assistant.message.started   provider=groq  model=openai/gpt-oss-20b
assistant.message.delta     ×3
assistant.message.completed
usage.updated               creditsConsumed=184  balanceAfter=496073
turn.completed              ← terminal
```

Output streams progressively and reaches a terminal `turn.completed` event; accounting is
delivered in-band before termination.

## Additional certified capabilities

| Capability | Result | Evidence class |
| --- | --- | --- |
| Two-client concurrency authority | PASS — one of two simultaneous same-account requests completed; the server, not the client, arbitrates | `REAL REMOTE` · `CARRIED FORWARD` |
| Redeploy persistence | PASS — all 7 table fingerprints byte-identical before redeploy, after redeploy, and after the outage test | `REAL REMOTE` · `CARRIED FORWARD` |
| Live privacy certification | PASS — 7/7 checks (`session`, `account_readable`, `set_strict`, `strict_constrains_routing`, `set_standard`, `standard_restores_capacity`, `no_secret_shaped_leak`) | `REAL REMOTE` · `CARRIED FORWARD` |
| Remote security probe | PASS — 21/21 checks (TLS, security headers, auth enforcement, forged-token rejection, OAuth open-redirect and verifier-leak, CORS, payload limits, error normalization, SSE auth) | `REAL REMOTE` · `CARRIED FORWARD` |
| Direct / BYOK independence | PASS — 6/6; Direct and BYOK stay fully functional while CodeForge Cloud is unreachable, and a non-responding Cloud never stalls them | `REAL REMOTE` + local suite |
| GEMS fail-closed identity firewall | PASS — 9/9; GEMS is unavailable without a real GEMS backend, all 4 GEMS models report `offline`, and non-GEMS provider calls = 0 | local suite + `REAL REMOTE` catalog |
| Autonomous plan / edit / verification / evidence / checkpoint | PASS — real workflow↔agent integration, including delegation to a ForgeZero-verified free model and a repair loop re-entering the agent after verification failure | local real-execution suite |
| Packaged desktop single-instance | PASS — 21/21 packaged smoke assertions, 0 failures, covering single-instance startup, encrypted credential round-trip, plaintext-absence, corrupt-credential fail-closed, and restart with no approval replay | `PACKAGED REAL LOCAL` |
| Exact-model routing | PASS — requested model served verbatim | `REAL REMOTE` |
| Unknown-model refusal | PASS — unknown provider/model correctly refused | `REAL REMOTE` |

## Test and CI results

Full workspace suite at the certified SHA:

```
Test Files  108 passed | 1 skipped (109)
     Tests  995 passed | 21 skipped (1016)
    Failed  0
```

The 21 skips are **expected conditional PostgreSQL skips** — suites that require a live PostgreSQL
endpoint and self-skip when `CODEFORGE_TEST_POSTGRES_URL` is unset. They are not failures or
silently ignored tests.

`typecheck` PASS · `build` PASS.

### GitHub Actions — `CI`

| Run ID | Workflow | Head SHA | Conclusion |
| --- | --- | --- | --- |
| `33382159039` | `cloud-ci` | `85bb4ef…` | **success** |
| `33382159655` | `cloud-ci` | `85bb4ef…` | **success** |

Job-level results:

| Job | `33382159039` | `33382159655` |
| --- | --- | --- |
| `cloud-verify` | success | success |
| `real-staging-smoke` | success | skipped *(conditional)* |
| `docker-runtime-smoke` | success | success |

## Credential rotation closure

Two staging credentials were exposed and confirmed **still active** at the start of this closure —
verified by live authentication before any rotation was performed. Both are now dead.

| Credential | Before | After |
| --- | --- | --- |
| Render API key | authenticated — `HTTP 200` | **revoked** — `HTTP 401 unauthorized` |
| Supabase PostgreSQL password | authenticated — connection succeeded | **invalidated** — `SQLSTATE 28P01 password authentication failed` |

| Verification | Result |
| --- | --- |
| Old Render key revoked | **YES** |
| Old Render key still authenticates | **NO** |
| Replacement Render key retained | YES |
| Replacement Render key authenticates | PASS — `HTTP 200` |
| Supabase password rotated | **YES** |
| Old database credential | **authentication failure** |
| New database credential | **authentication success**, TLS verified |
| Render `DATABASE_URL` updated | YES — only this variable changed |
| Preserved unchanged | `CODEFORGE_CLOUD_DB_DRIVER=postgres`, `CODEFORGE_CLOUD_DB_SSL=true`; 13 variables before and after |

Old credentials were used **only** for read-only authentication probes to prove they were dead.
No mutation was ever attempted with a compromised credential.

## Security cleanup and final secret scan

| Surface | Result |
| --- | --- |
| Working tree | **clean** |
| Tracked repository | clean — only inert test fixtures, documentation placeholders, and ephemeral CI localhost containers |
| Build output (`dist/`) | clean; gitignored |
| Captured deployment logs | clean |
| Temporary credential files | **removed — 8 files deleted** |
| Active exposed credentials found | **0** |

Patterns scanned: Render API keys, Supabase/PostgreSQL connection strings with embedded
credentials, GitHub tokens and PATs, GitHub client secrets, JWT secrets, OpenRouter keys, Groq
keys, Stripe live keys, and OAuth access/refresh tokens.

Matches were triaged rather than merely counted, distinguishing **placeholder**, **test fixture**,
**hash**, **spent one-time OAuth code**, and **active credential**. Only the first four classes
were found.

During cleanup, an out-of-scope exposure was discovered and remediated: a temporary file held
plaintext values for four additional live secrets (GitHub client secret, Groq key, OpenRouter key,
JWT secret). Exposure was confined to a local temporary directory and was never published or
committed. The file was deleted and the final scan is clean. Rotating those four remains available
at the owner's discretion; it is not a certification gate.

## Cost posture

| Item | Cost |
| --- | --- |
| Render web service | **Free** plan |
| Render PostgreSQL instances | 0 — none provisioned |
| Render Key Value instances | 0 — none provisioned |
| Supabase | **Free** plan |
| Paid AI calls | **$0.00** — `providerCostUsd = 0`, `FREE_ALLOWANCE` |
| Live Stripe calls | **$0.00** — `stripe=disabled` at runtime |
| **Owner cash spent** | **$0.00** |

No paid upgrade, no credit card requirement, and no live payment integration is involved in
running or certifying this deployment.

## Blockers

```
Repository blockers:                 0
External blockers:                   0
Known active leaked credentials:     0
```

## Artifact integrity

The machine-readable companion to this document is:

```
docs/certification/codeforge-cloud-global-staging-certification.json
```

It records the SHA-256 digest of this Markdown file under `artifact_hashes.markdown_sha256`. The
JSON file's own digest is published in the commit message that introduces these artifacts, so the
pair can be verified without circular reference.

Verify locally with:

```bash
sha256sum docs/certification/CODEFORGE_CLOUD_GLOBAL_STAGING_CERTIFICATION.md docs/certification/codeforge-cloud-global-staging-certification.json
```

## Scope and honesty notes

- Certification covers the **staging** deployment at the stated SHA. It is not a production
  certification and makes no availability or uptime guarantee.
- Items marked `CARRIED FORWARD` were certified in an earlier session against runtime `d925819`.
  They are retained because the cloud runtime was proven byte-identical across the SHA advance
  (see *Runtime SHA advance*), not because they were re-run.
- The privacy audit comprises **7** checks. An earlier informal summary circulated a figure of
  "17/17"; that figure is not supported by any surviving receipt and has been corrected here to
  the verifiable count.
- Free-capacity counts (30 of 34) reflect live upstream provider availability at certification
  time and will vary as providers change their catalogues.
- `real-staging-smoke` was `skipped` in CI run `33382159655` by conditional guard; it passed in
  run `33382159039`.

---

**`CODEFORGE_CLOUD_GLOBAL_STAGING_CERTIFIED`**

**YES — CERTIFIED**
