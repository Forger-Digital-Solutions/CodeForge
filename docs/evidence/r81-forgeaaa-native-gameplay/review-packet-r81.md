# R81 MILESTONE REVIEW PACKET

## Declared requirements
- A reusable native Unreal door actor implements a documented interaction contract (`IForgeInteractable`)
- Players interact through the native gameplay input path (ActionMapping `ForgeInteract` = E, dispatched via `PlayerInput`, range- and line-of-sight-gated targeting)
- The door leaf physically opens/closes by rotating about a real hinge pivot; commanded yaw and observed component yaw are both recorded and must agree
- Each placed instance carries durable per-instance identity and independent state
- State persists through a real `USaveGame` slot and restores after in-process map reload AND separate-process engine launch
- Multiple door instances on one map keep independent records
- Malformed/corrupt/unsupported save data fails safe (defaults to closed, no crash)
- No Python drives gameplay; Python is used only for development-time map authoring
- Reusable module contract for future walls/windows/stairs exists and is schema-validated

## Executor final report
<<<REPORT>>>
# R81 — ForgeAAA Native Gameplay + Persistent Interactive Buildings

**Branch:** `codex/r81-forgeaaa-native-gameplay`
**Base:** `083c674b` (published R80 head)
**Engine:** Unreal Engine 4.27.2 (`4.27.2-18319896+++UE4+Release-4.27`), Dead Trails West pilot
**New code:** `ForgeGameplay` Unreal plugin (native C++), `UnrealAdapter.runNativeGameplayTest`, `BuildingModuleContract` schema

## Architecture delivered

- `IForgeInteractable` — native interface: `ForgeInteract(instigator)`, `ForgeInteractableName()`
- `AForgeInteractableDoor` — AActor with `DoorRoot → HingePivot(edge) → LeafMesh(offset)` hierarchy; state machine `closed → opening → open → closing`; tick-lerped leaf; per-instance `ForgeInstanceId` defaulting to the placed actor name; persists only stable states; restores from `UForgeDoorSaveGame`; normalizes malformed/transitional records to closed
- `UForgeDoorSaveGame` — schema-versioned `TMap<FString, Record{state, leafYawDeg}>`, dedicated slot `ForgeR81DoorTest`
- `AForgeInteractCharacter` — possessed character; project-level `DefaultInput.ini` binds `ForgeInteract`=E plus WASD axes; forward sphere sweep aims by **control rotation** (camera); records dispatch flag, target identity, sweep hits, distance
- `AForgeDoorTestDriver` — map-placed verifier; executes bounded JSON action spec (1–96 ops): face, moveTo, press, wait, probe, expectDoor, save, slotVerify, reloadMap, corruptSave, deleteSave, exit; writes the authoritative JSON report with `runId` binding (stale reports rejected)
- `UnrealAdapter.runNativeGameplayTest` — launches `UE4Editor.exe <project> <map> -game -unattended -ForgeDriverSpec=...`; reads the native report; **no Python startup injection during gameplay** (R80's harness injected `StartupScripts`; R81 does not)

## Live evidence (native-door-live-1791726964164.json — three separate engine processes)

**Stage 1 (45 actions, pass):**
- Action 2: `press E` at y=-150, ~150cm from door A → `dispatched:false`, `sweepHits:[]` — out-of-range input genuinely rejected
- Action 5: `press` at 34.26cm → `dispatched:true`, `targetName:FAAA_door-western-a`
- Action 7: door A `expectDoor open` → `obsYawDeg:-95, hingeYawDeg:-95, cmdYawDeg:-95` (commanded == observed)
- Action 8: probe through open doorway → `blockingHit:false`
- Action 10/11: character traverses through the doorway both directions
- Action 13: `press` at 27.50cm from the other side → dispatched → closes
- Action 15/16: `expectDoor closed` (yaw 0); probe `blockingHit:true` on `LeafMesh`
- Action 17: moveTo toward the closed door stalls at y=-36.5 (physical block)
- Actions 20–26: reopen + traverse again (repeatable operation)
- Actions 30–36: door B independently opened (`obsYaw -95`) and closed — separate instance
- Action 37/38: `save` → `slotVerify` → `ForgeR81DoorTest` exists, `schemaVersion:1`, records for BOTH `door-western-a` and `door-western-b`
- Action 39–41: `reloadMap` (real `OpenLevel`) → A restored `open` (-95), B restored `closed` (0) — independent state restored
- Action 42: probe on door B closed plane → `blockingHit:true`

**Stage 2 (31 actions, separate process, pass):**
- Actions 0–1: fresh process restore — A `open`/-95, B `closed`/0 from SaveGame
- Action 3: traversal through the restored open door (end y=18.59, past door plane)
- Actions 6–15: close A via input (observed transition to closed, yaw 0), physical block confirmed (stalled moveTo), reopen
- Actions 19–26: door B open/close cycle independently; A verified still open
- Action 27–28: save + slotVerify with both records
- Action 29: `corruptSave` writes garbage bytes to the slot before exit (intentional)

**Stage 3 (5 actions, third process, pass):**
- Action 0: `slotVerify` → `slotExists:true, loaded:false` — corrupt save detected and rejected
- Action 1: door A `expectDoor closed` pass — fail-safe default, no crash
- Actions 2–3: `deleteSave` ok; `slotVerify` → `slotExists:false`

`pythonModuleLoaded:true` means the Unreal Python module exists in the runtime; all gameplay actions above were executed by the native `ForgeDoorTestDriver` — Python performed map authoring only (development time).

## Model-directed artifact (bounded)

`nvidia/nemotron-3-super-120b-a12b:free` (Coder-qualified) authored
`benchmarks/r81/module-contracts/door-western.module.json` — a
`BuildingModuleContract` (moduleType `door`, hinge-left pivot, `frame` socket accepting
`wall`, `blocksWhenClosed:true`/`passesWhenOpen:true`, IForgeInteractable states
`closed/opening/open/closing` initial `closed`, persistence `identityFrom:actorName`,
`stateFields:[state,yawAngle]`, schemaVersion 1). Valid on first attempt;
schema-validated by `validateModuleContract`. Post-processed only to correct
`provenance.modelId` (model self-reported `nemotron-3-8b-instruct`) and fill `engines`
from the prompt — raw output preserved in the evidence report
(`model-module-contract-1791727237066.json`, status `MODEL_CONTRACT_VALID`, 1 request).

## Known limitations declared by executor

- Presses use `SYNTHETIC_INPUT` (`PlayerInput::InputKey` injected by the test driver) — the real input dispatch path (ActionMapping→binding→handler), not a human keyboard; `inputClass` is recorded honestly in every press record
- `moveTo` uses `AddMovementInput` (real CharacterMovementComponent physics) — pathing is scripted, not NavMesh
- Two door instances on one map; one module contract authored so far
- Test driver is a placed actor in the test map (instrumentation); the map binds `ForgeGameplayMode` at WorldSettings
- The interactive door is the first `IForgeInteractable` implementation; windows/storage/furniture contracts are future modules
- The live Unreal project is outside the git worktree; plugin source is committed as a repo fixture under `benchmarks/r81/forge-gameplay-plugin/` and must be mirrored to the project before live runs

## Question
Does the evidence support R81_NATIVE_GAMEPLAY_VERIFIED — native input-driven interaction, observed hinge rotation, per-instance SaveGame persistence across reload and process restart, independent multi-instance state, and fail-safe corrupt-save behavior — and do any blocking defects or false-positive paths invalidate it?
