# R56 final report — golden backend freeze

Verdict inputs and evidence for `r56-golden-backend-freeze-v1`.

R56's thesis under test: the R55 architecture is a real product under real conditions —
live provider execution, live failover, live USER_API dispatch, live paid accounting,
packaged Windows operation, durable persistence across process boundaries, honest failure
when the environment refuses — with ForgeVerify remaining the only completion authority.
Nothing in this report converts a blocked or unverified run into success.

## Repository

- Branch: `codex/r29-release-closure`
- Predecessor certification: `r55-backend-completion-v1`
  (`5478003269dd076f7cfe92ac4e85f87097b63b4f7b24b7b316386d7fd871a727`, HEAD `fa186f85`)
- Final certification: `r56-golden-backend-freeze-v1`
  (`934a07bc2c0bcd506d8307817be5daf23185afcbb679e5896ba5493b06b41b9e`;
  the material surface grows 54 → 60 files — the scoped-failure health, capacity-governor,
  and run-failure modules are authority code changed under live conditions)
- Working tree at certification: clean except the preserved unrelated R34 benchmark
  artifact (`docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`,
  deliberately uncommitted — regenerated numbers from a pre-existing R34 run)

## What R56 changed in authority code

Two defects were found under live conditions and fixed; both are fail-closed direction
(neither loosens admission, retry, or completion):

1. **Model-scoped failure marking** (eight-bit `health.ts`/`failover.ts`/`types.ts`,
   providers `capacity-governor.ts`/`index.ts`). A Groq per-model TPD wall on
   `openai/gpt-oss-120b` was being recorded provider-wide, cooling the healthy sibling
   `openai/gpt-oss-20b`. Route-health records now carry `scope: "model" | "provider"`,
   the governor accepts `modelId` on acquire/rate-limit paths, and `classifyProviderFailure`
   scope flows into the persisted mark. Account/provider-scoped reasons (auth failure,
   account quota, provider outage) keep their wide marking. Regression:
   `packages/eight-bit/test/r56-model-scoped-health.test.ts` (8 tests).

2. **Structured provider error codes survive normalization** (server
   `model-execution-adapter.ts`, `run-failure.ts`). `normalizeProviderError` re-classified
   by message text and discarded the adapter's typed `code`; Groq's in-band
   `output_parse_failed` (`INVALID_TOOL_OUTPUT`, retryable — a resample is the designed
   recovery) surfaced as `PROVIDER_UNAVAILABLE` → `provider_outage` in telemetry and the
   run-failure record. The normalizer now honors a structured `.code`/leading `[CODE]`
   envelope when the token is in the provider-wire vocabulary (mapped to runtime codes)
   or is already a normalized `ERROR_CODES` value; generic and unknown codes still fall
   through to text classification. `run-failure.ts` maps the newly-preserved envelopes
   honestly (`INVALID_TOOL_OUTPUT` → `invalid_model_output`, `PAYMENT_REQUIRED` →
   `paid_plan_required`) instead of the generic policy fallback. Regression:
   `agent-provider-contract.test.ts`, `run-failure.test.ts`.

## Live evidence summary

| Proof | Artifact | Verdict |
|---|---|---|
| Managed-free supply inventory | `live-supply-inventory.json` | Groq `gpt-oss-120b` QUALIFIED for CODER via real inference; Cloudflare fails closed on usage-scope (fail-closed accounting working); Z.AI uncredentialed → not claimed |
| Autonomous roster task | `roster-live-run-nemotron-or.json` (COMPLETED) + `roster-live-run*.json` attempt trail | See matrix rows 3 and 12 — real calls across two providers, real failover chain, gate-authorized completion |
| USER_API live | `user-api-live.json` | ALL_CHECKS_PASS — real HTTPS dispatch to a configured OpenAI-compatible endpoint, authenticated `/models` (126 models), inference rejected 429 quota → surfaced as provider rejection, **no managed-free fallback** |
| Managed-paid live | `paid-live-probe.json` | Real OpenRouter call through the budget-gated 16-Bit ledger: reservation → dispatch → served-model identity check → ACTUAL reconciliation → durable receipt |
| Packaged Windows | `apps/desktop` smoke logs + `packaged-live-task.log` | `npm run pack` + both dependency audits PASS; full/interrupt/recover smoke PASS on the packaged artifact; **live-task PASS** — the shipping binary discovered 20 verified-free OpenRouter routes live, locked `nvidia/nemotron-3-super-120b-a12b:free` through the real control plane, ran the coding workflow to `completed`, and the fixture file holds the correct fix; `NotSigned` — no code-signing certificate exists in this environment (external boundary) |
| Restart durability | `r56-reopen-live-db.mjs` output | Second-process reopen of a live-run db: route-health marks (with `scope`), decision receipts, Shilling entries, worker journals intact; no secrets in store |
| ForgeVerify adversarial | corpus re-run | 83/83 pass, `FALSE_COMPLETION_COUNT = 0` |
| Security | `docs/evidence/security-r1/*` | Secret scan PASS (1,794 files, 0 owner-review-required), dependency audit PASS (674 deps, 0 blocking), public-claims PASS, doc-links PASS; `security:tests` 136/136 |
| Accounting trace | `accounting-trace.md` | Three source classes separated under real execution |

## The autonomous live task — what the evidence shows

Fixture: a temp repo with two failing tests (`multiply` in `src/math.mjs`,
public output format in `src/format.mjs`), verification via
`node --test test/math.test.mjs test/format.test.mjs`, roster = pinned CODER route +
managed-free AUTO for other roles, no paid routes, no Lead. File-backed SQLite
persistence; harness: `scripts/r56-roster-live-run.mjs`.

Attempts (all real calls, all outcomes honest):

- **Cancelled at the 420 s harness timeout** — real work in flight (`cancelled-420s`).
- **Provider-wide cooldown poisoning** — the 120b TPD wall cooled 20b too; the defect
  that produced fix #1 (`blocked-provider-poisoned`, `blocked-tpd`).
- **Pin excluded by a live mark** — pinned route still inside a provider-declared
  cooldown at selection; failed closed (`blocked-pin-cold-mark`, `blocked-pin-daily-mark`).
- **Fabric admission tightened** — `freeCloud` wiring demands live catalog listing +
  qualification evidence (`blocked-fabric`); resolved via live refresh/qualification.
- **Model-quality wall** — 20b emitted malformed tool calls (`output_parse_failed`,
  HTTP 200, Groq server-side rejection) 3× consecutively; bounded same-route resample
  fired twice then escalated; rotation found no other admitted route →
  `NO_ELIGIBLE_ROUTE`/`invalid_model_output`. The defect that produced fix #2
  (`blocked-noprogress-20b`).
- **Watchdog budget ceiling on a slow free lane** — `qwen/qwen3.8-27b` on Groq served
  10 real coder requests (~43K tokens, real tool calls, zero provider failures) paced
  ~1/70 s by the free TPM window, with three honest `BOUNDED_SAME_ROUTE_RETRY` waits;
  the run hit the product's 600 s + 2×120 s watchdog ceiling
  (`watchdog_budget_ceiling`) mid-build → `blocked`, nothing claimed
  (`roster-live-run-qwen.json`).
- **Cross-provider pin resolution + upstream 429** — the CODER pin resolved to
  `openrouter/qwen/qwen3.8-27b:free`; OpenRouter's upstream returned a real 429 on the
  first call → surfaced as `PROVIDER_RATE_LIMITED`, honest block
  (`roster-live-run-qwen-or.json`). Also proved the roster resolves pinned routes
  across providers, and Groq 20b hit its TPD ceiling the same minute
  (198,955/200,000) — the explorer failed with the same honest code.
- **COMPLETED — `openrouter/nvidia/nemotron-3-super-120b-a12b:free`**
  (`roster-live-run-nemotron-or.json`): CODER pinned to the OpenRouter free lane,
  EXPLORER pinned to groq 20b. The explorer failed on 20b's exhausted TPD; the coder
  proceeded on the deterministic capsule evidence, explored the repo itself, and
  wrote both fixes across 13 real requests (~66K tokens) with three bounded
  same-route cooldown waits on OpenRouter's free window. The reviewer's AUTO slot
  then produced a live **three-hop cross-provider failover chain**
  (`groq/120b` RATE_LIMITED → `groq/qwen3.8-27b` RATE_LIMITED →
  `openrouter/nemotron-3-super-120b` served; 7 requests, ~24K tokens). ForgeVerify
  actually executed `node --test test/math.test.mjs test/format.test.mjs` → exit 0,
  2 pass; the harness's independent probe re-ran the tests and passed; the
  completion gate authorized `completed` ("All required completion checks passed");
  the work integrated (`src/math.mjs`, `src/format.mjs`, plus a model-authored
  `VERIFICATION_SUMMARY.md` — permitted by the task constraints).

## Requirement matrix

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | R55 architecture preserved (no redesign, no reopened decisions) | PROVEN | Recertify guard: material drift = reviewed R56 change set only; predecessor identity checked before certifying |
| 2 | Live managed-free execution | PROVEN_LIVE | `roster-live-run*.json` — real Groq + OpenRouter `:free` calls, real token usage, real decision receipts, live-verified $0 price cards |
| 3 | Live failover and recovery | PROVEN_LIVE | `router.failover` receipts: 120b→20b RATE_LIMITED and a three-hop reviewer chain 120b→qwen→nemotron crossing providers; scoped mark persisted; sibling served; bounded resample on INVALID_TOOL_OUTPUT then honest escalation |
| 4 | Live USER_API (incl. honest failure classification) | PROVEN_LIVE | `user-api-live.json` — ALL_CHECKS_PASS incl. real 429 surfaced as provider rejection, zero managed-free fallback |
| 5 | Managed-paid via exact route + budget controls | PROVEN_LIVE | `paid-live-probe.json` — reserve→dispatch→ACTUAL reconcile→durable receipt; campaign gate honored |
| 6 | Packaged Windows desktop runtime | PROVEN_LIVE | `pack` + dependency audits PASS; full/interrupt/recover smoke PASS on the packaged exe; `live-task` smoke PASS — a real coding task completed inside the shipping binary on a live managed-free route (`packaged-live-task.log`) |
| 7 | Packaged process interruption + recovery | PROVEN_LIVE | interrupt smoke exit 73, recover smoke `PACKAGED_RECOVERY_SMOKE_OK`; no approval replay; fresh task blocked not completed |
| 8 | User isolation | PROVEN | USER_API live isolation + reopen verifier `ownerIsolation=true`; multi-user suites green |
| 9 | Accounting across free/paid/user-owned | PROVEN | `accounting-trace.md` — three domains separated; UNKNOWN confidence never coerced; null spend never fabricated |
| 10 | Security + typecheck + build + ForgeVerify + focused tests | PROVEN | security:gate all-PASS, 136/136 security tests, ForgeVerify 83/83 FALSE_COMPLETION_COUNT=0, touched suites green (25/25 normalize+failure, 8/8 scoped-health, 58/58 touched-server) — broad server suite is wall-clock-bound on this host; see limitations |
| 11 | Evidence matrix/report + guarded recertification | PROVEN | this report; `benchmarks/r56/recertify-source-state.mjs` refuses on drift |
| 12 | Autonomous task completed end-to-end live | PROVEN_LIVE | `roster-live-run-nemotron-or.json` — gate-authorized `completed` on managed-free capacity: real file changes, ForgeVerify `node --test` exit 0 (2 pass), independent re-verification pass, work integrated; coder+reviewer served by `openrouter/nvidia/nemotron-3-super-120b-a12b:free` |

## What the blocked outcomes prove

Proven live across the attempt trail, independent of the completion: real dispatch to
two providers; real failover receipts (120b 429 → 20b `CROSS_MODEL_REPLACEMENT`, and a
three-hop reviewer chain 120b → qwen → nemotron crossing Groq → OpenRouter);
model-scoped marking with the sibling staying HEALTHY through a durable mark; bounded
resample policy firing on `INVALID_TOOL_OUTPUT`; bounded same-route cooldown waits on
real free-capacity windows; the watchdog budget ceiling terminating a slow-but-live
coder honestly (`watchdog_budget_ceiling`); decision receipts + Shilling entries +
worker journals persisted and re-readable in a second process; no paid or
unknown-cost route ever substituted; ForgeVerify never ran for a run that verified
nothing — every unverified attempt ended `blocked`.

The completed run is evidence that the machinery finishes when a managed-free lane
has real capacity; the blocked trail is evidence that the same machinery refuses —
honestly, durably, and with correct failure attribution — when it does not. Both
classes of outcome were produced by the product, not staged.

## Credential handling

Seven provider credentials existed in the environment; none were logged, persisted, or
embedded in evidence. USER_API credential refs are SHA-256-derived; the reopen verifier
asserts the store contains no secret material. `secretsInStore=false` on every run db.
The completed run used two operator credentials (`GROQ_API_KEY`,
`OPENROUTER_API_KEY` resolved by `EnvironmentCredentialStore` at request time);
its artifact's `providerCredentialsUsed` field predates the OpenRouter lane wiring and
lists only the Groq key — corrected in `scripts/r56-roster-live-run.mjs` for future
artifacts. The artifact's own routing events and decision receipts unambiguously record
the OpenRouter usage; nothing was back-edited.

## Limitations recorded honestly

- `NotSigned` packaged executable — zero code-signing certificates exist in this
  environment (`CSC_*` unset, both cert stores empty). External boundary, not a defect.
- Broad `packages/server` vitest run on this host is not a credible gate: git spawn
  latency measured at ~3.9 s for a bare `init+add+commit`, so suites whose
  `beforeEach` performs 7 git spawns exhaust the 10 s hook budget before the test
  body starts, and teardown races produce `statement has been finalized` noise on
  fire-and-forget event writes. Representative standalone reruns:
  `checkpoint.test.ts` (pure git, zero overlap with the R56 change set) fails on
  5 s timeouts + Windows EBUSY tempdir locks; `r44-edit-discipline.test.ts` passes
  6/6 standalone; `r21-adaptive-topology-wiring.test.ts` fails on setup+worktree
  spawn cost. Same environmental class as the CF14 flake documented at R55 —
  classified, not attributed to the change set, which adds no process spawns.
- USER_API live endpoint authenticated but held zero credits — inference proof is the
  honest negative (boundary + isolation proven; successful inference not claimed).
- Groq free tier is tight (8K TPM/model-minute, model-specific TPD) — both Groq coder
  lanes hit real walls (120b TPD, 20b `output_parse_failed` then TPD, qwen pacing vs
  the 840 s watchdog ceiling). The end-to-end completion was proven on a second
  managed-free provider (`openrouter ...:free`, live-verified $0 price cards), which
  is the intended product behavior: the roster is interchangeable infrastructure and
  the owner-authorized AUTO pool crossed providers to find capacity.

## Regeneration

- `scripts/r56-user-api-live.mjs` — USER_API live proof (endpoint policy, isolation,
  persistence, real dispatch)
- `scripts/r56-roster-live-run.mjs` — autonomous roster task with durable evidence
- `scripts/r56-reopen-live-db.mjs` — second-process durability verification
- `benchmarks/r56/recertify-source-state.mjs` — guarded source-state recertification
