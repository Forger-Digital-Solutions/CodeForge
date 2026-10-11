# R80 — ForgeAAA Autonomous Game Development + Independent Review + Interactive World Construction

Baseline: `codex/r79-forgeaaa-functional-gameplay` @ `7247e757` (`FORGEAAA_LEVEL7_VERIFIED`).
Worktree: `G:\CodeForge\worktrees\r80-forgeaaa-autonomous-gameplay`.
Engine: Unreal Engine 4.27.2 against Dead Trails West (`DeadTrailsWest.uproject`).
All inference: free cloud routes only, ForgeZero-eligible. $0 spend.

## Outcomes

### 1. Independent review of R79 — completed, substantive

`independent-review-r79-1791695921893.json`

- Reviewer: `nvidia/nemotron-3-ultra-550b-a55b:free` via `kilo-free-direct`
- Qualification: REVIEWER `QUALIFIED`, score 0.875, suite `R73_ROLE_QUALIFICATION_V7`, protocol `REVIEWER_PROTOCOL_V4`
- Result: `verdict: pass`, `independent: true`, `approved: true`, 1 request
- Advisory findings recorded (not hidden): summoned `Engine.Character` had no player controller; validation floor used `/Engine/BasicShapes/Cube`; prior Director record had `independent: false`.
- Supports upgrading the R79 staircase claim to `FORGEAAA_LEVEL8_VERIFIED` within those advisory bounds.

### 2. Model-directed task — real model output drove the pipeline

`model-door-spec-1791696265026.json`

- Coder model: `nvidia/nemotron-3-super-120b-a12b:free` (CODER QUALIFIED + structuredOutput) via `kilo-free-direct`
- Produced a valid `doorSpec` in one request; validated by `validateDoorSpec`; drove Blender geometry, UE4 import, placement, and all functional parameters. Not a script replay.

### 3. Modular door — full verified cycle

`door-live-1791698160096.json` (and `door-live-1791698257223.json`)

Blender 4.5-generated frame + hinge-origin leaf with UCX collision → UE4.27 FBX import (`door_SM_DoorFrame`, `door_SM_DoorLeaf`) → placed in walled test level `FAAA_DoorTest` → `-game` interaction scenario:

| # | action | engine evidence |
|---|---|---|
| 0 | move into closed door | blocked at endY −36.5 (capsule radius + leaf thickness) |
| 1 | interact | observed leaf yaw 0 → −95 (physically rotated) |
| 2 | move | passed through doorway, endY +1674 |
| 3 | interact | closed, observed yaw 0 |
| 4 | move back into closed door | blocked from far side at endY +39.5 |
| 5 | interact | reopened, observed −95 |
| 6 | move | returned through open door, endY −1673 |

- Persistence: separate process launch; placed leaf found by actor label, observed yaw 0→−95→0. `pass`.
- Config restoration: `configRestored: true` in every run.
- Gate strictness: `obsDoorYawDeg` (yaw read back from the actor) must match commanded yaw within 8° — a dropped rotation can never pass again.

### 4. Harness hardening

- Per-project `DefaultEngine.ini` lifecycle: lock + byte-for-byte backup + ownership token + engine-PID record + ownership-verified restore + orphan reaping + fail-closed when ownership unproven.
- Forward-slash path normalization for startup-script injection (backslash paths were mangled by UE4's ini parser → path exec'd as code → `<string>` SyntaxError).
- False-positive gate closed: missing action metrics → blocked/fail, never pass. Regression test added.

## Bugs found and fixed (real, evidence-driven)

1. **Placed leaf never physically rotated**: `obsDoorYawDeg` stayed 0 while commanded yaw swung — `mobility` is read-only via Python attribute assignment; `leaf.static_mesh_component.mobility = MOVABLE` silently failed (`Property 'Mobility' ... read-only`). Fixed with `set_mobility()`, verified by re-read, escalated to errors if still STATIC.
2. **False-positive pass**: `math.dist` doesn't exist in UE4.27's Python 3.7, killing the tick path — and the gate treated empty `actionMetrics` as pass. Both fixed.
3. **Character fell off the world**: after a mid-scenario failure, movement ran past the 6m test floor edge (z=−2660). Floor enlarged to 40m; expectations unchanged.

## Known limitations (honest)

- `probeCenter` doorway line-trace is instrumentation only: `TraceChannel` enum is not exported by UE4.27's Python binding; `probeError` is recorded, never gated. Collision/passage evidence stands on capsule displacement + observed yaw.
- Door is a test-level modular assembly (frame + leaf + walls + floor), not a farmhouse — per milestone scope.
- The R79 advisory items (summoned character without controller, basic-shape floor) remain as documented limitations of the test harness.
- 8 moderate npm audit findings on install; deferred, not introduced by this change.

## Test status

- `packages/forge-aaa`: 87 passed / 5 skipped (13 files).
- Live UE4.27 pipeline: blender → import → place → interaction `pass` → persistence `pass`, file-backed reports only.
