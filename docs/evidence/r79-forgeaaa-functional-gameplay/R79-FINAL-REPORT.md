# R79 — ForgeAAA Functional Gameplay + Free Coder Independence

**Branch:** `codex/r79-forgeaaa-functional-gameplay`
**Base:** `6e6c13b0` (published R78 head, verified against `origin` before branching)
**Worktree:** `G:\CodeForge\worktrees\r79-forgeaaa-functional-gameplay`
**Engine under test:** Unreal Engine 4.27.2 launcher build, Dead Trails West pilot
(`C:\Users\Daddy_FDS\Documents\ChatGPT\Dead Trails West`), Python 3.7.7.

## Headline

`FORGEAAA_LEVEL7_VERIFIED` — the staircase is functionally traversable. A real
`ACharacter` driven by real `CharacterMovementComponent` input ascended and descended
the module, was physically blocked by the handrail, and produced repeatable
trajectories across independent engine processes. All 7 functional tests pass.

`CODEFORGE_R76_PARTIAL` — one qualified Free Coder route (kilo-free-direct). Two new
catalog probes this session (BlockRun, AI Horde) produced negative findings —
recorded, not probed further.

## Track B — ForgeAAA

### What actually works now (new in R79)

`UnrealAdapter.runFunctionalTest(req)` — a reusable bounded traversal tester:

- Launches `UE4Editor.exe <map> -game -unattended` (real game world — PIE/SIE cannot
  run unattended under this build; verified empirically — PIE sessions tear down
  0.3s after start).
- Executes the traversal driver via the plugin's **`StartupScripts`** setting
  (`[/Script/PythonScriptPlugin.PythonScriptPluginSettings]`, `+StartupScripts=`,
  `config=Engine` — verified against the plugin source in the installed engine).
  Injected into `Config/DefaultEngine.ini` before launch and byte-restored after.
- Drives per-frame logic with `register_slate_post_tick_callback` (slate ticks DO
  run in `-game` mode — measured ~265 Hz).
- World resolution in game mode via `unreal.find_object` on the level package path —
  `None` world context cannot resolve in `-game` (verified); a `UWorld`/`ULevel`
  object IS a valid world context.
- Character lifecycle: destroys the GameMode auto-spawned `DefaultPawn` (its collision
  depenetrated the test character — root-caused from trajectory samples), summons
  `Engine.Character` via console exec, teleports, clears residual velocity, sets
  `run_physics_with_no_controller` + `MOVE_WALKING` (summoned pawns come up
  `MOVE_None` — root-caused from a diagnostic readback), settles 0.5s, then applies
  real `add_movement_input` per tick.
- Samples `{t, wt, x, y, z, v}` every `samplePeriodS`; optional `stopWhen` halts input
  on goal attainment without cutting the observation window.
- Report file is authoritative — `runId` baked into the spec, stale reports rejected.
- Result states: `pass | fail | blocked | timeout | not_executed`. Missing/empty
  samples or a null character are never a pass.

### Functional test evidence (all in this directory)

| Test | Mechanism | Result |
|---|---|---|
| Approach | spawn `(-160,0,100)`, walk +x | **pass** — 90.15 z on floor, no phantom barrier |
| Ascend | walk +x across all 6 steps | **pass** — z 90→198, `target_reached` at 0.61s, stands on top platform |
| Descend | spawn `(250,0,210)`, walk −x | **pass** — 198→90, no trap, no fall-through |
| Side collision | on step, push −y into rail | **pass** — 3s of input → 1.87cm displacement; rail physically blocks |
| Step consistency | 30ms sampling of climb | **pass** — continuous 18cm step-ups, no teleports/drops |
| Persistence | saved level reopened per launch | **pass** — identical behavior on fresh processes |
| Repeatability | 3 independent launches | **pass** — finals within ±0.4cm |

Trajectory evidence: `traversal-*.report.json` (position+velocity per 0.1s/0.03s),
`engine-*.log` (full Unreal logs), `functional-*.json` (adapter results).

### Director integration

`director-run-final.json` — a real Director run
(`inspect → traverse` chain, `aaa-inspect` verified the 13-actor level via engine
introspection; `aaa-traverse` ran all three traversal tests). Task verification
re-parsed the on-disk report files and checked `runId` freshness — independent of
executor claims. Final status: **`FORGEAAA_VERIFIED`** for this run's scope.

Review: `independent: false` — structural review only. **LEVEL 8 not claimed.**

### Socket repair (mission §5)

Root cause confirmed in Blender source (`live-stair-v2.test.ts`): sockets were
authored as top-level `Socket_*` empties; UE4's FBX importer only creates sockets
from `SOCKET_*` null nodes **parented to a mesh**. Two-sided fix:

- **Engine-side repair:** `StaticMesh.add_socket` created 4 sockets on the imported
  assets — `Socket_MountBottom`/`Socket_MountTop` (steps) and
  `Socket_RailStart`/`Socket_RailEnd` (handrail). Verified persisted in a separate
  process (`socket-verify-reopen.log`, `transform_ok: true` on all four).
- **Pipeline-side fix:** the Blender template now emits `SOCKET_*` empties parented
  to their host mesh, with rail-connection sockets added (4 total).

### Files changed

- `packages/forge-aaa/src/adapters/unreal.ts` (+367) — `runFunctionalTest`,
  `injectStartupScript`/restore, `game`-mode commandlet support, `deleteFile` dep,
  `stopWhen`, `samplePeriodS`, runId-bound report validation.
- `packages/forge-aaa/test/adapters.test.ts` (+158) — 7 new `runFunctionalTest`
  tests: validation gates, ini inject/restore, `-game` args, fresh-report parsing,
  stale-report rejection, no-report→blocked, timeout→timeout.
- `packages/forge-aaa/test/live-stair-v2.test.ts` — SOCKET_ convention fix (live-gated).

## Track A — CodeForge Free

`CODEFORGE_R76_PARTIAL`. Still **1 qualified Coder route** (kilo-free-direct).

New evidence this session (catalog probes only — zero inference spend):

- **BlockRun free catalog** (`blockrun-catalog-2026-10-11.json`): 115 models listed,
  exactly **1 free** — `nvidia/llama-3.2-11b-vision` (chat/vision, not coding).
  Negative finding; no probe wasted.
- **AI Horde live status** (`ai-horde-catalog-2026-10-11.json`): 32 models, all
  RP/chat-oriented; the 3 "coding-ish" matches are 1-worker sub-1B/27B community
  models on the shared anonymous queue — not a credible Coder route.
- OpenCode Zen / GitHub Models require per-user keys (not zero-touch automatic).
  ZenMux / Kilo keyed gateways remain `LEGAL_REVIEW_REQUIRED`, unimplemented.

No re-probing of exhausted routes. Difficult-task efficiency and multi-account
entitlement separation remain open.

## Regression

- `packages/forge-aaa` + `packages/eight-bit` + `packages/forge-zero`:
  **70 files / 671 tests pass** (7 skipped — live-gated / env).
- `npm run build` — clean across all workspaces (typecheck included).
- Diff scope: 3 files, +533/−10. No routing, spending, or desktop surfaces touched.

## Inference spend

**$0** — zero model calls. All ForgeAAA execution was deterministic adapter work.

## Honest limitations

- LEVEL 8 blocked: no qualified independent Reviewer exists; review stayed
  `independent: false`.
- Traversal used a summoned `Engine.Character` with no controller
  (`run_physics_with_no_controller`) — real CharacterMovement physics, but not a
  player-controller path. A possessed-pawn or nav-driven variant is future work.
- The traversal level's floors use engine `/Engine/BasicShapes/Cube` — fine for
  validation, not a content claim.
- Blender-side socket fix is code-reviewed but live-run gated
  (`FORGE_AAA_LIVE=1` not exercised this session).

## Remaining work (next milestone)

- Independent Reviewer qualification → LEVEL 8.
- Second quota-independent Coder route (catalog rotates — recheck on new evidence).
- NavMesh + AIController `move_to` traversal variant; player-possessed path.
- Building-system module contracts (dimensions, sockets, materials, provenance).
