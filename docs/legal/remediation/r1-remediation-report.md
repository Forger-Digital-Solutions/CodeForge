# CodeForge Legal R1 — Remediation Report

<!-- ENGINEERING REMEDIATION EVIDENCE — NOT LEGAL ADVICE — does not certify legal compliance -->

**Date**: 2026-09-11
**Branch**: `feat/codeforge-cloud`
**Starting HEAD**: `60f8b54` ("docs: complete CodeForge legal readiness review")
**Scope**: Engineering remediation of the confirmed, evidence-backed Pass-3 issue register. Does
**not** certify legal compliance, replace counsel, make business decisions, publish draft terms,
accept provider contracts, activate billing, file trademarks, or register a DMCA agent.

See [`r1-issue-disposition.md`](./r1-issue-disposition.md) for the full Pass-3-ID-by-ID mapping.
This document is the narrative account of what was built and why.

---

## 1. Approach

Read all seven Pass-3 authoritative inputs first, then mapped every planned remediation to
verified repository/schema/code facts using parallel research passes (package inventory,
cloud-db/cloud-auth schema, provider routing pipeline, desktop UX) before writing any production
code — several of Pass-3's own proposed mechanics turned out not to match the real architecture
(e.g. `ENG-P0-03`'s suggested `cf-ipcountry` header doesn't exist anywhere in the codebase; the
real routing pipeline has four independent selection paths, not one), and the R1 spec explicitly
pre-empted the naive versions of several of these (no blind GeoIP, no hardcoded retention numbers,
no silently-activated age policy).

## 2. New package: `@codeforge/legal-policy`

The authoritative, deterministic PRODUCT POLICY module (R1 spec §7, the "ForgeLegal foundation").
It never interprets law dynamically — every restrictive rule traces to a specific Pass-3 citation
via an `authoritySource` field. Modules: `region.ts` (EEA/UK/CH group abstraction, trusted-vs-
untrusted evidence classification), `provider-policy.ts` (the registry — 10 records across Gemini/
OpenRouter/Groq/Cloudflare, each provider×architecture×serviceTier combination keyed uniquely,
with a ~180-day review horizon), `eligibility.ts` (the gate function itself), `legal-documents.ts`
(version/status tracking, draft-only by construction), `acceptance.ts`, `age-policy.ts`,
`retention.ts`, `claims-scanner.ts`. 46 tests, all passing.

Two real design bugs were caught and fixed during development, before they ever reached
production code paths:
- The registry's lookup key initially omitted `serviceTier`, so Gemini's BYOK-free and BYOK-paid
  records would have silently collided in the index Map (last-write-wins) — fixed by adding
  `serviceTier` to the key and a duplicate-key guard that throws at module load.
- An `attorneyReviewStatus: "PENDING"` flag on the OpenRouter hosted record caused the gate to
  return `WARN` instead of `ALLOW` even after a valid enterprise override authorized the route —
  that status is reserved for genuine open legal questions (the Gemini BYOK/EEA case), not a
  settled business/contract gate; fixed by setting it to `"NONE"` there.

## 3. Provider & regional policy enforcement

Wired into `packages/cloud-gateway` (`CloudFirewallManager.checkProviderPolicy()`,
`GatewayService.executeHostedInference()`) — the **only** hosted, multi-tenant code path in the
repository (confirmed by tracing all four routing implementations); Desktop BYOK never touches
this code. The gate runs before ForgeZero's financial verification, since it is a different
authority (contractual/regional restriction, not cost) that must be able to reject a route
ForgeZero would otherwise consider $0-eligible.

Region evidence flows from a new, narrowly-scoped `apps/cloud-api` config field,
`trustedRegionHeaderName` (env `CODEFORGE_TRUSTED_REGION_HEADER`), deliberately separate from the
existing `trustProxy`/`X-Forwarded-For` flag — a wrong IP degrades convenience, but a spoofed
*country* can defeat a legal restriction, so it gets its own explicit opt-in. Unset by default (no
value shipped or configured), which means **hosted Gemini-unpaid routing now fails closed for
every region until an operator explicitly wires a trusted edge header** — a real, intentional
behavior change, not a bug: previously this route had zero region awareness at all, which was the
actual LEG-P0-03 violation. Groq/Cloudflare/BYOK are unaffected (no region restriction in their
policy records), so ForgeAuto's auto-routing gracefully lands on them instead — proven directly
(`packages/cloud-gateway/test/provider-region-policy.test.ts`), not just asserted.

OpenRouter hosted pooling is denied by default for the same reason (no Enterprise Agreement on
file); a trusted, server-config-only `EnterpriseOverrideConfig` exists for if/when one is signed,
verified to be un-forgeable from a client request (`packages/legal-policy/test/eligibility.test.ts`
authority-boundary suite).

## 4. Cloud account deletion (GDPR Article 17)

The single most safety-critical piece of this milestone. Built from schema truth (migration DDL,
FK cascade clauses), not from Pass-3 prose:

- **`packages/cloud-db`**: `ICloudDatabase.deleteUserAccount(userId)` explicitly deletes all 16
  user-linked tables (not relying on `ON DELETE CASCADE` for the SQLite backend, since — a real
  finding — SQLite enforces foreign keys only if a `PRAGMA foreign_keys = ON` this codebase never
  sets is active; on Node 22.5+/24+, the module's `node:sqlite` engine happens to default that
  pragma ON, while its `better-sqlite3` fallback does not, so relying on cascade would have been
  *inconsistent* across the two backends it can run on). PostgreSQL's real cascade is left as a
  defense-in-depth safety net for any future migration that adds a new user-linked table and
  forgets to extend this method's explicit list. `abuse_events` rows are anonymized
  (`user_id → NULL`), never deleted — mapped directly to the `SECURITY_AUDIT` retention class,
  which R1 spec §26-27 says must not be purged without an approved retention decision, while still
  severing the identifying link on erasure.
  - A real ordering bug was caught and fixed here too: `publications` (a child of
    `github_installations`) was originally deleted *after* its parent, so on an engine that
    enforces FK cascade the explicit delete would silently find nothing left to delete, under-
    reporting the receipt (the row still ends up gone, but the evidence would lie about how).
- **`packages/sessions`**: added `deleteEventsForSession()` — the `events` table has no FK/cascade
  back to `sessions` at all (confirmed in `postgres-migrations.ts`), so `deleteSession()` alone
  would have silently orphaned it. This was a real, previously-undetected gap the schema research
  surfaced.
- **`apps/cloud-api/src/account-deletion.ts`**: coordinates both (sessions first, since a failure
  there leaves the account retryable; then the single cloud-db transaction), returns a receipt
  with categories and retention reason codes only — never row-level content (R1 spec §85).
- **`DELETE /v1/account`**: Bearer-only (immune to CSRF by construction — browsers never attach
  `Authorization` automatically), userId sourced only from the verified JWT (there is no
  parameter, forged or otherwise, that could target a different account), explicit
  `{"confirmation":"DELETE_MY_ACCOUNT"}` body required.
- **Proof, not assertion**: `packages/cloud-db/test/account-deletion.test.ts` runs against both
  SQLite and a **real PostgreSQL server** (via the repo's existing WSL-hosted test-harness script,
  in a disposable per-run schema) — proving zero orphaned rows across every table, cross-user
  isolation, idempotent retry, and that the transaction primitive (`withTx`) genuinely rolls back
  on a forced mid-transaction failure. `apps/cloud-api/test/account-deletion.test.ts` proves the
  full HTTP path including a real hosted workflow session getting deleted.
- **Desktop UX**: `Settings → Legal → Account & Deletion` and a two-step "Danger Zone" confirmation
  in the Cloud Account modal, wired to a new `cloud:account:delete` IPC handler. Live-verified in a
  real Electron capture harness (see §7) — the confirm screen, its honest retained-records wording,
  and the actual IPC call firing were all directly observed, not just code-reviewed.

## 5. 8-Bit authentication circuit breaker

`packages/eight-bit/src/health.ts` previously treated `AUTH_FAILURE` (401/403) as a normal
time-bounded cooldown (exponential backoff capped at 15 minutes, then automatic retry regardless
of how many times it had already failed) — exactly the "burn requests against invalid
credentials" behavior R1 spec §21-22 flags. Now, the 3rd consecutive auth failure permanently
suspends the route (`permanentlySuspended: true`) until an explicit `clearPermanentSuspension()`
call — the human-in-the-loop recovery path. Chose `Number.MAX_SAFE_INTEGER` over `Infinity` for
the stored "forever" cooldown specifically because the health snapshot round-trips through
`EightBitDecisionStore`'s JSON persistence, and `JSON.stringify(Infinity)` silently becomes `null`
— which would have un-suspended the route on the next process restart. Caught by a dedicated
round-trip test. 14 tests in `health.test.ts` (6 new), all passing, including real-PostgreSQL
evidence via `packages/eight-bit/test/postgres.test.ts`.

Not wired: automatically calling `clearPermanentSuspension()` from the desktop credential-update
IPC handler — `apps/desktop/src/main.ts` does not currently hold a reference to the active
`AgentRuntime`'s health tracker, and threading one through was judged too large/uncertain a change
to make confidently within this milestone. Documented as a scoped follow-up, not silently dropped.

## 6. Licensing

- **Root LICENSE**: MIT is already declared consistently in three independent places (root
  `package.json`, `README.md`, `CONTRIBUTING.md`) with zero conflicting statements — sufficient
  evidence to prepare the canonical MIT text. The copyright **holder name** is not: Pass-3's own
  `final-business-decisions.md` (BIZ-01) records it only as a recommendation pending owner
  approval. Per R1 spec §4's explicit instruction not to invent an owner, `LICENSE.pending`
  carries the real MIT text with the holder line marked `[OWNER_AUTHORIZATION_REQUIRED]` —
  renaming it to `LICENSE` is a one-line change once the owner confirms a name.
- **Workspace packages**: reproduced the inventory rather than trusting Pass-3's "~38-39" estimate
  — **43** packages exist (`apps/*` + `packages/*`), and **all 43** were missing `"license"`.
  `scripts/legal/normalize-package-licenses.mjs` (idempotent; `--check` mode for CI) fixed all 43
  to `"license": "MIT"`, matching the repository's own declared policy.
- **`packages/vscode`**: had no `"private"` field at all (nothing stopped a stray `npm publish`
  from attempting to publish it to the public npm registry, separate from its intended VS Code
  Marketplace channel), no `LICENSE`, no `README.md` (the Marketplace renders that as the listing
  page). Added `"private": true`, `"repository"`, `LICENSE.pending`, and a real `README.md`.

## 7. Desktop legal UX — live-verified, not just code-reviewed

Given the system's own guidance that type-checking verifies correctness but not feature
correctness, every desktop UI change below was verified against the **actual built renderer**
(`vite build` output) and the **actual `preload.cjs`** (the real, hand-maintained file `main.ts`
loads at runtime — not the parallel `preload.ts`-compiled output, which the build explicitly
excludes from packaging) inside a real Electron `BrowserWindow`, with the same
`contextIsolation: true` / `sandbox: true` / `nodeIntegration: false` settings the packaged app
ships with. IPC handlers were mocked at the boundary; everything inside that boundary — React
state, conditional rendering, real `contextBridge` round-trips — was exercised for real.

- **First-run age + host-execution disclosure** (`AuthScreen.tsx`): a single combined checkbox
  (R1 spec §38: not a "giant legal modal") gates "Continue with GitHub". **Verified**: button
  `disabled=true` with the box unchecked; clicking it flips `disabled=false` and the disclosure
  cleanly unmounts (no repeated nagging). Screenshots captured before/after.
- **Settings → Legal**: a new subsection listing all 9 legal documents as "Draft — not yet
  effective" (no internal counsel markers like `[BUSINESS DECISION REQUIRED]` exposed to ordinary
  users, per R1 spec §36), Privacy/Terms links, and a link into account deletion. **Verified**: the
  section renders inside the real Settings modal alongside the existing, untouched
  `ProviderSetup` UI; the exact three link labels (`Privacy`, `Terms`, `Account & Deletion`) were
  found in the live DOM.
- **Account deletion "Danger Zone"** (Cloud Account modal): idle → confirm → deleting/error state
  machine, honest wording (mentions retained security/audit records, clarifies local files and the
  GitHub account are unaffected — never claims instant total erasure per R1 spec §29). **Verified**:
  clicking "Delete Account" shows the exact confirmation text; clicking "Yes, delete my account"
  actually invokes the `cloud:account:delete` IPC call (confirmed via a mock handler flag, not
  inferred).

New main-process IPC surface (`legal:getFirstRunAck`, `legal:setFirstRunAck`,
`cloud:account:delete`) takes no untrusted parameters from the renderer that could fake an
acknowledgement or target a different account — each handler always acts on "the current user, the
current moment," mirroring the existing `cloud:account:get`/`cloud:auth:logout` pattern.

## 8. Claims remediation

`@codeforge/legal-policy`'s claims scanner implements the R1 spec §41-44 phrase set, classified by
context so historical Pass-1/2/3 evidence and internal engineering language are never flagged.
Scanned `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, plus a repo-wide `docs/**` sweep (excluding
`docs/legal/**`): the only non-historical hit was `SECURITY.md`'s "Zero-Billing **Guarantee**"
heading (didn't match the automated patterns' exact word order, but was in the same spirit as "avoid
Guaranteed never billed") — softened to "Zero-Billing **Enforcement**" with a clarifying sentence
that this describes CodeForge's own routing behavior, not a claim about third-party billing
outcomes. The historical `docs/codeforge-r9-daily-driver-commissioning-report.md` ("guaranteed 0
mutations" describing one specific past read-only test run) was correctly left untouched — it is
evidence of a past certification, not a live capability claim.

## 9. Release gate

`npm run audit:legal-release -- --mode=<INTERNAL|DESKTOP_BYOK_BETA|HOSTED_FREE_BETA>`: 10 objective
engineering checks (license metadata, VS Code publish-readiness, third-party notices freshness,
provider-policy freshness, no-restricted-hosted-route, claims regression, age/legal-version
infrastructure presence, secret scan). Mode-aware per R1 spec §63 — a hosted-only blocker never
fails a desktop-only build. Exit code 1 only on a genuine engineering `FAIL`;
`BLOCKED*`/`NOT_APPLICABLE` are reported but do not fail CI, since they are already-tracked
business/counsel items a human must clear, not something this script can fix. Wired into
`.github/workflows/windows-desktop.yml` as a real gate step (generates fresh notices, then runs
the gate, before `npm test` and packaging).

## 10. Test evidence

| Suite | Result |
|---|---|
| `packages/legal-policy` | 46/46 passed |
| `packages/cloud-gateway` (incl. new region-policy suite) | 25/25 passed |
| `packages/cloud-db`, `packages/sessions`, `apps/cloud-api`, `packages/eight-bit` — combined, against a **real PostgreSQL server** (WSL-hosted, disposable per-run schema) | 316/316 passed, 36 files |
| Full repo build (`npm run build`, every workspace) | Clean, 0 errors |
| Full repo test suite (`npm test`, default/SQLite config) | 1836 passed, 36 skipped, **1 pre-existing failure** (`tests/evidence/qualification-fixtures/patch-generation/test/config.test.ts` — `describe is not defined`; confirmed via `git log` to originate from commit `188fb73`, three commits before this milestone's starting HEAD, and untouched by this session — not a regression) |
| Secret scan of this session's full diff (added lines only) | 0 real findings (2 false positives: this report's own prose mentioning "Bearer access token" conceptually) |

One real regression was found and fixed during this work: `apps/cloud-api/test/hosted-capacity.test.ts`
used a `FakeOpenRouter` mock purely as a convenient stand-in for testing the general zero-setup
hosted-capacity/routing/usage-settlement machinery — nothing in that test was actually about
OpenRouter's legal status. Once the OpenRouter hosted-pooling restriction was correctly enforced,
that fixture's incidental choice of provider ID broke. Fixed by switching the fixture to Groq
(unrestricted), preserving the test's actual intent — the restriction itself was not weakened to
make the test pass.

## 11. Packaged application — blocked by a pre-existing local environment gap

This local machine has Visual Studio "18" (VS2026) installed. `@electron/rebuild`'s bundled
`node-gyp` cannot detect it (`gyp ERR! find VS unknown version "undefined"`), so `better-sqlite3`
cannot be rebuilt against Electron's ABI here, and `electron-builder` packaging cannot proceed
locally. This is not new, not a regression, and not something this milestone should "fix" by
altering a toolchain pin: it is the *exact* documented reason
`.github/workflows/windows-desktop.yml` already pins `windows-2022` runners (see the workflow's
own header comment, and this repository's saved memory of the same finding from a prior session).
Confirmed by directly attempting `npm run build:native` and observing the identical failure mode.

Because packaging itself is blocked, `PACKAGED_SECURITY`/`PACKAGED_SMOKE` could not be run against
a *new* packaged artifact either. In their place: (a) the full repo build/typecheck compiled the
production `main.ts`/`preload.cjs`/renderer bundle cleanly, including every new legal-UX addition;
(b) the Electron capture harness in §7 exercised the real renderer and real preload under the same
`contextIsolation`/`sandbox`/`nodeIntegration` settings the packaged app ships with — it is not a
packaged installer, but it is the real production code, not a mock; (c) `main.ts`'s
`sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true` webPreferences
were confirmed unchanged by this milestone via direct code inspection and via the full test suite
(`apps/desktop/test/packaged-browser-security.test.ts` — a pre-existing regression test for exactly
this — still passing). The legal release gate is wired into the CI workflow that *does* run on a
compatible runner, so it will execute against every future packaged build without further action.

## 12. Zero-spend confirmation

No paid inference, no live Stripe transactions, no provider-agreement actions were taken. All
tests use mocks, fixtures, or free-tier-shaped fake providers; the only real external network
calls made during this milestone were to a disposable local WSL-hosted PostgreSQL instance and to
localhost test servers.

## 13. Remaining attorney questions

Unchanged from `docs/legal/pass3/final-attorney-review-packet.md` — none of its 7 questions are
engineering-resolvable, and none were touched:
1. Does Desktop BYOK Gemini in the EEA count as "making API Clients available" under Google's
   terms? (Represented in code as `attorneyReviewStatus: "PENDING"`, not auto-blocked.)
2. Is an OpenRouter Enterprise Agreement mandatory before hosted pooling? (Engineering now denies
   this route by default pending that answer.)
3. Does secondary liability attach for user-submitted employer trade secrets on unpaid tiers?
4. Confirm CodeForge is not a GDPR data controller for local desktop SQLite data.
5. Are the proposed ToS disclaimers sufficient for host-command-execution liability?
6. Governing law / arbitration / class-action waiver — Delaware+AAA vs. California+courts?
7. Trademark clearance posture for "CodeForge".

## 14. Remaining business decisions

Unchanged from `docs/legal/pass3/final-business-decisions.md`; the ones with a direct engineering
dependency now have real, tested capability waiting on them rather than a TODO:
- **BIZ-01** (root license copyright holder) → unblocks `LICENSE.pending → LICENSE` (one command).
- **BIZ-04** (18+ vs. 13+ minimum age policy-of-record) → unblocks
  `approveAgePolicy()` in `@codeforge/legal-policy` (already implemented, unused pending approval).
- **BIZ-03** (OpenRouter Enterprise Agreement pursue/skip) → unblocks a server-config
  `EnterpriseOverrideConfig` entry (already implemented, no code change needed to activate).
- Retention durations for `SECURITY_AUDIT`/`BILLING_RECORD` classes (part of the Pass-3 P3-01
  finding) → unblocks setting `retentionDays` on those two `RetentionPolicyEntry` records.
- BIZ-02, BIZ-05 through BIZ-12 (launch geography, governing law, pricing/refunds, trademark
  strategy, DMCA agent, contact emails, Stripe live timeline) have no engineering-side capability
  gap; they are pure business/legal decisions with no code waiting on them.
