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
npm run build                           # build packages/forge-aaa/dist
node benchmarks/r83/init-r83-pilot.mjs  # create .scratch/r83pilot (runs once)
& benchmarks/r82/build-pilot.ps1        # compile ForgeGameplay plugin for r83pilot
# (edit build-pilot.ps1 to point at .scratch/r83pilot if needed)
node benchmarks/r83/r83-assets-live.mjs # Blender generation + UE4.27 import
node benchmarks/r83/r83-assemble-live.mjs # two-room assembly + migration
node benchmarks/r83/r83-gameplay-live.mjs # native gameplay + SaveGame restore
```

## New R83 modules

| Module | Dimensions (cm) | Purpose |
|--------|-----------------|---------|
| SM_DoorThreshold | 110×20×10 | Floor threshold spanning shared wall gap |
| SM_SharedWall_Front | 20×225×260 | Shared wall south of doorway |
| SM_SharedWall_Back | 20×225×260 | Shared wall north of doorway |
| SM_SharedWall_Lintel | 110×20×45 | Lintel above interior doorway |
| SM_FrontWall_B | 560×20×260 | Room B front and back walls |
| SM_Ceiling_B | 580×560×10 | Room B ceiling |

## Level paths

- One-room source: `/Game/ForgeAAA/Maps/FAAA_R83_RoomA`
- Two-room target: `/Game/ForgeAAA/Maps/FAAA_R83_TwoRoom`

## Evidence

All run artifacts are written to `docs/evidence/r83-forgeaaa-autonomous-multiroom/`.

See `R83-FINAL-REPORT.md` for gate status.
