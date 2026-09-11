# ForgeGreen FG-12D Controlled Verification Reuse Trial Report

Generated: 2026-09-11T18:54:23.734Z

- FG12D_TRIAL_SOURCE_STATE: `ac8414ebd2a85803bde97d35a5409ca1be7a5d156ae3be57a070ebb5ba72ad53`
- campaignHarnessId: `295f1bb1b3887e508d22364dd1e54a66bd06d0d29d102b0c71efbf1b3f17f939`
- Verdict: **CODEFORGE_FORGEGREEN_FG12D_CONTROLLED_TRIAL_CERTIFIED_NOT_ACTIVATED**
- Safety bar clear: true
- Global `VERIFICATION_EVIDENCE_REUSE` graduation registry entry: unchanged (still `SHADOW`)
- Production call sites modified: none ([])

## Case corpus

- Total paired control/treatment cases: 44
- Positive (identical-state reuse): 20
- Invalidation: 24
- Passed: 44 / Failed: 0
- Unsafe reuse cases: 0

### Invalidation category distribution

- source_changed: 4
- dependency_changed: 4
- config_changed: 4
- stale_evidence: 2
- command_changed: 4
- new_obligation_added: 4
- prior_failed_evidence: 2

Categories proven at the unit level instead of via a live paired run (identical underlying code
path — see `packages/workflow/test/fg12d-verification-evidence-reuse.test.ts`):
`workspace_path_mismatch`, `input_state_hash_mismatch` (as a pure evidence-shape property),
`incomplete_evidence_metadata`, `corrupted_evidence_reference`.

## Special-case proofs

- **restart-valid** (restart): PASSED
- **restart-stale-refused** (restart): PASSED
- **race-toctou** (race): PASSED
- **fallback-advisor-throws** (fallback): PASSED
- **repeated-reuse-duplicate-accounting** (repeated): PASSED

## Performance

- Actual verification attempts avoided (real, measured reuse events): 24
- Total control duration (reference): 17110ms
- Total treatment duration: 22040ms
- Net wall-clock delta (control - treatment, reference only — REFERENCE_CONTROL_DURATION, not a per-case DIRECTLY_AVOIDED_DURATION claim beyond what each receipt's `actual.directlyAvoidedDurationMs` records): -4930ms

## Energy/Carbon

`INSUFFICIENT_DATA` — no new hardware telemetry was introduced by this trial.
