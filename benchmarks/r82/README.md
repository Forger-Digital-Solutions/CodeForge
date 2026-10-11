# R82 modular Western interior fixture

This is an isolated engineering pilot, not the authored Dead Trails West farmhouse. R81 source and evidence remain under `benchmarks/r81` and its historical evidence directory. The R82 plugin is an additive copy: the existing interactable interface, character, door, and SaveGame class are retained, with a native sliding window and evidence driver additions.

Prerequisites: Windows, Node 22.5 or newer (tested with Node 24.19), npm, Blender 4.5, Unreal Engine 4.27.2, and a working Visual Studio C++ toolchain. This run used the installed VS Community 14.51 compiler and Windows SDK 10.0.26100. No local LLM is used.

From the repository root, create a fresh pilot, build it, generate original meshes, import them, and assemble both building identities:

```powershell
npm install --ignore-scripts
npm run typecheck
npm run build
node benchmarks/r82/init-pilot.mjs
& benchmarks/r82/build-pilot.ps1
node benchmarks/r82/interior-live.mjs assets
node benchmarks/r82/interior-live.mjs assemble
node benchmarks/r82/gameplay-live.mjs
node benchmarks/r82/assembly-recovery-live.mjs
```

The initializer refuses an existing pilot. It creates only `.scratch/pilot`, uses a workspace-local derived-data cache, and copies the versioned project skeleton and plugin. The native build script uses a stable temporary directory and disables cached UBT makefiles; old temporary paths caused observed linker failures. Run Unreal processes and native builds sequentially. Do not point these scripts at an authored project.

`assets` regenerates the FBX files and their content hashes, then writes the module registry and building definition. Apply it before the first assembly. An existing assembly rejects a different fingerprint; regeneration is not a silent migration of an already placed building. Keep the current generated files for repeated assembly checks, or create a fresh isolated pilot for a new generation.

The saved map is `/Game/ForgeAAA/Maps/FAAA_R82InteriorV2`. Each building uses 14 independently identified modules. The primary room is 560 × 520 cm internally, 260 cm high, with 20 cm walls, a 10 cm floor, a 110 × 215 cm doorway, and a 120 × 140 cm sash window at a 90 cm sill. Door and window openings remain the certified prototype sizes. `room-spec.mjs` derives structural lengths and placement from configurable footprint, height, thickness, and sill values; incompatible opening sizes are rejected. A 600 × 600 × 280 cm alternative passed schema/geometry checks only.

To play manually, open `.scratch/pilot/DeadTrailsWest.uproject`, load the map, and press Play. WASD moves; mouse axes turn/look; E uses the native interaction sweep. Approach a door or window and aim at reachable geometry. The sill legitimately blocks low window targeting. The test driver remains idle without `-ForgeDriverSpec`. A dedicated manual save slot can be supplied with `-ForgeSaveSlot=ForgeR82Manual`. Without that argument the historical default slot is retained. The recorded gameplay campaign uses synthetic PlayerInput and scripted movement; it is not a human playtest.

The window uses `WindowRoot → SlidePivot → SashMesh`, travels 65 cm, and retains physical collision while moving. It shares `IForgeInteractable`, the E mapping, and `UForgeDoorSaveGame`. Schema 1 keeps the unchanged Doors map and adds a versioned Windows map. No second SaveGame system exists.

`gameplay-live.mjs` starts four actual game processes: room gameplay and reload, fresh-process restoration and continued interaction, invalid per-window record rejection, and corrupt-file fallback. Native render targets export actual PNG captures. The dedicated campaign slot is reset at the beginning and cleaned up at the end. JSON reports retain every measured action; missing assertions, captures, stale reports, process failures, and incomplete scenarios cannot pass.

The real-model QA contribution and raw replies are preserved separately from the final corrected test. `model-artifact-corrections.json` records two deterministic horizontal-probe corrections after a bounded free-model repair timed out. Native C++ and room construction were implemented by the external engineering agent. The Director routed and durably tracked the model QA task; its generation-only runs remain partial or failed. The complete building pipeline is not claimed to be fully autonomous.

The compatibility test used a copied, preserved R81 native binary to write an actual old save, then read it with the R82 binary. Its historical map and generated door assets were copied into isolated pilots. `compatibility-live.mjs` expects that `.scratch/legacy` setup; its prerequisites are deliberately separate from the default fresh R82 setup. To recreate the legacy writer from source, use the R81 plugin fixture, R81 map builder, and generated door meshes in another isolated project, compile it, and keep its default `ForgeR81DoorTest` slot. Never modify the historical external pilot.

Stairs use option C: a separate copied `/Game/ForgeAAA/Maps/FAAA_Traversal` validation area. `stair-regression-live.mjs` expects the preserved R79 map and generated stair assets in the pilot, runs the legacy Python traversal adapter, and checks configuration restoration. The six-step 108 cm rise is not represented as a second-story staircase. It is not part of the native room interaction campaign.

Binary engine assets, caches, intermediate files, and project binaries stay in `.scratch`. Versioned sources, geometry recipes, contracts, reports, native build logs, model receipts, and PNG captures provide the delivery evidence. See `docs/evidence/r82-forgeaaa-modular-western-interior/R82-FINAL-REPORT.md` for exact status and remaining limits.
