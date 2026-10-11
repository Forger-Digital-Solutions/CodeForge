# R83 Recovery Inventory

**Branch:** `codex/r83-forgeaaa-autonomous-multiroom`
**Worktree:** `G:\CodeForge\worktrees\r83-forgeaaa-autonomous-multiroom`
**Starting HEAD:** `f1b02e3f4ae5c522964743ccf04a33d004a91c33`
**R82 Baseline:** `f1b02e3f` (unchanged, confirmed)
**Recovery Checkpoint A:** `ddef68dd`

---

## Repository State at Recovery Entry

### Branch
```
* codex/r83-forgeaaa-autonomous-multiroom
  (HEAD was at R82 baseline f1b02e3f — no prior R83 commits)
```

### Untracked Files Found (prior agent work)
| File | Status |
|------|--------|
| `packages/forge-aaa/src/building-revision.ts` | New — migration system |
| `packages/forge-aaa/src/connected-building.ts` | New — connected-room validator |
| `packages/forge-aaa/src/r83-building-spec.ts` | New — R82/R83 building specs |
| `packages/forge-aaa/test/building-revision.test.ts` | New — migration tests |
| `packages/forge-aaa/test/orchestrator-recovery.test.ts` | New — Director recovery tests |
| `packages/forge-aaa/test/r83-building-spec.test.ts` | New — building spec tests |
| `benchmarks/r83/` | New directory |
| `docs/evidence/r83-forgeaaa-autonomous-multiroom/` | New directory with recovery/ subdirectory |

### Modified Tracked Files (prior agent work)
| File | Changes |
|------|---------|
| `packages/forge-aaa/src/index.ts` | +3 exports: building-revision, r83-building-spec, connected-building |
| `packages/forge-aaa/src/orchestrator.ts` | ~+130/-6 lines: durable checkpoints, recovery, evidence-backed verification |
| `.gitignore` | Added `.scratch/` exclusion |

### Recovery Evidence from Prior Agents
```
docs/evidence/r83-forgeaaa-autonomous-multiroom/recovery/
  initial-file-hashes.json
  initial-status.txt
  initial-tracked.patch
  original/
  worktrees.txt
```

---

## Defects Found and Repaired

### Defect 1 — TypeScript compile error
**File:** `packages/forge-aaa/src/r83-building-spec.ts`
**Error:** `modelClaimedId` property on door module provenance not in `BuildingModuleProvenance` type
**Fix:** Removed the unknown property

### Defect 2 — isMigrationIdempotent reason string mismatch
**File:** `packages/forge-aaa/src/building-revision.ts`
**Test expected:** `"target revision fingerprint"` in reason
**Actual:** `"Target revision is already present; engine actor verification is still required"`
**Fix:** Changed to `"Building is already at target revision fingerprint; engine actor verification is still required"`

### Defect 3 — Python migration script print marker
**File:** `packages/forge-aaa/src/building-revision.ts`
**Test expected:** `FORGEAAA_MIGRATION_REPORT:`
**Actual:** `FORGEAAA_REPORT:`
**Fix:** Renamed to `FORGEAAA_MIGRATION_REPORT:` to match test contract

### Defect 4 — building-revision tests used old boolean commit/rollback API
**File:** `packages/forge-aaa/test/building-revision.test.ts`
**Problem:** Tests 4, 8, 9, 10 called `commitMigration(migration, true/false)` directly, but
the migration system was correctly strengthened to require `SavedLevelVerification` (filesystem
evidence) for COMMITTED/ROLLED_BACK. The boolean `true/false` now correctly returns BLOCKED.
**Fix:** Updated tests to use real temp files with `SavedLevelVerification` objects containing
durable receipts. Added `rollbackMigration` import. Preserves the safety invariant.

### Defect 5 — orchestrator-recovery test: wrong argument check
**File:** `packages/forge-aaa/test/orchestrator-recovery.test.ts`
**Problem:** `expect(executeTask.mock.calls[0]?.[0]).toBeUndefined()` — expected undefined but
received the task object (which is correct behavior; `executeTask` receives the task as arg[0])
**Fix:** Changed to `expect(executeTask.mock.calls[0]?.[0]?.id).toBe("build")`

### Defect 6 — orchestrator-recovery checkpoint fires too early on restart
**File:** `packages/forge-aaa/test/orchestrator-recovery.test.ts`
**Problem:** Checkpoint condition `run.tasks[0]?.status === "generating"` fires on the initial
`await this.persist(run)` call in `execute()` when the restored task still has `status = "generating"`
from the previous checkpoint, before `executeTaskBounded` increments `task.attempts`.
**Fix:** Changed to `run.counters.taskAttempts === restart + 1` — only fires after
`executeTaskBounded` has incremented the counter, which is a reliable indicator.

---

## Test Results After Recovery

```
Test Files: 19 passed, 3 skipped (live engine gates — require Blender 4.5 / UE 4.27)
Tests: 151 passed, 5 skipped
```

### New test files (all passing)
- `building-revision.test.ts` — 10 tests (migration state machine, evidence-backed)
- `orchestrator-recovery.test.ts` — 20 tests (Director recovery, durable checkpoints)
- `r83-building-spec.test.ts` — 8 tests (connected building spec, migration plan)

### TypeScript
- `packages/forge-aaa/tsconfig.json` — clean (0 errors)
- Pre-existing errors in `apps/web/src/workspace-sse.ts` (unrelated to R83, present in baseline)

---

## Implemented Architecture

### `building-revision.ts`
- Migration state machine: `PLANNED → VALIDATED → APPLYING → VERIFYING → COMMITTED | ROLLED_BACK | BLOCKED`
- `planMigration` / `validateMigration` / `applyMigration` / `verifyMigration`
- `commitMigration` — requires `SavedLevelVerification` with receipt file on disk
- `rollbackMigration` — requires `SavedLevelVerification` with receipt file on disk
- `computeBuildingFingerprint` — SHA-256 of building+modules JSON
- `migrationAssemblyScript` — generates Python script for UE4.27 execution
- `isMigrationIdempotent` — detects already-applied migrations

### `connected-building.ts`
- `ConnectedBuildingDefinition` interface extending `BuildingDefinition`
- `validateConnectedBuilding` — strict validator covering:
  - Room geometry (floor/ceiling alignment, footprint coverage)
  - Connection geometry (shared wall, door orientation, threshold floor continuity)
  - Door orientation: `yawDeg % 180 === 90` for X-axis connections (corrects the 90° defect)
  - Threshold: floor-type module spanning the wall thickness at opening width
  - Gap validation: rejects any solid geometry blocking the shared opening
  - Connectivity: graph traversal ensures all rooms are reachable
  - Persistent identity uniqueness for native gameplay actors

### `r83-building-spec.ts`
- `R82_ONE_ROOM_BUILDING` — 14-instance baseline (unchanged from R82)
- `R83_TWO_ROOM_BUILDING` — 23-instance two-room building with:
  - Room A (living room) at X=0, Room B (workroom) at X=580
  - Shared wall at X=290 with 110cm doorway
  - Interior door at yawDeg=90 (corrects orientation defect)
  - Threshold floor spanning the shared wall
  - All R82 instances preserved (except wall-right → replaced by shared wall segments)
- `R82_ONE_ROOM_MODULES` / `R83_NEW_MODULES` / `R83_TWO_ROOM_MODULES` registries

### `orchestrator.ts` changes
- Durable checkpoint before each task dispatch (persist with incremented attempts)
- `task.execution` field records durable execution result before verification
- `verifyExecutedTask` resumes verification after restart without re-executing
- `orderedTasks` topological sort with cycle/duplicate/size validation
- Restored tasks in terminal states are skipped, not re-executed
- `run.maxAttemptsPerTask` stored in run for cross-restart budget enforcement
- `adapterOps` counter alongside `modelCalls`
- `FORGEAAA_VERIFIED` now requires independent review (`review.approved && review.independent`)

---

## Connected Room Geometry (verified by validator)

```
Room A (living-room):
  Center: [0, 260, 0]
  Interior: 560 × 520 × 260 cm
  Floor: SM_PlankFloor at positionCm=[0,260,-5]
  Ceiling: SM_Ceiling at positionCm=[0,260,265]

Shared Wall (X=290):
  Normal axis: X (east/west connection)
  Thickness: 20 cm
  Opening: 110 cm wide × 215 cm high at Y=260

Interior Door:
  Instance: door-interior
  Module: dtw/building/door-western/v1 (native ForgeInteractableDoor)
  Position: [290, 260, 0]
  yawDeg: 90  ← corrects reported 90° orientation defect
  Attachment: shared-wall-front / door-int socket

Threshold:
  Instance: threshold
  Module: SM_DoorThreshold/v1 (floor type)
  Dimensions: 20 × 110 × 10 cm (wall thickness × opening width × floor thickness)
  Position: [290, 260, -5]
  Floor top surface: z = 0 (matches both room floor surfaces)
  ← bridges the floor gap between rooms

Room B (workroom):
  Center: [580, 260, 0]
  Interior: 560 × 520 × 260 cm
  Floor: SM_PlankFloor at positionCm=[580,260,-5]
  Ceiling: SM_Ceiling_B at positionCm=[590,260,265]
```

---

## Known Remaining Work

### Phase C — Migration (GATE C)
- Evidence-backed migration contract is implemented and tested
- `migrationAssemblyScript` generates the UE4.27 Python script
- Real UE4.27 execution is not yet verified (requires live engine)

### Phase D — Engine Assembly (GATE E)
- Two-room Blender assets need to be created/exported for new modules
- New modules: SM_DoorThreshold, SM_SharedWall_Front/Back/Lintel, SM_FrontWall_B, SM_Ceiling_B
- Import and level assembly in UE4.27 pending

### Phase E — Native Gameplay (GATE F)
- Interior door integration in native UE4.27 C++ plugin needed
- Room-to-room traversal testing pending

### Phase F — Persistence (GATE G)
- SaveGame compatibility with new interior door identity pending

### Phase G–J — Director, Review, Regression, Publication
- All pending

---

## Gate Status

| Gate | Status | Evidence |
|------|--------|---------|
| A — Recovery | ✅ VERIFIED | ddef68dd committed |
| B — Building Specification | ✅ VERIFIED | 8 tests pass |
| C — Migration Safety | ✅ VERIFIED | 10 tests pass (unit; live engine pending) |
| D — Geometry | ✅ VERIFIED (unit) | Validator enforces door yaw=90°, threshold, gap |
| E — Engine Assembly | ⏳ PENDING | Live UE4.27 not yet executed |
| F — Gameplay | ⏳ PENDING | Live UE4.27 not yet executed |
| G — Persistence | ⏳ PENDING | |
| H — Idempotency | ✅ VERIFIED (unit) | isMigrationIdempotent test passes |
| I — Recovery | ✅ VERIFIED | 20 orchestrator-recovery tests pass |
| J — Director | ⏳ PENDING | |
| K — Model Contribution | ⏳ PENDING | |
| L — R82 Independent Review | ⏸ BLOCKED | Reviewer timeout from R82 unresolved |
| M — R83 Independent Review | ⏳ PENDING | |
| N — Visual Evidence | ⏳ PENDING | Requires live engine |
| O — Regression | ✅ PARTIAL | forge-aaa suite clean; live engine tests skipped |
| P — Publication | ⏳ PENDING | |
