# R55 final report — backend completion

Verdict inputs and evidence for `r55-backend-completion-v1`.

Product thesis: CodeForge makes the model market interchangeable infrastructure — the user
chooses which intelligence they are willing to use; ForgeAuto assembles the team only from
that authorized roster; ForgeGreen stays the capacity authority; ForgeVerify stays the only
completion authority.

## Repository

- Branch: `codex/r29-release-closure`
- Starting HEAD: `18841a0f` (R54 finalize)
- Implementation HEAD: `da5afdb3` (R55 backend completion, 44 files, +5545/-68)
- Certification HEAD: this commit (certification document + this report + matrix finalization)
- Working tree: clean except the preserved unrelated R34 benchmark artifact
  (`docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`, deliberately
  uncommitted — regenerated benchmark numbers from a pre-existing R34 run)
- Starting certification: `r54-eight-bit-intelligence-v1`
  (`998609d11f148822ae0d7dbd811ded7a7b27017965d1450cc15c07548f919706`)
- Final certification: `r55-backend-completion-v1`
  (`5478003269dd076f7cfe92ac4e85f87097b63b4f7b24b7b316386d7fd871a727`)

## Recovered work

The interrupted R55 wave was preserved intact: roster foundations, Lead topology, Shilling
ledger, paid-family catalog, and the orchestrator/runtime wiring. Continuation added
user-owned (USER_API) execution, managed-paid accounting, decision receipts, multi-user
isolation, restart/recovery proof, and the completion matrix. No prior work was discarded;
no R55 commits existed before `da5afdb3`.

## Completion matrix

`R55-BACKEND-COMPLETION-MATRIX.md` — 66 requirements, all terminal:
`PROVEN_DETERMINISTIC` ×66, `PROVEN_LIVE` ×0, `NOT_APPLICABLE` ×0, `BLOCKED_EXTERNAL` ×0,
internally unresolved ×0. No live-provider ceremony was required for V1: every row closed
on deterministic evidence; Postgres-specific suites remain skips (no provisioned instance),
which are environment skips, not implementation gaps, and the physical schema is unchanged.

## ForgeAuto rosters

- Schema: `ForgeAutoRoster` — owner, entitlement (FREE/PAID/CUSTOM), slots
  (`PINNED_VERSION`/`AUTO_CURRENT`/`AUTO`), Lead mode (NONE/AUTO/MANUAL); `RosterPolicy`
  default 2..5 slots, single-model disallowed by default.
- Owner scope: `ForgeAutoRosterStore` hash-keys records by owner; API derives owner from the
  trusted session identity — request bodies cannot escalate.
- Free eligibility: FREE admits managed-Free only; USER_API rejected under FREE and PAID.
- Paid eligibility: PAID admits managed-Free + managed-Paid; a paid Lead never forces paid
  workers.
- Enforcement: `rosterRouteAllowance` filters initial selection, role routing, failover,
  and retry; unselected models are never invoked (`ROSTER_ROUTE_NOT_SELECTED`,
  `ROSTER_NO_ADMITTED_ROUTE`).
- Non-R1 bypass closed: `subagent-manager.ts:489,809` force `roleRouting` whenever an
  allowance is present, on spawn and recovery; regression in `subagents.test.ts`.

## Lead

Optional read-only child: zero write/command budget, 4,000-char bounded advice handoff,
cannot approve review or declare completion. `lead.mode = NONE` lets small tasks skip it.
A Lead "task complete" claim with no ForgeVerify evidence leaves the run `blocked`
(`autonomous-orchestrator.test.ts`).

## 8-Bit

Managed-free discovery/qualification/rotation unchanged and re-proven: `packages/eight-bit`,
`free-fabric-wiring`, `eight-bit-active-run-failover`, `eight-bit-restart-and-exact-pin`,
`free-cloud-registry`, `probe-route-capacity`, `r52-stale-receipt` — all green. AUTO free
rotation stays inside the authorized roster; an exact free pin that disappears surfaces
`PINNED_MODEL_UNAVAILABLE`, distinct from `PINNED_MODEL_ROLE_INELIGIBLE`.

## 16-Bit

- `PaidFamilyCatalog`: explicit approved-successor identity — never name-prefix inference;
  cross-family succession rejected.
- Lifecycle: DISCOVERED → PROBATION → QUALIFIED → ACTIVE (+ ACTIVE_ECONOMY predecessor,
  SUPERSEDED, RETIRED); promotion requires qualification + benchmark + live + pricing +
  reliability + context/tool + verified-completion-cost evidence; demotion only to a
  qualified same-family fallback.
- AUTO_CURRENT resolves only certified active same-family successors — incumbent until
  explicit promotion, proven before and after restart.
- PINNED_VERSION is exact; a provider-unavailable pin never substitutes — user action or
  explicit fallback required.
- Price changes move economy ranking only; role qualification evidence is untouched.
  429/503 are capacity events, not quality events.
- Catalog hydration is all-or-nothing and validates duplicates, lifecycle, family links,
  and single-ACTIVE-per-family.

## User-owned intelligence

- V1 executable path: `USER_API` — explicit OpenAI-compatible HTTPS endpoint.
  USER_HOSTED/LOCAL remain schema values and fail closed
  (`ROSTER_SOURCE_NOT_EXECUTABLE_V1`).
- Endpoint policy: HTTPS only, public host, no credentials/query/fragment/traversal,
  loopback/private/link-local/ULA/CGNAT literals refused.
- Identity: provider ID and credential ref are SHA-256-derived from `(owner, sourceId)` —
  caller cannot supply them; tuple separation prevents `(ab,c)`/`(a,bc)` collisions.
- Qualification: UNQUALIFIED/QUALIFIED/SUSPENDED; only qualified + credentialed sources
  execute; a SUSPENDED re-put invalidates outstanding allowances immediately.
- Execution: owner-frozen adapter identity checked at dispatch; Bob cannot execute Alice's
  source even with a copied allowance.
- Source isolation: user routes never enter the Free Fabric, Paid Auto, or ForgeZero
  managed-free admission; failover stays inside the explicit user route list.

## Credential security

- Only `credentialRef` values persist; roster projections strip credentialRef/endpointUrl.
- Keys resolve at request time through an owner-scoped resolver on the trusted host
  (desktop: `safeStorage`-backed, owner must equal the connected scope identity; plaintext
  credentials are never usable).
- Deterministic sweeps prove the key appears nowhere in durable work items, events,
  errors, or summaries — it exists only as a wire `Authorization` header to its own endpoint.
- Security gate: secret-scan PASS (1790 files, 0 owner-review-required), dependency audit
  PASS (0 blocking), public-claims scan PASS (0 blocking), doc-links PASS (0 broken).

## Privacy / data policy

`RosterCandidate.dataPolicy` gates resolution on privateCode + consent; USER_API sources
carry a persisted dataPolicy. No route executes outside its declared policy.

## Shilling ledger

- Raw input/output/allowance units retained verbatim (TOKENS/REQUESTS/DOLLARS/CREDITS/
  NEURONS/COMPUTE_UNITS/MONTHLY_ALLOWANCE/UNKNOWN).
- Conversion records method + confidence (AUTHORITATIVE/OBSERVED/ESTIMATED/UNKNOWN);
  UNKNOWN never coerces to zero — every derived field stays null.
- Aggregation: per-role, per-task, per-source-class; managed spend, user-provider spend,
  and cost confidence are distinct fields — never merged.
- Verified-completion metrics require ForgeVerify evidence (`verifiedCompletion`,
  `shillingsToVerifiedCompletion`, `verifiedWorkPerMillionSh`, `frontierInferenceShare`,
  `managedPaidShare`, `userOwnedShare`, `frontierCostPerVerifiedTaskUsd`).
- Durable + idempotent: deterministic entry IDs, insert-if-absent, conflict on divergent
  replay — proven across process restart.
- Gross/usable/available-now fields exist and stay null rather than invented where runtime
  capacity snapshots are not yet wired (documented limitation).

## Cost accounting

Three separate domains:

- Managed Free: $0 by admission (ForgeZero); no spend field.
- Managed Paid: `ManagedPaidAllowanceLedger` — included allowance + hard maximum
  (null = `MANAGED_PAID_ALLOWANCE_UNKNOWN`, never unlimited), atomic pre-dispatch
  reservation at a conservative estimate, settle-once with OBSERVED actual or ESTIMATED
  reservation (a null actual is never zeroed), release before dispatch, idempotent replay,
  `MANAGED_PAID_ACTUAL_EXCEEDS_RESERVATION` keeps the hold open for reconciliation,
  `MANAGED_PAID_ACCOUNTING_FAILED` after a served response never triggers retry/failover.
- User-owned: `userProviderSpendUsd` computed only from provider-reported usage × declared
  rates; null/UNKNOWN when either is missing; never touches the managed allowance.

Allowance exhaustion blocks paid admission pre-wire; eligible free roster members continue
serving; nothing silently bills, falls back to BYOK, or ignores the hard maximum.
`PaidCostMode` (CHEAPEST/BALANCED/MAXIMUM_INTELLIGENCE/CUSTOM) is a ranking input only —
it cannot override roster, entitlement, allowance, or ForgeVerify.

## Persistence / recovery

Work-item kinds added (no physical DDL — zero migrations required; proven by the pre-R55
database compatibility test): `forgeauto_roster`, `paid_family_catalog`,
`user_intelligence_source`, `shilling_entry`, `managed_paid_account`,
`managed_paid_reservation`, `managed_paid_receipt`, `forgeauto_decision_receipt`,
plus `rosterAllowance` on `subagent_run`.

Restart proofs: roster+Lead+pins+family policy survive restart; recovered workers replay
the identical allowance (pinned user route verbatim); AUTO_CURRENT resolves from the
hydrated catalog; user-source refs persist without secrets; Shilling/managed-paid records
never duplicate.

## Multi-user isolation

`r55-multi-user.test.ts`: per-owner roster persistence (Lead/pin never cross), copied
allowance refused under another user before any network, managed-paid accounts/receipts
owner-isolated on a shared store, per-worker owner+allowance recovery without bleed.

## Database / migrations

None required — R55 persists new work-item kinds inside the existing generic `work_items`
schema. `persistence.test.ts` opens a byte-identical pre-R55 DDL database, proves prior
rows survive, then writes/reads `forgeauto_roster` and `shilling_entry` rows. Postgres
suites remain environment-skipped (no provisioned instance), consistent with the repo's
`test:postgres` harness split.

## Observability

Append-only `forgeauto_decision_receipt` work items: run/agent/owner/roster-version/role,
bounded candidate list (provider, model, source class, family, version, lifecycle,
qualification), selected canonical identity, reason codes, fallback origin, timestamp.
Receipts carry no endpoint URLs, credential refs, keys, or message bodies; the
`paid-auto/auto` sentinel is never recorded as a selection — only the resolved canonical
route.

## ForgeGreen

Capacity authority unchanged — roster filters, Fabric decides: `provider-topology-capacity`,
`workflow-capacity-wait`, `r46-capacity-confidence`, `r52-stale-receipt` all green;
CAPACITY_UNMEASURED remains distinct from exhaustion.

## ForgeVerify

Seven-file adversarial/completion corpus: 83 tests, 0 failed — `completion-gate` (19),
`forge-verify` (6), `forge-verify-evidence` (5), `r21-completion-gate-binding` (11),
`r21-forgeverify-integrity` (7), `r21-forgeverify-malicious-corpus` (24),
`r21-forgeverify-stale-evidence-matrix` (11). `FALSE_COMPLETION_COUNT = 0` — no adversarial
case (forged completion, stale evidence, malicious corpus, Lead/user/roster claims) reached
`completed`.

## Focused tests

Broad R55 gate: 81 test files passed / 1 skipped; 879 tests passed / 2 skipped / 0 failed
(97.11s). Skips: 2 pre-existing Postgres tests. Post-gate addition: `subagents.test.ts`
non-R1 roster regression — 11/11 pass.

## Full regression

Root `vitest run` on the final R55 source (pre-recertification state):
508 test files — 497 passed / 3 failed / 8 skipped; 4242 tests — 4191 passed / 3 failed /
48 skipped; 728.50s. One unhandled EPIPE socket-teardown error in
`fg1-runtime-efficiency.test.ts` (environment artifact; the file's tests passed).

Failure classification (all three — zero unexplained):

1. `fg11-source-state.test.ts` — stale-cert canary: live tree vs R54 certification.
   Resolved by R55 recertification; PASS on rerun (8/8 canary tests green).
2. `fg12e-harness-provenance.test.ts` — same stale-cert cause. PASS on rerun.
3. `cf14-large-repo-benchmark.test.ts` — wall-clock contention flake: context-assembly
   median 506ms vs 500ms bound under full-suite parallel load; passes standalone in 36.7s.
   `packages/repo-intelligence` untouched by R55 — unrelated baseline/environment flake.

## Typecheck / build

- `npm run typecheck` (`tsc -b --force`, whole monorepo): exit 0, no diagnostics.
- `npm run build` (all workspaces incl. Electron renderer + web): exit 0.

## Certification

- Identity: `r55-backend-completion-v1`
- Source-state hash: `5478003269dd076f7cfe92ac4e85f87097b63b4f7b24b7b316386d7fd871a727`
- Material count: 54 files (39 carried + 15 audited additions: the roster, user-source,
  paid-family, ledger modules; `server/index.ts` and `subagent-manager.ts` composition
  roots; `cloud-usage`/`server` package manifests)
- Guarded script: `benchmarks/r55/recertify-source-state.mjs` — refused unless predecessor
  is exactly R54, drift is exactly the reviewed 20-file set, and every material file is
  committed. Executed clean; canary rerun: 2 files / 8 tests, all pass.

## Remaining limitations

- USER_API V1 is OpenAI-compatible only; USER_HOSTED/LOCAL remain non-executable schema
  values (fail closed) — broader protocol support is post-R55.
- `apps/` credential-sealing files follow the historical convention of sitting outside the
  packages-scoped certified surface; they are covered by the desktop credential tests and
  the security gate.
- Gross/usable/available-now Sh fields are honest-null pending runtime capacity wiring.
- Cost modes are contract-level ranking inputs; no per-mode optimization claims.
- Postgres deployment path unexercised here (environment); physical schema unchanged.
- No UI, Stripe, or legal surface — deliberately out of R55 scope.
- Frontier offload metrics are measurable; distribution claims belong to R57+.

## Commits

- `da5afdb3` — R55 backend completion: rosters, Lead, user sources, paid families,
  accounting (44 files)
- This commit — R55 certification document, final report, matrix finalization
