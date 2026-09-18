# Security Testing

The regression gate (Phase 57), the suites it runs, and the ATTACK-001…016 acceptance evidence
(Phases 51–56). Every property CodeForge claims has a runnable assertion listed here.

## How to run

```bash
npm run security:tests    # crypto, secrets, cloud-auth, billing, acceptance, Electron baseline, local control plane
npm run security:gate     # secret scan (self-test + scan), dependency audit + SBOM, public-claims scan, doc-link validation
npm test                  # full regression (all workspaces)
```

CI: `.github/workflows/security-gate.yml` runs typecheck, lint, build, every suite below, and the
four gates on every push and pull request, with `permissions: contents: read` and no secrets.
`cloud-ci.yml` additionally runs the cloud suites against a real TLS PostgreSQL container.

## Suites

| Suite | Path | Proves |
| --- | --- | --- |
| Cryptographic storage | `packages/crypto/test/envelope.test.ts` (19 tests) | Phase 51 properties 1–14: round trip, unique nonce/ciphertext/DEK, tamper of ciphertext/nonce/tag/wrapped-DEK fails, wrong key fails, wrong AAD fails, version lookup, staged rotation, legacy migration, malformed input, no plaintext in errors/logs; key-ring parsing and fail-closed runtime |
| Redaction / audit / env filter | `packages/secrets/test/security-primitives.test.ts`, `redaction.test.ts` | Every credential shape is masked in text and structures; logger redacts at the boundary; audit sanitizer bounds and redacts; child-env deny list strips every CodeForge/provider secret name |
| OAuth / sessions | `packages/cloud-auth/test/auth.test.ts`, `github-app.test.ts`; `tests/cloud-adversarial-security.test.ts`; `tests/production-auth-bypass-guard.test.ts` | Loopback-only redirects, PKCE binding, single-use state/code, replay refusal, refresh rotation with breach detection, no header/body identity assertions, `alg=none`/unsigned tokens refused, no token from query/cookie, GitHub App ownership checks |
| Payments | `packages/cloud-billing/test/billing.test.ts` | Signature/tolerance, idempotent grants, renewal ledger, test-mode enforcement |
| Tenant isolation | `apps/cloud-api/test/publication-http.e2e.test.ts`, `hosted-workflow-authority.test.ts`, `account-deletion.test.ts`, `tests/two-client-authority.test.ts`, `tests/cloud-concurrency-ledger.test.ts` | Cross-user ids indistinguishable from unknown; owner-scoped workflows; deletion by token only; reservation spoofing refused |
| Local control plane / agent | `packages/server/test/network-exposure.test.ts`, `hardening-adversarial.test.ts` | Loopback bind, origin gate, bearer, `Origin: null` policy, DNS-rebinding `Host` check, approval races, command classification, sanitized env, search redaction |
| Electron | `apps/desktop/test/electron-security-baseline.test.ts`, `packaged-browser-security.test.ts`, `preload-bridge.test.ts`, `control-plane-trust.test.ts`, `git-exec-allowlist.test.ts`, `renderer-csp.test.ts`, `secure-credential-codec.test.ts` | Phase 56 assertions on every window; permission denial; IPC sender validation on every handler; preload surface; production CSP; local secret codec |
| Acceptance | `tests/security/attack-acceptance.test.ts` (19 tests) | ATTACK-001…016 below, plus headers, `security.txt`, generic errors |
| Packaged desktop (real Electron) | `npm run smoke` (`apps/desktop/scripts/packaged-smoke.js`) | Encrypted persistence, corrupt/legacy-plaintext credential rejection and migration, renderer bearer absence, secondary-window 401, forged origin 403 |

## ATTACK acceptance evidence (R1 run: all PASS)

| Id | Attack | Expected defense | Test | Result | Remaining risk |
| --- | --- | --- | --- | --- | --- |
| ATTACK-001 | Credential/session tables stolen | No usable secret: GitHub token absent, tokens/codes hashed, verifier sealed and unopenable without the ring | acceptance "ATTACK-001" | PASS | PII and billing metadata readable from a dump (R-01) |
| ATTACK-002 | Ciphertext byte altered in the DB | Callback fails closed (400, no redirect, no code minted); `crypto.decrypt.failed` audited | "ATTACK-002" | PASS | — |
| ATTACK-003 | Sealed secret moved to another tenant's row; user A reads user B's workflow | Envelope AAD mismatch → 400; foreign ids → 404 without content | "ATTACK-003" | PASS | No DB-level RLS (R-11) |
| ATTACK-004 | Renderer/model requests the provider key | No route body/header or SSE stream contains the planted key, JWT secret, or webhook secret; preload has no getter | "ATTACK-004" | PASS | — |
| ATTACK-005 | Tool runs `env`/`set`/Node env dump | Sanitized child env: none of eight planted control-plane secrets appear in output | "ATTACK-005" | PASS | Workspace content is still readable by approved commands (R-04) |
| ATTACK-006 | Log receives Authorization/Cookie/key | Redacting logger masks by field name and shape; text redactor agrees | "ATTACK-006" | PASS | Unprefixed high-entropy strings (R-16) |
| ATTACK-007 | Forged GitHub callback state | Static 400 page, no `Location`, forged value not reflected | "ATTACK-007/008" | PASS | — |
| ATTACK-008 | Replayed callback / replayed desktop code | Second callback 400; second exchange 400; audited | "ATTACK-007/008" | PASS | — |
| ATTACK-009 | Forged/replayed/unpaid/live-mode webhook | Bad signature 400; tampered body 400; unpaid → `deferred_awaiting_payment` (no grant); live-mode rejected; paid grants once, replay `duplicate_skipped` | "ATTACK-009" | PASS | Stripe live mode untested (R-12) |
| ATTACK-010 | Client asserts plan/balance/price | Unknown fields stripped; plan stays free; unknown plan id 400; foreign return URL 400 | "ATTACK-010" | PASS | — |
| ATTACK-011 | Guessed session/workflow id on the local control plane | 401 without bearer; 403 for foreign origin even with bearer | "ATTACK-011" | PASS | — |
| ATTACK-012 | Repository path escape (`..`, absolute, UNC, outside temp) | `resolveWithinWorkspace` denies traversal; absolute paths only inside the root | "ATTACK-012" | PASS | Symlink races (TOCTOU) mitigated by realpath at check time only |
| ATTACK-013 | Attacker URL to metadata/private hosts/non-http schemes | Billing return URLs and external links refused | "ATTACK-013" | PASS | `run_command` can reach any host the user permits (by design) |
| ATTACK-014 | Access token reuse after logout; refresh replay | 401 `UNAUTHENTICATED` immediately; refresh 401; audited | "ATTACK-014" | PASS | 15 s liveness cache in other processes of a multi-instance deployment |
| ATTACK-015 | Old-key rotation | v1 envelope opens with `[v2,v1]`; new rows sealed under v2; v2-only fails closed on v1 | "ATTACK-015" | PASS | — |
| ATTACK-016 | Backup restore of encrypted rows | Restored rows open with the same ring and complete a login; a different ring fails closed | "ATTACK-016" | PASS | Provider backup encryption unverified (R-01) |

Run record: `npx vitest run tests/security` — 19 passed (2026-09-18). The certification
report cites the exact command outputs.

## Gates (R1 results)

| Gate | Command | Result |
| --- | --- | --- |
| Secret scan | `node scripts/security/secret-scan.mjs --self-test --scan` | self-test PASS; scan PASS (0 owner-review findings; synthetic fixtures classified; 2 allowlisted reviewed lines) |
| Dependency audit + SBOM | `node scripts/security/audit-dependencies.mjs` | PASS — 0 advisories; 540 components in `sbom.json` |
| Public claims | `node scripts/security/public-claims-scan.mjs` | PASS — no blocking unsubstantiated security/compliance claim in public copy |
| Doc links | `node scripts/security/validate-doc-links.mjs` | PASS |

## Performance notes (Phase 58)

- Envelope seal/open: two AES-256-GCM operations on ≤128-byte payloads — sub-millisecond; performed once per sign-in.
- Session liveness: one indexed primary-key lookup per authenticated request, cached in-process for 15 s per session; cleared immediately on logout/refresh/deletion in the same process.
- Redaction: regex passes over log fields and tool output; bounded at 4 KiB per string leaf in structured logs.
- Retention sweep: six indexed `DELETE`s hourly.
- No long-lived plaintext secret is cached: BYOK keys are read from sealed storage per call; DEKs are zeroed after use.

## What is not automated

- Real GitHub/Stripe/provider interaction (mocked at the `fetch` seam; live smokes are manual and secret-gated).
- Packaged Electron smoke in the security gate (runs in the release workflow).
- Distributed rate limiting and multi-instance cache invalidation (single-instance deployment today).
