import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { UnrealAdapter } from "@codeforge/forge-aaa";

/**
 * R81 — native door pipeline:
 *   1. build FAAA_NativeDoorTest via editor Python (dev automation)
 *   2. stage 1 — full native interaction scenario in -game mode (no Python):
 *      out-of-range reject → approach → E-press open → passage → face+press close →
 *      reverse block → reopen → return passage → save → in-process reload → verify
 *   3. stage 2 — separate -game process: door state restored from SaveGame,
 *      character passes through, door closes + auto-persists, slot verified,
 *      then the save is corrupted on purpose
 *   4. stage 3 — third process: corrupt save fails safe (default closed,
 *      no crash), dedicated slot cleaned up
 * Every stage lands as evidence JSON.
 */

const DTW_DIR = process.env.FORGE_AAA_PROJECT_DIR ?? "C:\\Users\\Daddy_FDS\\Documents\\ChatGPT\\Dead Trails West";
const DTW_UPROJECT = path.join(DTW_DIR, "DeadTrailsWest.uproject");
const LEVEL = "/Game/ForgeAAA/Maps/FAAA_NativeDoorTest";
const MAP_BUILD = "benchmarks/r81/map-build-native.py";
const EVIDENCE_DIR = "docs/evidence/r81-forgeaaa-native-gameplay";
const SCRATCH = ".scratch/native";

const evidence = { startedAt: new Date().toISOString(), phases: {} };
const file = `${EVIDENCE_DIR}/native-door-live-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(evidence, null, 2));

const unreal = new UnrealAdapter();
const det = await unreal.detect();
const ue427 = det.installs.find((i) => i.version.major === 4 && i.version.minor === 27);
if (!ue427) throw new Error("no UE 4.27 install");
evidence.engine = { root: ue427.root, version: ue427.version };
await mkdir(SCRATCH, { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

// Phase 1 — build the native test map.
{
  const run = await unreal.runPythonScript({
    projectPath: DTW_UPROJECT,
    scriptPath: path.resolve(MAP_BUILD),
    logPath: path.resolve(`${SCRATCH}/map-build.log`),
    timeoutMs: 300_000,
    install: ue427,
    host: "editor",
  });
  evidence.phases.mapBuild = { ok: run.ok, report: run.report, error: run.error };
  await persist();
  if (!run.ok || run.report?.ok === false) throw new Error("MAP_BUILD_FAILED: " + JSON.stringify(run.report ?? run.error));
}

// Phase 2 — stage 1: full native interaction scenario.
{
  const run = await unreal.runNativeGameplayTest({
    projectPath: DTW_UPROJECT,
    levelPath: LEVEL,
    specPath: path.resolve(`${SCRATCH}/driver-spec-stage1.json`),
    reportPath: path.resolve(`${SCRATCH}/driver-report-stage1.json`),
    checkpointPath: path.resolve(`${SCRATCH}/driver-checkpoint.json`),
    actions: [
      { op: "expectDoor", door: "door-western-a", state: "closed" },
      { op: "face", target: [0, 0, 90] },
      { op: "press", key: "E", expect: { dispatched: false } },                       // out of range from spawn (150cm)
      { op: "moveTo", target: [40, -70, 92], timeoutS: 15, expect: { arrived: true } }, // east of door — outside the 96cm hinge-swing arc
      { op: "face", target: [0, 0, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // native input → interact
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-a", state: "open" },
      { op: "probe", from: [0, -40, 100], to: [0, 80, 100], expect: { blockingHit: false } },
      { op: "moveTo", target: [0, -30, 92], timeoutS: 15, expect: { arrived: true } }, // line up with doorway center
      { op: "moveTo", target: [0, 120, 92], timeoutS: 15, expect: { arrived: true, minEndY: 100 } }, // through doorway
      { op: "moveTo", target: [0, -140, 92], timeoutS: 15, expect: { arrived: true, maxEndY: -120 } }, // back south — bidirectional
      { op: "face", target: [-52, -60, 90] },                                          // aim at the open leaf in the south room
      { op: "press", key: "E", expect: { dispatched: true } },                        // close — char 148cm from hinge, outside swing
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-a", state: "closed" },
      { op: "probe", from: [0, -150, 100], to: [0, 30, 100], expect: { blockingHit: true } }, // closed leaf blocks south side
      { op: "moveTo", target: [0, 60, 92], timeoutS: 10, expect: { arrived: false } }, // blocked ~-36 by the closed leaf
      { op: "moveTo", target: [40, -70, 92], timeoutS: 15, expect: { arrived: true } }, // reposition east — escapes any slide pocket
      { op: "face", target: [0, 0, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // reopen — repeated use
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-a", state: "open" },
      { op: "moveTo", target: [0, -30, 92], timeoutS: 15, expect: { arrived: true } },
      { op: "moveTo", target: [0, 60, 92], timeoutS: 15, expect: { arrived: true, minEndY: 40 } }, // passage north again
      { op: "moveTo", target: [0, -140, 92], timeoutS: 15, expect: { arrived: true, maxEndY: -120 } }, // passage south again
      { op: "moveTo", target: [0, -30, 92], timeoutS: 15, expect: { arrived: true } },
      { op: "moveTo", target: [0, 700, 92], timeoutS: 25, expect: { arrived: true } }, // through open A, north to door B
      { op: "moveTo", target: [40, 730, 92], timeoutS: 10, expect: { arrived: true } }, // east of B — outside swing arc
      { op: "face", target: [0, 800, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // door B opens — second instance
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-b", state: "open" },
      { op: "face", target: [-52, 760, 90] },                                         // aim at open leaf B
      { op: "press", key: "E", expect: { dispatched: true } },
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-b", state: "closed" },
      { op: "save", expect: { minSavedDoors: 2 } },
      { op: "slotVerify", expect: { slotExists: true, loaded: true, doorStates: { "door-western-a": 2, "door-western-b": 0 } } },
      { op: "reloadMap" },
      { op: "expectDoor", door: "door-western-a", state: "open" },                    // restored in-process
      { op: "expectDoor", door: "door-western-b", state: "closed" },                  // independent instance state
      { op: "probe", from: [0, 760, 100], to: [0, 880, 100], expect: { blockingHit: true } },
      { op: "moveTo", target: [0, 60, 92], timeoutS: 15, expect: { arrived: true, minEndY: 40 } }, // passage through restored-open A
      { op: "exit" },
    ],
    logPath: path.resolve(`${SCRATCH}/native-stage1.log`),
    timeoutMs: 420_000,
    install: ue427,
  });
  evidence.phases.stage1 = { state: run.state, actionMetrics: run.actionMetrics, metrics: run.metrics, pythonModuleLoaded: run.pythonModuleLoaded };
  await persist();
}

// Phase 3 — stage 2: separate process, restored gameplay + corrupt-on-exit.
{
  const run = await unreal.runNativeGameplayTest({
    projectPath: DTW_UPROJECT,
    levelPath: LEVEL,
    specPath: path.resolve(`${SCRATCH}/driver-spec-stage2.json`),
    reportPath: path.resolve(`${SCRATCH}/driver-report-stage2.json`),
    actions: [
      { op: "expectDoor", door: "door-western-a", state: "open" },                    // BeginPlay restore — separate process
      { op: "expectDoor", door: "door-western-b", state: "closed" },
      { op: "probe", from: [0, -40, 100], to: [0, 80, 100], expect: { blockingHit: false } }, // open collision restored
      { op: "moveTo", target: [0, 30, 92], timeoutS: 15, expect: { arrived: true, minEndY: 5 } }, // through restored-open A — past door plane
      { op: "moveTo", target: [0, -140, 92], timeoutS: 15, expect: { arrived: true, maxEndY: -120 } }, // back south — bidirectional
      { op: "face", target: [-52, -60, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // close A from the open-leaf side
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-a", state: "closed" },
      { op: "moveTo", target: [0, 60, 92], timeoutS: 10, expect: { arrived: false } }, // closed leaf blocks
      { op: "moveTo", target: [40, -70, 92], timeoutS: 15, expect: { arrived: true } },
      { op: "face", target: [0, 0, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // reopen A
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-a", state: "open" },
      { op: "moveTo", target: [0, -30, 92], timeoutS: 15, expect: { arrived: true } },
      { op: "moveTo", target: [0, 700, 92], timeoutS: 25, expect: { arrived: true } }, // through open A
      { op: "moveTo", target: [40, 730, 92], timeoutS: 10, expect: { arrived: true } },
      { op: "face", target: [0, 800, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // open B — per-instance independence
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-b", state: "open" },
      { op: "face", target: [-52, 760, 90] },
      { op: "press", key: "E", expect: { dispatched: true } },                        // close B
      { op: "wait", durationS: 1.5 },
      { op: "expectDoor", door: "door-western-b", state: "closed" },
      { op: "expectDoor", door: "door-western-a", state: "open" },                    // A unaffected by B
      { op: "save", expect: { minSavedDoors: 2 } },
      { op: "slotVerify", expect: { slotExists: true, loaded: true, doorStates: { "door-western-a": 2, "door-western-b": 0 } } },
      { op: "writeCorruptSave" },
      { op: "exit" },
    ],
    logPath: path.resolve(`${SCRATCH}/native-stage2.log`),
    timeoutMs: 300_000,
    install: ue427,
  });
  evidence.phases.stage2 = { state: run.state, actionMetrics: run.actionMetrics, metrics: run.metrics, pythonModuleLoaded: run.pythonModuleLoaded };
  await persist();
}

// Phase 4 — stage 3: corrupt save resilience + slot cleanup.
{
  const run = await unreal.runNativeGameplayTest({
    projectPath: DTW_UPROJECT,
    levelPath: LEVEL,
    specPath: path.resolve(`${SCRATCH}/driver-spec-stage3.json`),
    reportPath: path.resolve(`${SCRATCH}/driver-report-stage3.json`),
    actions: [
      { op: "slotVerify", expect: { slotExists: true } },                             // file exists, content garbage
      { op: "expectDoor", door: "door-western-a", state: "closed" },                  // fails safe → default
      { op: "deleteSave" },
      { op: "slotVerify", expect: { slotExists: false } },
      { op: "exit" },
    ],
    logPath: path.resolve(`${SCRATCH}/native-stage3.log`),
    timeoutMs: 240_000,
    install: ue427,
  });
  evidence.phases.stage3 = { state: run.state, actionMetrics: run.actionMetrics, metrics: run.metrics, pythonModuleLoaded: run.pythonModuleLoaded };
  await persist();
}

evidence.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({
  file,
  mapBuild: evidence.phases.mapBuild?.ok,
  stage1: evidence.phases.stage1?.state,
  stage2: evidence.phases.stage2?.state,
  stage3: evidence.phases.stage3?.state,
  pythonModuleLoaded: evidence.phases.stage1?.pythonModuleLoaded,
}));
