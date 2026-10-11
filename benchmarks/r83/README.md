# R83 Modular Two-Room Connected Western Building

Isolated engineering pilot for ForgeAAA R83. Not the authored Dead Trails West farmhouse.

Extends the R82 one-room building with a connected second room, shared interior doorway,
floor threshold, interior door at yaw=90°, and live migration from the R82 baseline.

## Prerequisites

- Windows 11
- Node 22.5+ (tested Node 24.x)
- npm
- Blender 4.5 at `C:\Program Files\Blender Foundation\Blender 4.5\blender.exe`
- Unreal Engine 4.27 at `C:\Program Files\Epic Games\UE_4.27`
- Working Visual Studio C++ toolchain (for R83 pilot native build)
- R82 worktree at `G:\CodeForge\worktrees\r82-forgeaaa-modular-western-interior`
  with a built pilot at `.scratch\pilot` (provides R82 FBX assets and compiled binaries)

## Execution order

```powershell
# From r83 worktree root
node G:/CodeForge/node_modules/typescript/bin/tsc -b packages/forge-aaa
node benchmarks/r83/init-r83-pilot.mjs  # create .scratch/r83pilot (runs once)
& benchmarks/r83/build-r83-pilot.ps1     # compile the separate R83 native plugin
node benchmarks/r83/r83-assets-live.mjs # verify existing assets; generate only when absent
node benchmarks/r83/r83-assemble-live.mjs # two-room assembly + migration
node benchmarks/r83/r83-gameplay-live.mjs # native gameplay + SaveGame restore
node benchmarks/r83/migration-fault-campaign.mjs # preflight rejection, rollback, interrupted recovery
node benchmarks/r83/persistence-upgrade-live.mjs # native SaveGame before/after migration
```

## New R83 modules

| Module | Dimensions (cm) | Purpose |
|--------|-----------------|---------|
| SM_DoorThreshold | 20×110×10 | Floor threshold spanning shared wall gap |
| SM_SharedWall_Front | 20×225×260 | Shared wall south of doorway |
| SM_SharedWall_Back | 20×225×260 | Shared wall north of doorway |
| SM_SharedWall_Lintel | 20×110×45 | Lintel above interior doorway |
| SM_FrontWall_B | 560×20×260 | Room B front and back walls |
| SM_Ceiling_B | 580×560×10 | Room B ceiling |

## Level paths

- Each campaign uses a unique owned map beneath `/Game/ForgeAAA/Maps` and its own SaveGame slot.
- Assembly migrates its source map in place and independently reopens it for strict verification.

The actual Director repair run completed its tools and native gameplay after a durable
checkpoint. It reused the complete qualified model proposal with three disclosed
dimension-based repairs. `director-live.mjs --prepare --reuse-model-artifact` checkpoints
that proposal; `--resume` reuses successful artifacts. Two originating layout attempts
are preserved. The user approved the Kilo layout/review payloads; every new inference
still requires current ForgeZero admission. Review failures keep certification partial.

## Evidence

All run artifacts are written to `docs/evidence/r83-forgeaaa-autonomous-multiroom/`.

See [R83-FINAL-REPORT.md](../../docs/evidence/r83-forgeaaa-autonomous-multiroom/R83-FINAL-REPORT.md) for gate status.
