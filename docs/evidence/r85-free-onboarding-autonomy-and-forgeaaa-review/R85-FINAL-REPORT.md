# CODEFORGE R85 FINAL REPORT

**Classification: `CODEFORGE_R85_PARTIAL`** — verified engineering progress; three external dependencies block VERIFIED.

- Branch: `codex/r85-free-onboarding-autonomy-and-forgeaaa-review`
- Baseline: published R84 `41f7a1622256067c386118e45a433c2159987aa2` (clean recovery, isolated worktree)
- Date: 2026-10-11. Node v24.19.0, Windows, UE 4.27.2, Blender 4.5.
- Evidence directory: `docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review/`

## Gate results

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | R84 baseline recovered & protected | PASS | `R85-BASELINE.md`; published R84 untouched; owner checkout untouched |
| 2 | Build / lint / security gate | PASS | `build-release.log`, `lint-release.log` (0/1514), security-r1 artifacts re-verified post-change |
| 3 | Independent review (R82/R83 resolution) | **PASS** | `r85-review-2ad03a7a-*.json`: schema-valid `pass`, `independent:true`, in-deadline, bounded packet (16,796 chars). First review `revision_required` → requirement wording clarified to match milestone intent → re-dispatched → pass + 3 advisories. Reviewer: nemotron-ultra, internal-public-source-evaluation classification |
| 4 | Free-supply reassessment | PARTIAL | `R85-SUPPLY-AUDIT.md`; laguna-s newly QUALIFIED CODER+PLANNER (CLEARED terms); **REVIEWER gap proven**: 5 CLEARED candidates hard-failed/quota-exhausted, only qualified reviewer is dev-only NVIDIA trial correctly excluded |
| 5 | Zero-setup onboarding | PARTIAL | `R85-ONBOARDING.md`; 57/57 tests; live GitHub OAuth not executable locally (needs deployed Cloud + real OAuth credentials) |
| 6 | Multi-account separation | PASS | `account-separation-tests.json`: 89/89 |
| 7 | Two-project concurrent execution | PARTIAL | `R85-CONCURRENCY.md`; real concurrent progress proven (isolated workspaces, per-run ledgers, interleaved frames); completion blocked by shared-domain saturation (upstream 429) + reviewer wall |
| 8 | Autonomous coding reliability | BLOCKED-EXTERNAL | campaign receipts: implementation pipeline progresses on qualified CLEARED routes; **every run blocks at REVIEWER_FAILED** — no production-eligible reviewer route exists; fail-closed, no paid fallback |
| 9 | ForgeAAA + native Unreal | PASS | `R85-NATIVE.md`; migration-fault 9/9, persistence-upgrade 3/3 incl. fresh-process SaveGame restoration; original pilot byte-identical |
| 10 | Recovery / redaction / adversarial | PASS | `recovery-redaction-tests.json`: 81/81 |
| 11 | Full regression suite | PASS | `full-suite.json`: 5197/2 → effective 5199/0 (certificate ENOENT fixed by committing the R84 evidence logs; EBUSY flake passed re-run) |
| 12 | Source certification | PASS | `FREE_CAPACITY_CERTIFICATE_VALID` — R84 publication defect (37 uncommitted `.log` evidence files referenced by certificate) repaired: files restored hash-exact and committed |

## What R85 genuinely closed

- **Completed independent review exists** — R82's timeout and R83's `revision_required` are resolved: a qualified independent reviewer issued `pass` on the R85 engineering packet with only advisories.
- **Root cause of the autonomous-completion wall identified**: R84's own NVIDIA DEVELOPMENT_ONLY terms gate correctly removed the only qualified REVIEWER route. Implementation proceeds; review fails closed. Documented, not masked.
- **New production-eligible qualifications**: `poolside/laguna-s-2.1` (Kilo, CLEARED) QUALIFIED CODER + PLANNER; `poolside/laguna-xs-2.1` (BlockRun) compact CODER — second-domain coder exists intermittently.
- **Native UE regression fully green** on the isolated pilot with source preservation.
- **Certificate/publication integrity**: clean-checkout certificate verification now passes.

## What still blocks VERIFIED

1. **No production-eligible qualified REVIEWER route.** Five CLEARED attempts (laguna-s, dots-3, liquid-2.6b, inkling-small, blockrun laguna-xs) hard-failed or were quota/substitution-blocked. Without it, autonomous runs cannot reach `completed`. This is external supply, not a code defect — the orchestrator correctly fails closed.
2. **No second independent quota domain.** BlockRun rotates/substitutes; AI Horde compact-unqualified; all viable roles map to `kilo:source-ip`, which saturated at upstream 429 under two concurrent projects.
3. **No live GitHub-authenticated install→task flow.** Requires deployed `apps/cloud-api` + configured OAuth app + real account sign-in. Contract/unit coverage is complete; the live hop is unproven.
4. Director remains `FORGEAAA_PARTIAL` by honest status.

## Supply economics observed this session

~110 anonymous free inference requests across kilo/blockrun/ai-horde; zero credentials; zero paid calls (per-run ledgers + admission failures all report "No paid or unknown-cost route was used"). Kilo per-model upstream limits hit (`limit_rpd`) — shared source-IP domain reality.

## Files changed in R85

- Added: `benchmarks/r85/` (8 scripts + 3 native), `docs/evidence/r85-*/` receipts/docs, 37 hash-verified R84 `.log` evidence files completing the published certificate.
- Modified: `benchmarks/r85/native/persistence-upgrade-live.mjs` (door-centerline waypoint), `concurrent-projects.mjs` (argv fix + receipt merge), `qualify-route.mjs` (role scope), `prepare-current-review.mjs` (R85 scope).
- **No changes to `packages/` or `apps/` source.** All R85 work is benchmark harnesses + evidence — the runtime was not weakened anywhere.
