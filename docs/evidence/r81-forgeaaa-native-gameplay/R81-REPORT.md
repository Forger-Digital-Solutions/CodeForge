# R81 — ForgeAAA Native Gameplay + Persistent Interactive Buildings

**Branch:** `codex/r81-forgeaaa-native-gameplay`
**Base:** `083c674b` (published R80 head)
**Worktree:** `G:\CodeForge\worktrees\r81-forgeaaa-native-gameplay`
**Engine under test:** Unreal Engine 4.27.2 launcher build
(`4.27.2-18319896+++UE4+Release-4.27`), Dead Trails West
(`C:\Users\Daddy_FDS\Documents\ChatGPT\Dead Trails West`), MSVC 14.51 via VS 18
Community (UBT 4.27 treats any VS ≥17 as VS2022).

## Headline statuses

- **`R81_NATIVE_GAMEPLAY_VERIFIED`** — a reusable native Unreal door actor is
  opened and closed by real gameplay input (`E` → ActionMapping → PlayerInput →
  handler), the leaf physically rotates about a real hinge pivot with commanded
  yaw equal to observed component yaw, per-instance state survives in-process
  reload AND separate-process restart through a real `USaveGame` slot, two
  instances keep independent records, and a corrupt save fails safe. Three
  consecutive `-game` processes, 81 measured actions, zero Python in the
  gameplay loop.
- **Independent review: `pass`, `independent: true`** — qualified reviewer
  `nvidia/nemotron-3-ultra-550b-a55b:free` (kilo-free-direct, QUALIFIED per
  R73 receipt) reviewed the evidence packet and returned `verdict: pass` with
  3 advisory findings, none blocking
  (`independent-review-r81-1791727845848.json`).
- **`CODEFORGE_R76_PARTIAL`** — preserved. Phase H delta: kilo free catalog
  unchanged (12 models, none added/removed); BlockRun free count dropped 2→1
  (only `nvidia/llama-3.2-11b-vision` remains — chat/vision, not coding).
  Still **1** anonymous quota domain; zero new Coder candidates; zero probe
  inference spent.

## What R80 → R81 changed

R80's door was driven by a **Python test harness** rotating the leaf actor —
"no game-native player interaction path", as its own report declared. R81
replaces that with an actual gameplay implementation:

| R80 (harness) | R81 (native gameplay) |
|---|---|
| Python `set_actor_rotation` on the leaf | `AForgeInteractableDoor` state machine, tick-driven leaf |
| Python performs the "interact" action | `E` key → `ForgeInteract` ActionMapping → `PlayerInput` → `AForgeInteractCharacter` sweep+target+dispatch |
| Leaf rotated about its mesh center | `DoorRoot → HingePivot(edge) → LeafMesh(+offset)` — real hinge |
| Saved-level persistence (actor re-found by label) | `UForgeDoorSaveGame` per-instance records, schema-versioned, restored on `OpenLevel` and fresh process |
| No per-instance contract | `ForgeInstanceId` (defaults to placed actor name), independent records per door |
| Python StartupScripts injected per run | `-ForgeDriverSpec=` native driver; **no Python startup injection** (`pythonModuleLoaded` recorded honestly) |
| Single door | Two independent instances on one map |
| No failure handling | Corrupt/truncated save → `loaded:false`, door defaults closed, no crash |

## Native architecture (all in `benchmarks/r81/forge-gameplay-plugin/`)

- `IForgeInteractable` — interaction contract (`ForgeInteract(instigator)`,
  `ForgeInteractableName()`) — the reusable seam for doors, storage, switches.
- `AForgeInteractableDoor` — AActor; hinge hierarchy; `closed→opening→open→closing`;
  reversal during transitions supported; persists only stable states; restores
  and normalizes malformed records to closed; records `obsYawDeg` vs `cmdYawDeg`.
- `UForgeDoorSaveGame` — `schemaVersion`, `TMap<instanceId, {state, leafYawDeg}>`,
  dedicated slot `ForgeR81DoorTest`.
- `AForgeInteractCharacter` — possessed pawn; `ForgeInteract`=E + WASD axes via
  **project-level** `Config/DefaultInput.ini` (plugin ini did not merge —
  measured `actions:[]`); forward sphere sweep aims along **control rotation**;
  records dispatched/target/distance/sweepHits per press.
- `AForgeGameplayMode` — binds character + player controller.
- `AForgeDoorTestDriver` — placed verifier; bounded JSON ops
  (face/moveTo/press/wait/probe/expectDoor/save/slotVerify/reloadMap/corruptSave/
  deleteSave/exit); two-phase press (inject, then measure next tick — real
  PlayerInput queues events); runId-bound report; errors preserved across
  checkpoint/reload.
- `UnrealAdapter.runNativeGameplayTest` — `/Game` path gate, 1–96 action bound,
  safe slot-name gate, stale-report rejection by runId, expect-matching against
  measured fields only.

## Live evidence — `native-door-live-1791726964164.json`

`{"mapBuild":true,"stage1":"pass","stage2":"pass","stage3":"pass","pythonModuleLoaded":true}`

**Stage 1 (45 actions):** out-of-range press at ~150cm → `dispatched:false` with
`sweepHits:[]`; press at 34.26cm → `dispatched:true`, target `FAAA_door-western-a`;
`expectDoor open` → `obsYawDeg:-95, hingeYawDeg:-95, cmdYawDeg:-95`; probe through
open doorway `blockingHit:false`; traversal both directions; press from the other
side at 27.50cm closes it; closed probe `blockingHit:true` on `LeafMesh`; moveTo
into closed leaf stalls at y=-36.5 (physical block); reopen + re-traverse; door B
independently opened (−95) and closed; `save` → slotVerify shows BOTH records;
`reloadMap` → A=`open`/−95, B=`closed`/0 restored; closed-B probe blocked.

**Stage 2 (31 actions, fresh process):** A=`open`/−95 and B=`closed`/0 restored
from the SaveGame written by stage 1; traversal through restored door (end
y=18.59, past plane); close→block→reopen A; door B cycle; A still open;
save + slotVerify both records; `corruptSave` writes garbage bytes before exit.

**Stage 3 (5 actions, third process):** `slotVerify` → `slotExists:true,
loaded:false` (corrupt rejected); door A `closed` (fail-safe); `deleteSave` ok;
`slotExists:false`. Slot left clean.

## Model-directed artifact (bounded, Gate: real inference)

`nvidia/nemotron-3-super-120b-a12b:free` (CODER-qualified, R80 receipt) authored
`benchmarks/r81/module-contracts/door-western.module.json` — a
`BuildingModuleContract` for the door: `moduleType:door`, `hinge-left` pivot,
`frame` socket accepting `wall`, `blocksWhenClosed/passesWhenOpen`, states
`[closed,opening,open,closing]` initial `closed`, persistence
`identityFrom:actorName`, `stateFields:[state,yawAngle]`, `schemaVersion:1`.
**Valid on first attempt** — `MODEL_CONTRACT_VALID`, 1 request
(`model-module-contract-1791727237066.json`). Post-processed only to correct
`provenance.modelId` (model self-reported `nemotron-3-8b-instruct`) and fill
`engines` per the prompt; raw output preserved in the evidence file. The new
`BuildingModuleContract` schema (`packages/forge-aaa/src/module-contract.ts`)
is the Track-B contract for future wall/window/stair/storage/furniture modules,
validated by `validateModuleContract` with 5 unit tests.

## Independent review

5 attempts were required; evidence files preserve all of them:

| Attempt | Evidence | Outcome |
|---|---|---|
| 1 | `...-1791727353528.json` | 503 upstream overloaded |
| 2 | `...-1791727405472.json` | 60s stream timeout, 0 events |
| 3 | `...-1791727606796.json` | 60s stream timeout, 0 events |
| 4 | `...-1791727749672.json` | streamed 89 events then dropped mid-JSON — malformed, `independent:false` |
| 5 | `...-1791727845848.json` | **`INDEPENDENT_REVIEW_COMPLETED`, verdict pass, approved, independent** |

Reviewer findings (all advisory): F1 only two door instances ("multiple"
satisfied, broader stress not shown); F2 synthetic input injection rather than
physical keyboard (dispatch path is real and `inputClass` honestly recorded);
F3 scripted `AddMovementInput` rather than NavMesh.

## Phase H — free capacity delta

`phase-h-capacity-delta-1791727704467.json`, policy `VERIFIED` at probe time.

- kilo-free-direct: 12 `:free` models — **identical set** to the R80 baseline
  (0 added, 0 removed). No new coding-credible candidates → zero inference spent.
- blockrun: free count 2→1 — `poolside/laguna-xs-2.1` left the free tier;
  remaining `nvidia/llama-3.2-11b-vision` is chat/vision (negative for coding).
- Quota domains unchanged: kilo = single anonymous domain; provider redundancy
  still absent. `CODEFORGE_R76_PARTIAL` preserved.

## Regression vs R80 baseline

- `packages/forge-aaa`: 92 passed / 5 skipped (live-gated) — includes 5 new
  module-contract tests.
- `packages/eight-bit`: 424 passed / 2 skipped.
- `packages/forge-zero`: 174 passed.
- `npm run build` clean across model-registry, providers, forge-aaa.
- Production diff: `unreal.ts` +171 (additive method), `index.ts` +1,
  `module-contract.ts` +193 (new). No routing, spending, or gate logic touched.
- Repo fixture `benchmarks/r81/forge-gameplay-plugin/` `diff -r`-verified
  identical to the live-tested plugin source (excluding engine caches).

## Inference spend

4 model calls this session: 1 module-contract generation ($0), 5 review calls
($0 — retries were failed streams, no completed paid inference). All free-tier.

## Honest limitations

- Presses inject `SYNTHETIC_INPUT` via `PlayerInput::InputKey` — the real
  dispatch path, but not a physical keyboard. `inputClass` is recorded in every
  press record.
- `moveTo` is scripted `AddMovementInput` — real CharacterMovement physics, no
  NavMesh pathing claim.
- Two door instances satisfy "multiple"; broader instance-count stress is not
  demonstrated.
- One `BuildingModuleContract` authored (door). Walls/windows/stairs/storage/
  furniture contracts and a multi-module building are future work.
- The live Unreal project is outside git; `benchmarks/r81/forge-gameplay-plugin/`
  is the canonical fixture and must be mirrored into the project before live
  runs.
- `pythonModuleLoaded:true` records that the Unreal Python module exists in the
  runtime; it drove no gameplay action (the driver is native C++).
- Reviewer model identity in the authored contract was self-reported incorrectly
  by the model and corrected post-hoc — the correction is logged in the evidence
  file, raw output preserved.

## Next milestone candidates

- NavMesh/AIController traversal variant and physical-input (or UInputInjector)
  press variant.
- Wall/floor/foundation module contracts + socket assembly into an actual
  enclosed room; storage/furniture `IForgeInteractable` implementations.
- Second quota-independent Coder route (catalog rotates; delta probe is cheap).
