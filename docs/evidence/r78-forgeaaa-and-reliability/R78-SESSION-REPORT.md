# R78 — Autonomous Reliability + ForgeAAA Auto — Session Report

Base: convergence merge `cf483891` (R76 ⊕ R77, zero file overlap, verified).
Worktree: `G:\CodeForge\worktrees\r78-forgeaaa-and-reliability` on `codex/r78-forgeaaa-and-reliability`.

## TRACK A — CodeForge free reliability: `CODEFORGE_R76_PARTIAL`

No new route-capacity evidence materialized this session, so no changed-condition
re-probes were run (per directive: no retries without new evidence). Status stands:

- Qualified Coder routes: **1** (kilo-liquid). No quota-independent second route demonstrated.
- R7 campaign evidence (3/3 genuine completions) preserved; not re-run for headlines.
- Rate-limit scope propagation, planner demotion repair, workspace-root prompt fix, reviewer
  admission, packaging isolation — all re-validated on the merged tree (see regression below).
- Harder task classes still exceed free-model turn budgets; no efficiency claims made
  without demonstrated completion.

## TRACK B — ForgeAAA Auto: `FORGEAAA_PARTIAL` — advanced to engine LEVEL 6

| Level | Status | Evidence |
|---|---|---|
| 1 GENERATED | ✓ (prior) | stair-module-v2 GLB/FBX, `r77` artifacts |
| 2 EXPORTED | ✓ (prior) | `stair-v2/*.fbx` |
| 3 IMPORTED | ✓ **verified in-engine** | `asset-load-report.json` — all 10 meshes `load_asset` OK, `StaticMesh`, 1 convex collision elem each, `CTF_USE_DEFAULT` |
| 4 PLACED | ✓ | `placement-report.json` — `FAAA_StairTest` created, 10 actors spawned, world bounds recorded |
| 5 PERSISTED | ✓ **fresh process** | `persistence-report.json` — separate editor run: `does_asset_exist` + `load_level`, 10 labeled actors found |
| 6 ENGINE_VERIFIED | ✓ | refs valid (`/Game/ForgeAAA/stair-module-v2_*`), transforms `(0,0,0)`, `QUERY_AND_PHYSICS` collision, STATIC mobility, bounds consistent |
| 7 FUNCTIONALLY_VERIFIED | ✗ | no character-traversal test exists yet; not claimed |
| 8 INDEPENDENTLY_REVIEWED | ✗ | structural review approved but `independent: false` — no qualified independent reviewer route exists |

### New adapter capabilities (`packages/forge-aaa/src/adapters/unreal.ts`)

- `ensurePlugins(uproject, names)` — additive, idempotent `.uproject` plugin enablement
  (pilot/authorized projects only). Used live: `PythonScriptPlugin` + `EditorScriptingUtilities`
  enabled on the DTW pilot; verified mounted in engine log.
- `runPythonScript(req)` — bounded `-ExecutePythonScript=` execution (UE 4.27 mechanism;
  no `pythonscript` commandlet exists in this build). `-abslog=` support added because
  launcher builds write LogPython output to the engine log file, not stdout.
- `placeAssets(req)` — generates a reviewed deterministic editor script (embedded JSON spec,
  no user code): create-or-load level, spawn via `EditorLevelLibrary.spawn_actor_from_object`
  (4.27 API — `EditorActorLibrary` does not exist), stable-label idempotency (repeat runs
  `update` — verified live: 10×`updated`, still exactly 10 actors), `save_current_level`,
  `FORGEAAA_REPORT` emission parsed back into structured result.
- `runCommandlet` — `commandlet` now optional (raw switches), `logPath`/`report` added.

### Real engine operations executed (UE 4.27.2, CL 18319896)

1. `.uproject` plugin enablement → log shows `Mounting plugin PythonScriptPlugin`, `Using Python 3.7.7`.
2. Smoke: `-ExecutePythonScript` → `{"ok":true,"engine":"4.27.2-18319896+++UE4+Release-4.27","python_path_ok":true}`.
3. Asset inspection → all 10 `.uasset` load, bounds + `body_setup` + convex collision confirmed.
   Sockets: `Socket_Bottom`/`Socket_Top` **did not survive FBX import** (`find_socket` → none;
   `Sockets` property is protected in 4.27 Python). Recorded, not claimed.
4. Placement → level `/Game/ForgeAAA/Maps/FAAA_StairTest` created, 10 actors, saved
   (`FAAA_StairTest.umap`, 19 545 B, hash in `uasset-inventory.json`).
5. Persistence → separate editor process loaded the level and re-verified all actors.
6. Idempotency → second `placeAssets` produced 10×`updated` at new transform, no duplicates.
7. Director workflow (`director-live` run `aaa-493f0575-…`): planner → 3-task dependency
   chain (inspect→place→persist) executed through real editor processes; `verifyTask`
   re-parsed on-disk reports; review approved with `independent:false`;
   run verdict **`FORGEAAA_VERIFIED` for this workflow scope** (does not extend to
   Levels 7–8 or the product milestone).

### Geometry facts (engine-measured)

- Staircase assembled footprint ≈ 165 × 90 cm; height 201.3 cm — matches Blender v2 spec.
- Steps: 27 cm run, 18 cm rise, uniform — bounds verified per actor.
- Mesh pivots at module origin; layout offsets baked into geometry → all pieces share one
  placement transform. This convention is now documented for the modular system.

### Project classification fix (`project-discovery.ts`)

Generated artifacts (`.uasset` under `Content/ForgeAAA/`, `.forge-aaa/`) no longer count as
authored content — a generated-only pilot stays resumable as `PILOT_PROJECT` instead of being
promoted to `EXISTING_PROJECT` by its own tool output. 6 unit tests cover the distinction.

## Regression (this worktree)

| Scope | Result |
|---|---|
| `packages/forge-aaa/test` + `packages/providers/test` | 47 files / **411 passed** (5 live-gated skipped, `FORGE_AAA_LIVE` unset) |
| `apps/desktop/test` (incl. model picker, packaging isolation) | 53 files / **480 passed** |
| `packages/eight-bit/test` + `r75-planner-contract-repair` + `r76-reviewer-parent-admission` | 43 files / **443 passed** (2 postgres-gated skipped) |

Typecheck clean (`tsc -b` forge-aaa + merged tree). Live engine runs used real
`UE4Editor-Cmd` processes; every run's log is captured via `-abslog`.

## Known limitations (honest)

- Level 7 traversal: no PIE/gameplay traversal test — mesh+collision presence only.
- Level 8: no qualified independent reviewer route — structural review only.
- Import commandlet still exits 1 on SCC error in this environment; import success is
  established by in-engine load + placement + persistence, not process exit code.
- Only 1 qualified free Coder route; harder tasks exceed turn budgets.
- `FAAA_StairTest` level and ForgeAAA content live in the DTW pilot project, whose
  `.uproject` now enables the two editor plugins (permitted pilot mutation).

## Cost

$0 inference — no model calls were made; all work was deterministic adapter execution
plus local tests. `modelCalls` counter in the Director run reflects executor invocations,
not inference.
