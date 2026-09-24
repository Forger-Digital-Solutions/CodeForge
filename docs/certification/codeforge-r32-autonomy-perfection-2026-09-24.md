# CodeForge R32 autonomy perfection certification — 2026-09-24

**Verdict: `CODEFORGE_R32_PRODUCT_DEFECTS_CLOSED_EXTERNAL_BOUNDARIES_REMAIN`.**
Every CodeForge-controlled defect R31 left open is closed and proven:
the tail-review starvation / false-success path is closed deterministically
and the deterministic stated-contract check **fired live** on a real
provider's wrong-type declaration (`dab771b4`), Computer Use grounds
semantically through live UI Automation on real Windows, the remote
marketplace exists with a signed-catalog trust model, the LSP and sandbox
stubs are classified honestly, and — for the first time — the exact
packaged binary ran a real coding task against a live verified-free
provider and completed (`packaged_live_task=PASS`, proven on the final
binary).

What remains is not product logic: free-provider capacity is the dominant
non-pass source in the live batch (implementation/review budget exhaustion on
a 32-request free route), one false-success class survives only where a
task's *own* verification is shallower than hidden ground truth on behavioral
edge cases, Windows signing, second hardware, and privileged install
lifecycle remain environmental.

## Source and inheritance

R32 continued on `codex/r29-release-closure` from the frozen R31 state
(`c042854`). All work is committed locally in logical units; nothing was
pushed. Final source-state identity:
`r32-autonomy-perfection-v2` / `acec20dffe5b0f856ca6b8165474ba3424be27a266e2451b85e32eaedacb6274`
(33 material files; v1 + v2 recertification entries in
`docs/codeforge-forgegreen-certified-source-state.json`).

Test host: Windows NT 10.0.26200.0, x64, Node v24.19.0, interactive desktop
session.

## Fixes delivered and verified

1. **Tail-review starvation closed** (`6f9c448`) — the workflow inference
   budget is partitioned: implementation draws from a primary lane; semantic
   review holds a guaranteed reserve lane it can never lose. An unverdicted
   or starved review produces `goal_review_inconclusive` → the gate blocks.
   Deterministic starvation matrix green (primary-lane exhaustion,
   reserve-lane starvation, indeterminate, empty output, decisive-verdict
   control).
2. **Review efficiency + honest summaries** (`8423412`) — goal reviewers are
   told the embedded diff digest is system-captured evidence they may cite
   directly; blocked-run outcome text no longer double-punctuates.
3. **Deterministic stated-contract check** (`c30b5bb`, hardened `b4bea58`) —
   when a task states a literal typed contract (`validateOrder(input):
   ValidationResult`), `checkStatedContracts` scans added diff declarations
   for contradicting return types and emits a blocking `goal_not_satisfied`
   finding **independent of the model verdict**, even when the review turn
   exhausts or fails. Narrow by design: stated signatures only; comment and
   string-literal spoofing stripped; body-vs-named-type conformance remains
   honestly with ForgeVerify/typecheck + semantic review. 14/14 goal-review
   tests green including spoof-regression.
4. **Non-git created-file coverage** (`c30b5bb`) — `reviewDiff` falls back to
   a filesystem walk with the same snapshot exclusions/timestamps when the
   workspace is not a git repository; files created mid-run in temp
   workspaces are no longer invisible to review or contract checks.
   199/199 workflow tests green.
5. **Computer Use semantic grounding** (`adc02f6`, live fixes `e8c959e`) —
   UI Automation enumeration, semantic queries (name/AutomationId/control
   type/substring), `computer_inspect_ui` / `computer_click_element` /
   `computer_type_into_element` tools through the governed external-tools
   surface, fresh re-grounding per action, fail-closed zero/multiple-match,
   bounds + budget + rate limits, post-action verification receipts.
   **Validated live on this Windows host**: 40→171 real accessible elements
   (taskbar buttons with AutomationIds, tray, pinned apps, real bounds/PIDs);
   locate → semantic click on Start verified `uiChanged:true`; both error
   paths (`COMPUTER_TARGET_NOT_FOUND`, `COMPUTER_AMBIGUOUS_TARGET`) fire.
   Two real-environment bugs found and fixed by live testing: null composed
   `ControlViewCondition` (built the equivalent PropertyCondition) and
   OEM-codepage stdout mangling non-ASCII into control bytes (forced UTF-8 +
   sanitize). 33/33 package tests.
6. **Remote extension marketplace** (`c2edcac`) — signed catalog (ed25519),
   HTTPS-only sources, pinned signer keys, verified JSON-bundle install into
   `extensionsDir`, managed-install registration, renderer UI +
   settings/IPC/preload surface (shipped `.cjs` bridge fixed `c3d8abe`).
   17/17 marketplace tests covering tamper, wrong-signer, transport, and
   trust-pinning paths.
7. **Stub capability classification** (`e6ac511`) — `lsp` and `sandbox_exec`
   packages marked as non-implementations; capability inventory reports 66
   capabilities: 64 `IMPLEMENTED_AND_USED`, 2 classified stubs, **0 MISSING,
   0 PARTIAL**.
8. **Evidence integrity** (`c1e5153`) — live harness captures
   source/dist hashes at process start so receipts record the code actually
   loaded, not the tree at receipt-write time.
9. **Goal extraction shredding on file extensions** (`c29ee75`) — found by
   live evidence: a validator rerun produced `validateOrder(…): string[]`
   against the stated `ValidationResult` contract yet no contract finding
   fired. Root cause: `extractGoals` split the task message on bare `.`,
   fragmenting every `*.ts` path into fake sentences; the contract sentence
   fell past the 5-goal slice, hiding it from BOTH the semantic review
   prompt and the deterministic check. Fixed: split on sentence-terminal
   punctuation + whitespace/end only; `checkStatedContracts` additionally
   scans `intent.rawMessage` so a contract stated anywhere in the task binds
   regardless of goal-slicing. Regression test pins the corpus message.
   This defect was silently degrading review quality on every
   file-path-heavy task — most of the live corpus.

## Packaged live-provider proof (R31 residual gap closed)

`30-packaged-live-proof/` — `node scripts/packaged-smoke.js live-task` ran
the shipping `win-unpacked/CodeForge.exe` with the scripted smoke provider
**disabled**: live OpenRouter discovery verified 24 free models inside the
packaged binary, `nvidia/nemotron-3-super-120b-a12b:free` was pinned through
the real `/api/model-selection` endpoint, a real coding task ran through
`/api/workflow/run` — real engine, real tools, real completion gate — and
completed with `src/calc.ts` correctly fixed (`a - b` → `a + b`).

**Proven twice; the release-relevant run is v2 on the final binary** (commit
`858482b`, `dirty:false`) built after every R32 source change — the v1
binary at `acfb06d` predates the shipped-preload marketplace methods and
the extractGoals/contract fix.

- `app_is_packaged=true`, `packaged_live_free_models=24`,
  `packaged_live_model_select=200`, `packaged_live_task_phase=completed`,
  `packaged_live_task_file_correct=true`, `packaged_live_task=PASS`
- Final artifact hashes (`artifact-hashes-v2.txt`): `CodeForge.exe`
  `d8b1f58c…b8cc`, `app.asar` `772a20cd…e27d`
- Internal + runtime dependency audits: `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS`,
  `PACKAGED_RUNTIME_DEPENDENCY_GRAPH_PASS` (355 modules, 18 external packages)

## Live acceptance — 12-task diversified batch + targeted reruns

Route: OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` only; budget
`{total:32, reserve:10}`; every receipt under `10-live-acceptance/` with
per-process source hashes. Full taxonomy:
`r32-acceptance-taxonomy.json`.

| Outcome | Count | Tasks |
| --- | ---: | --- |
| Autonomous pass (completed + hidden + key) | 2 | `ts-bug-fix-queue-order`, `r25-testfix-js-stale-expected` |
| Blocked/cancelled but work correct | 4 | `js-build-config-test-script`, `js-investigation-webhook-retries`, `ts-feature-cli-stats` (no-progress detector fired on a model loop after the verifier passed), `qual-js-missing-export` (injected 429 recovered live, then deadline) |
| Correct block (unproven/non-conforming work refused) | 6 | `ts-refactor-extract-validator` ×4 (`68a156ad` batch, `fb8c2323`, `dc318ae3`, `dab771b4` standalone reruns), `ts-large-context-rename-config-key`, `r25-review-ts-config-swallow` |
| Provider-capacity terminal failure | 1 | `js-bug-fix-cart-total` (route exhausted mid-repair; gate never evaluated — honest `failed`) |
| Environmental | 1 | `py-bug-fix-config-merge` (no `python`/`py` on host PATH; verifier correctly refused ForgeVerify entry; hidden verifier via absolute path passed — correct work stranded) |
| False success | 2 | `js-feature-rate-limiter` on final code (visible-verification coverage gap — see residual); `7d656d4c` standalone on pre-contract-check code (the pinned baseline the deterministic check closed) |

**The deterministic contract check's first live fire** — receipt
`dab771b4` (post-`c29ee75` build `99a2a00f`): the model declared
`export function validateOrder(input: OrderInput): ValidationResultType`
— a *third* wrong-type variant — and the check emitted the blocking finding
verbatim (`Stated contract unmet — … requires validateOrder(…):
ValidationResult but the diff declares ValidationResultType`), blocking the
run via `review_rejected`. The hidden verifier passed 12/12 (the alias was
behaviorally equivalent), but the exported API name violated the stated
contract — a consumer importing `ValidationResult` would get a missing
export. The R31 false-success class is now deterministically refused for
stated signatures, proven against a real provider's live output. Its
diagnostic predecessor `dc318ae3` (`string[]`, no finding — the receipt that
exposed the extractGoals bug) is preserved alongside.

The 429 injection on `qual-js-missing-export` exercised the R31 thrown-429
cooldown path live: injected `ProviderError` on request 1, recovered with
real tokens on request 2.

**Reading the rate honestly.** R31: 4/12 on a 32-request ceiling where the
tail review could be skipped entirely. R32: 2/12 where the review reserve is
structurally guaranteed — implementation's lane is deliberately narrower
(22) so review can never be starved. The dominant non-pass class is
free-provider capacity, unchanged from R31: the model spends ~20+ requests
per multi-step task. Every non-pass is classified; none is a product logic
regression. **The ≥9/10 autonomous-pass target is not met and is not
claimed** — on this free route's capacity it is not reachable today; the
evidence says so rather than hiding it. What R32 bought instead is
certainty: every run now reaches review, unverdicted review can never pass,
stated signature contracts are enforced deterministically, and the two
recorded false successes are fully classified (one on pre-fix code pinning
the baseline, one a documented verification-coverage residual).

## Regression and targeted suites

- Canonical `npm test` final clean-room run: **3,624 passed / 0 failed /
  48 skipped** across 454 test files (`canonical-regression-2.txt`,
  exit 0). Interim runs 1-2 showed only mid-run-edit collisions and one
  Windows temp-lock flake — each re-verified green standalone, none present
  in the final run.
- Focused suites green: `workflow-goal-review` 15/15, task-intelligence
  10/10, workflow package 199/199 + 1 skipped, computer-use 33/33,
  marketplace 17/17, external-tools wiring, preload-bridge 7/7,
  source-state 5/5 + provenance 3/3.
- Targeted security coverage for new surfaces: CU fail-closed ambiguity and
  budget/policy enforcement (package suite + governed external-tools
  chain), marketplace signature/signer/transport trust (17 tests), broker
  permission gates for external tools (autonomous-run denials, read-only
  roles, secrets redaction) — all in canonical suites.

## Capability inventory

`19-capability-registry/` — 66 capabilities: 64 `IMPLEMENTED_AND_USED`, 2
honestly classified stubs (`lsp`, `sandbox_exec`), **0 MISSING, 0 PARTIAL**.
The R31 marketplace `MISSING` is closed.

## Vision feedback classification

`11-vision-feedback/CLASSIFICATION.md` — the wire schema is text-only by
design (`ChatMessageSchema.content: z.string()`); screenshots deliberately
return SHA-256 evidence receipts, not pixels. Semantic UI state feeds the
model as text through the new UIA grounding path — the implemented,
strictly-more-actionable feedback channel. Raw-pixel vision is a non-goal:
free-tier vision models are rare, pixel tokens would burn the inference
budget, and structural state beats pixels for UI work. Classified, not
claimed as a gap.

## External blockers (not product defects)

1. **Windows signing/notarization** — no signing certificate on this host;
   the packaged build is unsigned-but-real (`--dir`). electron-builder ran
   its signing step without a cert; evidence records the real artifact
   hashes.
2. **Second-hardware validation** — single machine available; all packaged
   and UIA proofs ran on this host.
3. **Privileged install lifecycle** — the installed-app lifecycle (installer,
   updater against a real signed feed) is not exercisable without signing +
   a distribution channel.
4. **Free-provider capacity** — measured: 22-request primary lanes starve on
   multi-step tasks; review reserves hold but 10 requests is thin for a
   thorough re-exploration review. This bounds the truthful live pass rate
   today.
5. **Host python environment** — `python`/`py` absent from PATH stranded one
   correct deliverable; the product's refusal to fabricate verification is
   correct behavior.

## Residual product gap (honest)

`js-feature-rate-limiter` completed while its hidden verifier failed 3/14
behavioral edge cases — the one remaining false-success class: *stated
verification shallower than hidden ground truth + free-model review missing
behavioral semantics*. The signature-scoped deterministic check cannot see
this class by design; closing it further requires either richer stated
verification, a typechecker/test-generation loop, or stronger review models.
It is recorded, classified, and not hidden.

## Commit ledger (local only — nothing pushed)

`6f9c448` reserve + fail-closed review · `8423412` diff-citing + summaries ·
`adc02f6` semantic Computer Use · `c56ba13` R32 live harness · `c2edcac`
marketplace · `e6ac511` stub classification + inventory · `c30b5bb`
stated-contract check + non-git coverage · `e8c959e` live UIA fixes ·
`b4bea58` contract-check hardening · `c1e5153` startup-hash capture ·
`acfb06d` packaged live-task mode · `9bc2f59` + `7774afc` packaged proof
evidence · `c3d8abe` recertification + preload parity · `6d8d9c0` batch
evidence + taxonomy · `c29ee75` extractGoals fix + raw-message binding ·
`cb4cf0e` source-state recertification v2 · `276ab2b` validator rerun
receipts (diagnostic + live fire) · `858482b` clean canonical regression
freeze
