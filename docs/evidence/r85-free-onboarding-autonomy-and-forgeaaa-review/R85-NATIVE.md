# R85 native Unreal Engine verification

Environment: UE 4.27.2 (`UE4Editor.exe`), Blender 4.5 present. Pilot: isolated copy of the R84 pilot project (`r84pilot` → `.scratch/r85pilot`; Binaries/Config/Content/Plugins/Source/uproject). Source content preservation verified by SHA-256 manifest — 39/39 files byte-identical before and after (`native/preservation.json`, status VERIFIED).

## migration-fault-campaign — PASS (184s, 9/9 cases)

Receipt `native/migration-fault-campaign-1791758206628.json`. Real `.umap` mutations against the engine:

- `missing-mesh`, `source-conflict`: BLOCKED before mutation, source hash preserved.
- `fault-after-three` (injected fault after 3 mutations): ROLLED_BACK, source hash preserved, separate-process readback confirmed rollback state.
- `interrupted` (controlled partial-save interruption, exitCode 86): durable receipt recorded INTERRUPTED; `interrupted-recovery` rolled back in a later process, `recoveredInterrupted:true`.
- `caller-evidence`: caller-forged boolean and copied-rollback evidence both rejected BLOCKED.
- `commit-before-repeat`: strict COMMITTED; `idempotency-repeat` produced no duplicate instances (23 instances) and an identical level hash.
- `separate-process-commit`: fresh-process readback COMMITTED.

## persistence-upgrade-live — PASS (3/3 native stages)

Receipt `native/persistence-upgrade-1791758824636.json`. Native C++ PlayerInput + CharacterMovement + SaveGame (no mocks):

- `pre-upgrade`: assembled one-room source, door open/close + window interact, SaveGame slot saved and slot-verified (door=2, window=2).
- Migration R82→R83 (one room → two rooms) applied, validated, committed; separate-process readback COMMITTED.
- `post-upgrade`: migrated level re-verified — saved door/window restored open, interior door interacts (close/open), re-saved with 2 doors + 1 window.
- `upgrade-fresh-process`: fresh editor process — all states restored from slot (door=2, interior=2, window=2), traversal through both rooms, interior-door close/reopen cycle, blocking probe across a doorway, exit.

### Waypoint choreography note

The return-leg `moveTo [0,-140,96]` stalled at the door-frame edge in 3 of 4 attempts across R84+R85 (telemetry: `stalled:true` at Y≈-4). All functional assertions passed in every run — the stall was navigation choreography, not persistence/migration behavior. Per the R84-documented precedent the exit leg was made robust by inserting a door-centerline waypoint (`[0,-10,96]`); the stage then passed on first attempt. Earlier stall-only receipts retained: `persistence-upgrade-1791758390641.json`, `persistence-upgrade-1791758595391.json`.
