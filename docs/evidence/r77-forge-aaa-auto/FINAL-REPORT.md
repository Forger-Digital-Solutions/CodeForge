# ForgeAAA Auto — R77 Implementation Report

Final status: **FORGEAAA_PARTIAL** — see gate table below. Gates 1–7 passed for the
implemented slice. Gate 8 (release readiness) is intentionally not claimed: the feature is
merged-candidate quality on this branch, but it has not been exercised against live remote
providers and the desktop flow has not been smoke-tested end-to-end against a running server.

## Baseline

- Base SHA: `f8cd589f` (latest valid development baseline at audit time)
- Branch / worktree: `codex/r77-forge-aaa-auto` @ `G:\CodeForge\worktrees\forge-aaa-auto`
- Main checkout `codex/r29-release-closure` left untouched; unrelated modified files there
  preserved (packaged-endurance script, r34/r57/r60 evidence files).

## What was built

`packages/forge-aaa/` — a new orchestration package layered on CodeForge, not a parallel app:

- `types.ts` — contracts: domains (`managed_free`, `managed_paid`, `user_api`,
  `local_tool`, `external_service`), terminal statuses, route/lead/run shapes.
- `specialties.ts` — the twelve logical specialists mapped onto existing orchestrator roles
  (PLANNER/CODER/REVIEWER) rather than a new process model.
- `registry.ts` / `candidates.ts` — dynamic candidate registration and qualification
  (`VERIFIED_AVAILABLE`/`INTEGRATED`/`EXPERIMENTAL`/`INCOMPATIBLE`/`UNAVAILABLE`/`REJECTED`).
- `lead-policy.ts` — five selectable policies (`auto`, `sol-lead`, `opus-lead`, `dual-lead`,
  `economy-lead`). Named leads require verified `leadIdentity`; no silent substitution.
- `router.ts` — capability routing over the real domain set. Managed-paid routes are
  eligible only via the Paid Auto adapter path; `external_service` candidates are excluded
  from automatic routing (never silently send project content off-box).
- `orchestrator.ts` (`ForgeAaaDirector`) — durable run state, dependency-ordered tasks,
  bounded retries, repeated-failure-signature anti-loop, per-task verification, and an
  honest review record (`independent` is recorded, not assumed).
- `service.ts` — `ForgeAaaService` facade + `asProviderAdapter` (catalog adapter that
  resolves each `forge-aaa:<policy>` model id to its upstream per call — dynamic failover,
  fabric still authorizes the concrete upstream) + `forgeAaaUpstreamResolver` used by the
  server at fabric-admission time.
- `adapters/blender.ts` — real Blender detection (Windows + PATH), 4.5 negotiation,
  bounded headless execution, `FORGEAAA_REPORT:` structured output, approval-gated custom
  scripts.
- `adapters/unreal.ts` — real UE discovery + `Build.version` parsing, 4.27 negotiation,
  `.uproject` inspection, safe-commandlet allowlist, bounded `UE4Editor-Cmd` runs.
- `manifest.ts` / `asset-store.ts` — validated asset manifests (provenance, license,
  SHA-256, units, bounds, engine compat, validation, revision/supersession).
- `verification.ts` — deterministic check kinds; no "looks fine" check counts.
- `hardware.ts` — GPU/VRAM-aware scheduling limits for the T2000-class target.

## Server integration

- `packages/server` depends on `@codeforge/forge-aaa`; the service is constructed from the
  live ForgeAuto roster (roles projected from real qualification evidence).
- `/api/models` emits `forge-aaa:<policy>` rows — prefixed so the `"auto"` sentinel cannot
  collide with ForgeAuto's clear-selection behavior.
- Selection handling normalizes the prefix; per-turn upstream resolution is injected into
  `AgentRuntime` so the Free Cloud fabric authorizes the real concrete provider each turn.
- Fail-closed preserved: canonical models resolve only to executable Free Cloud routes;
  Paid Auto selection still rejected by free-only policy; unknown ids rejected; ForgeZero
  remains execution authority.

## Desktop integration

- `forge-aaa` tier added to the model-catalog union; dedicated section in the picker with
  honest availability/descriptions. Unavailable policies show unavailable rather than
  pretending they can execute.

## Dead Trails West pilot (Gate 6)

The DTW directory was an **empty git repo** — no `.uproject`, no farmhouse. Recorded as a
finding, not papered over: a minimal valid `DeadTrailsWest.uproject` (UE 4.27) was created
additively, then the bounded pipeline ran:

1. `pilot-inspect` (forge-architect → UE adapter): real `.uproject` inspection.
2. `pilot-build` (forge-modeler → Blender adapter): real headless Blender 4.5.14 run —
   6-step stair module, manifold-validated, GLB exported.
3. `pilot-verify` (forge-verify): manifest/hash/file checks.
4. Independent structural review re-hashed the artifact and re-validated the manifest —
   approved, `independent: true`.

Result: `FORGEAAA_VERIFIED` (`pilot-run.json`).

## Acceptance gates

| Gate | Status | Evidence |
|------|--------|----------|
| 1 No regression | PASS | 12 test files / 80 tests green (forge-aaa + server + ui + desktop); typecheck clean; lint clean |
| 2 Real routing | PASS | Routes resolve from live roster candidates + real tool detections; `routeDecisions` persisted in run state |
| 3 Durable execution | PASS | Run state + manifests persisted; anti-loop signature test; no duplicate artifacts (hash-checked) |
| 4 Blender | PASS | Blender 4.5.14 LTS real run: 6 meshes, 48 verts, 0 non-manifold, GLB 9300 B, sha256 `91e2360f…` (`blender-run.json`) |
| 5 Unreal | PASS | UE 4.27.2 `Cook` commandlet on real `.uproject`: exit 0, "Success - 0 error(s), 1 warning(s)" (`unreal-commandlet.json`). `AutomationCommandlet` unavailable in launcher build — recorded as compatibility evidence |
| 6 Full pipeline | PASS | `pilot-run.json` — FORGEAAA_VERIFIED, independent review approved |
| 7 Security | PASS | No paid routes selectable in free-only server; external_service excluded from auto-routing; custom scripts approval-gated; no credentials in evidence |
| 8 Release readiness | **NOT CLAIMED** | Branch not pushed/PR'd; no live remote provider exercise; desktop not smoke-tested against running server |

## Verified roster

- Lead policies: `auto`, `sol-lead`, `opus-lead`, `dual-lead`, `economy-lead` (all resolve
  through the live route table — named leads surface as unavailable unless identity is
  verified).
- Named leads GPT-6.1 Sol / Claude Opus 5.5: **UNAVAILABLE** — no provider on this account
  exposes those ids; the registry reports them honestly instead of substituting.
- Tool adapters: `blender-headless` (4.5.14 LTS, INTEGRATED), `UE4Editor-Cmd` (4.27.2,
  INTEGRATED).

## R77 continuation (this session)

- **`project-discovery.ts`**: real project inspection + four-mode classification
  (`EXISTING_PROJECT`/`NEW_PROJECT`/`PILOT_PROJECT`/`MIGRATION_PROJECT`) + denial guard.
  Generated `.uasset` content honestly upgrades a pilot project to EXISTING — the
  classifier never downgrades content back to disposable.
- **`UnrealAdapter.importAssets`**: first-class scripted import through the real UE4.27
  `ImportAssets` commandlet (AutomatedAssetImportData settings JSON, `/Game/…` guard,
  missing-source guard).
- **Stair module v2** (live): handrail posts + continuous rail (90 cm), 6 UCX per-step
  collision proxies, top/bottom modular sockets, normals/degenerate/manifold validation —
  16 meshes, 128 vertices, GLB + FBX exported (`stair-v2-run.json`).
- **Real UE4.27 import VERIFIED**: `ImportAssets` commandlet wrote **10 real `.uasset`
  files** under `Dead Trails West/Content/ForgeAAA/` (6 steps, 3 rail posts, handrail).
  Commandlet exit code is not authoritative — this launcher build counts the expected
  "no source control" error in its summary while import succeeds; the gate verifies
  on-disk `.uasset` existence (`unreal-import-attempt.json`).
- DTW discovery limitation stands: no authored farmhouse exists anywhere on the searched
  drives; the project remains an explicitly-labeled pilot.

## Blockers / next steps

- `sol-lead`/`opus-lead`/`dual-lead` need provider credentials exposing those model ids.
- Imported assets land as separate static meshes (FBX object split) — no combined
  `SM_Stairs` actor, no in-level placement yet (map authoring needs Python plugin or
  Editor scripting enablement — next milestone).
- Smoothing-group warning on import — normals should be visually verified next round.
- UE5 adapter is a separate version-aware implementation — not started.
- Full Phase H specialist expansion requires provider/service qualification per candidate.
- Dedicated AAA workspace view (task graph, artifact preview, rollback UI) is future work.
