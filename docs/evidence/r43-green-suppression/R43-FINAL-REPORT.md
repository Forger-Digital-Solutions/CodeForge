CODEFORGE R43 FINAL

# Verdict

**R43 PARTIALLY VERIFIED**

The machinery is proven where it could be proven deterministically, and two real
production defects were found and fixed. The headline claim — live duplicate
suppression on real tasks — could not be shown: across ~40 arm-runs on live free
supply, zero duplicate replays fired because the suppression predicate never
arose in a FULL-policy run. That is an honest negative, not a pass.

# Starting point

- Branch `codex/r29-release-closure` at `b3021b9` (R42 close).
- R42 verdict PARTIALLY VERIFIED; open items: ForgeGreen suppression never
  exercised in vivo; coordinated multi-file work the weakest surface.
- Worktree carried two user-preserved benchmark scripts (untouched throughout)
  and one tooling-regenerated R34 artifact (restored byte-exact after each
  test-induced timestamp drift).
- R42 source-state certified (`01929018…`), re-issued during R43 as
  `09afc53f…` under surface `r43-green-suppression-v1` with an explicit
  reconciliation entry.

# What changed

1. **Suppression state evidence** (`58517b5`): the duplicate supervisor now
   revalidates a recorded evidence signature (file stat signature for path
   reads; repository-intelligence generation/pending-external-mutation evidence
   for index reads) before replaying. External edits that the supervisor never
   observed now deny the replay instead of serving stale bytes; denials emit
   telemetry (`suppressionEvidenceInvalidations` on the sustainability receipt).
2. **Receipt suite-version compatibility** (`a061b83`): a qualification receipt
   written by an incompatible suite version reads as absent at the fabric layer
   and STALE at the registry — same invalidation semantics as age, reopening
   bounded requalification rather than lending trust or quarantining forever.
3. **Compression failure-line detection** (`766d982`): the FG-1B failure pattern
   was anchored on `\b`, which silently missed `✗`/`×`/`✕` after whitespace and
   `AssertionError` (no boundary inside the identifier) — vitest/tap failure
   lines could be omitted from compressed output. Pattern widened; regression
   test added.
4. **Reviewer context** (`c5e6a5c`): the orchestrator sliced the entire diff to
   2,000 chars before handing it to the reviewer and relayed the same truncated
   diff into the reviewer's `verificationEvidence` — the model reviewer was
   asked to approve multi-file changes it could not see, under a section
   labeled as verification results that had never run. The reviewer now
   receives the full `--stat` inventory plus a 24KB-bounded diff body with an
   explicit truncation marker; the verification-evidence field is no longer
   populated with diff text.
5. **Harnesses**: `r43-suppression-ab.mjs` (13-task paired A/B corpus),
   `r43-qualification-sim.mjs` (6-scenario lifecycle sim, 34/34 checks),
   `r43-compression-proof.mjs` (15/15 checks), `r43-free-supply.mjs` (5/5).

# Live ForgeGreen suppression

Corpus: 6 suppression-oriented tasks + 7 multi-file tasks, paired
baseline/green arms, live providers (openrouter, groq, mistral; 64
verified-free routes). Three passes total as supply windows opened and closed.

- **Duplicate replays (suppressions): 0 across all arms.**
- Suppression denials from evidence invalidation: 0 (no replay was ever
  attempted that needed denying).
- Prevented completed-response replays via the dedupe epoch: 1 in persisted
  artifacts (wide-explore run 2); 2 additional observed in run 1 console output
  on big-data-edit before that artifact was overwritten by re-run — the epoch
  mechanism demonstrably fires live.
- Policy escalations observed live: 24 (`FULL→CONSERVATIVE` ×10,
  `CONSERVATIVE→OFF` ×12, `FULL→OFF` ×1); distribution otherwise
  `FULL→FULL` ×29, `CONSERVATIVE→CONSERVATIVE` ×51.

Why zero suppressions is the honest reading: replay requires a FULL-policy run
(explorer/planner on fresh evidence — coders and repair contexts resolve
CONSERVATIVE by design) to emit an *identical* read-only call against unchanged
state AND unchanged filesystem/index evidence. Free models issue per-file reads,
not identical repeats; explorer arms either starved in dead provider windows or
completed without repeats. The predicate is narrow by design — it would be
wrong to loosen it to manufacture benchmark activity. The production branch
itself is proven to fire correctly by deterministic runtime tests (16/16),
including the external-mutation denial that motivated the evidence channel.

# Suppression safety

Deterministic, 16/16 (`r43-dedup-safety`, `r43-suppression-evidence`):
state-version invalidation on observed mutation; external-mutation denial via
stat evidence; index-generation evidence for repo reads; identical repeat after
mutation re-executes; thrown model calls never cached; cross-route replay
impossible (providerId+modelId inside request identity); escalation epoch
invalidates cached responses (2 prevented replays also observed live); mutating
tools never suppress; repeated suppression/failure escalates and fails closed.

# Tool compression

`R43-TOOL-COMPRESSION.json` — 15/15 deterministic checks on the production
function: vitest log 200KB-class → bounded representation with the failure
neighborhood verbatim, npm ERESOLVE output retains error lines through
global-repeat folding, pure determinism, sub-threshold passthrough, explicit
omission markers, artifact reference + sha256 digest for authoritative
retrieval, hard byte bound. Plus the R43 finding/fix for missed failure formats.

# Superseded compaction

Measured in the same proof artifact: superseded identical-args reads and
mutation-invalidated reads are removed from the *dispatch copy* (the durable
transcript is untouched — the function returns a new array, original verified
byte-identical), idempotent on re-pass, and identity-preserving when nothing is
stale. R34's existing context-efficiency benchmark (re-run clean) shows ~5.9%
serialized-input savings on the interactive arm; role-run transcripts already
invalidate stale reads durably, so compaction's marginal value there is small
but non-regressing.

# Multi-file reliability

Seven paired Mission-C tasks plus R42's weakest cases, across three supply
windows. Outcomes: 2 completions (both green arm: `coordinated-api` in corpus
run 1, `meta-update` spot check), everything else blocked — predominantly by
provider saturation (zero-call fail-closed blocks), structured-output
nonconformance, and first-attempt `edit_file` failures. Green never degraded a
task relative to baseline (worst case BOTH_FAIL; one BASELINE_FAIL_GREEN_PASS).
Root-cause analysis in `R43-MULTIFILE-ROOT-CAUSE.md`: the reviewer-context
truncation (fixed), malformed structured output as the dominant turn failure,
edit-hash recovery re-reads, explorer turn-budget exhaustion on wide
workspaces, and supply churn. Post-fix live revalidation attempted; the supply
window was closed (0-call blocks) — the fix is covered by orchestrator tests
(16/16) and is a strict context improvement, but has no live outcome delta yet.

# Qualification expiry

`R43-QUALIFICATION-EXPIRY.json` — 34/34 deterministic checks over the real
decide() path: evidence expires at the 30d boundary *between two live
decisions* (mid-run, not between runs); expired HARD_FAILURE reverts to legacy
eligibility — no permanent quarantine; expired evidence contributes zero
ranking score and flags `ROLE_EVIDENCE_STALE`/`needsRequalification`; expired
TOOL_AGENT verdicts stop feeding EXPLORER inheritance; role verdict swaps land
on the very next decide; health and qualification stay orthogonal (a parked
QUALIFIED route is skipped without ever selecting a HARD_FAILURE route, and
re-enters on probe recovery).

# Requalification

Stale routes revert to `STALE` in the registry and re-enter
`pendingQualification()` under the existing bounded cycle (per-provider daily
budget + cycle interval + concurrent-call suppression — unchanged semantics,
verified by the pre-existing 77/77 registry tests). A fresh receipt restores
QUALIFIED verdicts and ordering trust on the next decide. Suite-version
incompatibility is now the same invalidation as age: `RECEIPT_SUITE_UNSUPPORTED`
flags requalification; an unsupported "QUALIFIED" lends zero ordering trust
until requalified under the current suite.

# Role routing

Unchanged semantics, re-proven: quality/capacity interaction, qualified-over-
probation preference, capacity-driven redistribution, qualification-vs-health
separation (sim + 44/44 role-routing tests). Role isolation: swapping one
role's verdict mid-run changes only that role's admission on the next decide.

# Endurance

R42 endurance harness revalidated on R43 code: 120 epochs of churn, park/probe/
re-entry, quota pressure — 4/4 checks, zero starvation, zero leaks
(`R43-ENDURANCE.json`). Live endurance beyond the corpus windows was not
repeated — supply windows this session were too short to sustain one.

# Scale

R42 373-user / 746-task scale harness revalidated on R43 code: 6/6 checks, zero
starvation, zero false waits, zero leaked reservations (`R43-SCALE.json`).
Additionally `driftscale` in the R43 sim ran 373 users with receipts expiring,
hard-failing, and requalifying mid-run — 4/4 evidence mutations landed, zero
role-ineligible selections, zero starvation, zero false waits, zero leaks.

# Free-only guarantee

`R43-FREE-SUPPLY.json` — live catalog refresh: 64 verified-free routes across
openrouter (21), groq (6), mistral (37); zero enumeration errors; every route
billing-proof (`paidFallbackPossible:false` + `paidFallbackDisabled:true`);
Gemini/consumer-suspended supply absent from candidacy; no paid or BYOK route
entered any corpus arm (285 calls, all free routes). 16-Bit / GEMS / Paid Auto
semantics untouched.

# Canonical regression

`npm test`: **3,861 pass / 2 fail / 48 skip** in 495.4s (480 files). Both
failures are the source-state certification tests — expected drift from R43's
legitimate `autonomous-orchestrator.ts` change; recertified and re-run green
(8/8). Effective: **3,863 pass / 0 fail / 48 skip** vs R42's 3,846/0/48 — every
changed count accounted (see `R43-REGRESSION.md`). `tsc -b` clean.

# Remaining risks

- **Live suppression is unproven in vivo.** The mechanism is verified
  deterministically and the epoch/prevention path fired live, but no duplicate
  replay has been observed on a real task. The honest read: on current
  free-model behavior the predicate is rare; whether it saves real quota at
  production scale is still open.
- **Supply fragility dominated the corpus.** Multiple arms died on
  `PROVIDER_MODEL_UNAVAILABLE` inside 429 windows — correct fail-closed
  behavior, but it means free-tier task success is presently supply-bound more
  than mechanism-bound.
- **Reviewer-context fix lacks a live outcome delta** — the post-fix re-run hit
  a dead window; deterministic coverage is green but live multi-file uplift is
  unmeasured.
- **`AGENT_INVALID_STRUCTURED_OUTPUT` is the top live failure mode** — free
  models emitting fenced prose instead of schema-exact output burns turns;
  deterministic, worth a dedicated repair/retry pass in a later round.

# Commits

- `58517b5` suppression state-evidence guard + runtime wiring + tests
- `a061b83` receipt suite-version compatibility + R43 qualification sim
- `766d982` compression failure-line detection fix + proof harness
- `c5e6a5c` reviewer full-diff context + verification-evidence mislabel fix
- `87815eb` R43 paired A/B corpus harness
- `b04ab4b` free-supply + endurance/scale revalidation evidence
- `4b7374b` suppression-safety evidence artifact
- `24ad011` live corpus artifacts, root-cause, regression record

# R44 recommendation

1. **Seed the suppression surface honestly**: ship a small library of canonical
   read-oriented tasks (docs sweeps, symbol inventories, multi-directory audits)
   where identical reads are *natural*, and measure suppression rate on the
   strongest available free routes — do not widen the predicate.
2. **Structured-output repair**: a bounded "extract first fenced JSON block →
   validate → retry once" pass on `AGENT_INVALID_STRUCTURED_OUTPUT` would remove
   the single largest live failure class observed.
3. **Live revalidation of the reviewer-context fix** on a healthy supply window,
   paired against this round's multifile numbers.
4. **Schedule corpus runs around quota windows** — per-provider RPM probes
   before each arm, recording the supply state the arm ran under, so dead-window
   blocks are distinguishable from mechanism failure at a glance.
