import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { UnrealAdapter, BlenderAdapter, doorBlenderScript, validateDoorSpec } from "@codeforge/forge-aaa";

/**
 * R80 GATES 5-8 — live UE4.27 door pipeline: model-authored doorSpec → Blender FBX →
 * ImportAssets → placed door assembly (frame+leaf in a walled test level) → game-world
 * interaction scenarios (closed block / open / passage / close / re-block / repeat) →
 * separate-process persistence proof. Every phase lands as evidence JSON.
 */

const DTW_DIR = process.env.FORGE_AAA_PROJECT_DIR ?? "C:\\Users\\Daddy_FDS\\Documents\\ChatGPT\\Dead Trails West";
const DTW_UPROJECT = path.join(DTW_DIR, "DeadTrailsWest.uproject");
const LEVEL = "/Game/ForgeAAA/Maps/FAAA_DoorTest";
const EVIDENCE_DIR = "docs/evidence/r80-forgeaaa-autonomous-gameplay";
const SCRATCH = ".scratch/door";

const evidence = { startedAt: new Date().toISOString(), phases: {} };
const file = `${EVIDENCE_DIR}/door-live-${Date.now()}.json`;
const persist = () => writeFile(file, JSON.stringify(evidence, null, 2));

const specFile = process.argv[2];
if (!specFile) throw new Error("usage: door-live.mjs <model-door-spec evidence json>");
const specDoc = JSON.parse(await readFile(specFile, "utf8"));
const spec = validateDoorSpec(specDoc.doorSpec);
evidence.spec = spec;
evidence.specSource = specFile;

const unreal = new UnrealAdapter();
const blender = new BlenderAdapter();
const det = await unreal.detect();
const ue427 = det.installs.find((i) => i.version.major === 4 && i.version.minor === 27);
if (!ue427) throw new Error("no UE 4.27 install");
evidence.engine = { root: ue427.root, version: ue427.version };
await mkdir(SCRATCH, { recursive: true });

// Phase 1 — Blender geometry from the model-authored spec.
{
  const glb = path.join(SCRATCH, "door.glb");
  const fbx = path.join(SCRATCH, "door.fbx");
  const run = await blender.runHeadless({ op: "custom", scriptSource: doorBlenderScript(spec), approved: true, args: [glb, fbx], timeoutMs: 300_000 });
  evidence.phases.blender = { ok: run.ok, report: run.report, glb, fbx, exists: { glb: existsSync(glb), fbx: existsSync(fbx) } };
  await persist();
  if (!run.ok || !evidence.phases.blender.exists.fbx) throw new Error("BLENDER_GENERATION_FAILED");
}

// Phase 2 — UE4.27 ImportAssets → /Game/ForgeAAA.
{
  const settingsPath = path.resolve(`${SCRATCH}/import-settings.json`);
  const contentDir = path.join(DTW_DIR, "Content");
  const before = existsSync(contentDir) ? await readdir(contentDir) : [];
  const run = await unreal.importAssets({
    projectPath: DTW_UPROJECT, files: [path.resolve(`${SCRATCH}/door.fbx`)],
    destinationPath: "/Game/ForgeAAA", groupName: "ForgeAAA", settingsPath, timeoutMs: 300_000, install: ue427,
  });
  const after = existsSync(contentDir) ? await readdir(contentDir) : [];
  const forgeDir = path.join(contentDir, "ForgeAAA");
  const assets = existsSync(forgeDir) ? (await readdir(forgeDir)).filter((f) => f.includes("Door")) : [];
  evidence.phases.import = { result: { ok: run.ok, exitCode: run.exitCode, error: run.error }, newTopLevel: after.filter((f) => !before.includes(f)), doorAssets: assets };
  await persist();
  if (assets.length < 2) throw new Error("IMPORT_PRODUCED_NO_DOOR_ASSETS: " + JSON.stringify(assets));
}

// Phase 3 — placed door assembly in a walled test level (persisted by placeAssets' save).
{
  const scriptPath = path.resolve(`${SCRATCH}/place-door.py`);
  const OW = spec.opening.widthCm, OH = spec.opening.heightCm;
  const JW = spec.frame.jambWidthCm, PO = spec.hinge.pivotOffsetCm;
  const wallTop = OH + JW + 40;
  const hingeX = -(OW / 2 - PO) * (spec.hinge.side === "left" ? 1 : -1);
  const placements = [
    { name: "Door_Floor", assetPath: "/Engine/BasicShapes/Cube", location: [0, 0, -5], scale: [40, 40, 0.1] },
    { name: "Door_WallL", assetPath: "/Engine/BasicShapes/Cube", location: [-(OW / 2 + 100), 0, wallTop / 2], scale: [2, 0.2, wallTop / 100] },
    { name: "Door_WallR", assetPath: "/Engine/BasicShapes/Cube", location: [OW / 2 + 100, 0, wallTop / 2], scale: [2, 0.2, wallTop / 100] },
    { name: "Door_Lintel", assetPath: "/Engine/BasicShapes/Cube", location: [0, 0, (OH + JW + wallTop) / 2], scale: [(OW + 2 * JW) / 100, 0.2, (wallTop - OH - JW) / 100] },
    { name: "Door_Frame", assetPath: "/Game/ForgeAAA/door_SM_DoorFrame", location: [0, 0, 0] },
    { name: "Door_Leaf", assetPath: "/Game/ForgeAAA/door_SM_DoorLeaf", location: [hingeX, 0, 0], rotation: [0, 0, 0] },
  ];
  const run = await unreal.placeAssets({ projectPath: DTW_UPROJECT, levelPath: LEVEL, placements, scriptPath, logPath: path.resolve(`${SCRATCH}/place-door.log`), timeoutMs: 300_000, install: ue427 });
  evidence.phases.place = { ok: run.ok, placed: run.placed, errors: run.report?.errors ?? run.error };
  await persist();
  if (!run.ok || (run.placed?.length ?? 0) < placements.length) throw new Error("PLACEMENT_INCOMPLETE: " + JSON.stringify(run.report));
  evidence.hingeX = hingeX;
}

// Phase 4 — functional interaction scenario, real -game world.
{
  const hingeX = evidence.hingeX;
  const door = {
    leafAsset: "/Game/ForgeAAA/door_SM_DoorLeaf",
    hingeLocation: [hingeX, 0, 0],
    closedYawDeg: 0,
    openAngleDeg: spec.motion.openAngleDeg,
    transitionS: spec.motion.transitionS,
    probeCenter: [0, 0, 100],
  };
  const scriptPath = path.resolve(`${SCRATCH}/door-interact.py`);
  const logPath = path.resolve(`${SCRATCH}/door-interact.log`);
  const run = await unreal.runInteractionTest({
    projectPath: DTW_UPROJECT, levelPath: LEVEL, scriptPath, logPath,
    spawn: [0, -150, 92],
    door,
    actions: [
      { op: "move", direction: [0, 1, 0], durationS: 3.0, expect: { maxEndY: -10 } },
      { op: "interact", durationS: 1.5, expect: { doorState: "open" } },
      { op: "move", direction: [0, 1, 0], durationS: 3.0, expect: { minEndY: 60 } },
      { op: "interact", durationS: 1.5, expect: { doorState: "closed" } },
      { op: "move", direction: [0, -1, 0], durationS: 3.0, expect: { minEndY: 10 } },
      { op: "interact", durationS: 1.5, expect: { doorState: "open" } },
      { op: "move", direction: [0, -1, 0], durationS: 3.0, expect: { maxEndY: -60 } },
    ],
    timeoutMs: 300_000, install: ue427,
  });
  evidence.phases.interaction = { state: run.state, configRestored: run.configRestored, actionMetrics: run.actionMetrics, failures: run.metrics?.failures, errors: run.metrics?.errors, door: run.metrics?.door };
  await persist();
}

// Phase 5 — separate-process persistence: placed leaf actor found by label + driven.
{
  const scriptPath = path.resolve(`${SCRATCH}/door-persist.py`);
  const run = await unreal.runInteractionTest({
    projectPath: DTW_UPROJECT, levelPath: LEVEL, scriptPath,
    spawn: [0, -150, 92],
    door: {
      leafAsset: "/Game/ForgeAAA/door_SM_DoorLeaf",
      hingeLocation: [evidence.hingeX, 0, 0],
      closedYawDeg: 0, openAngleDeg: spec.motion.openAngleDeg, transitionS: spec.motion.transitionS,
      leafActorLabel: "Door_Leaf",
    },
    actions: [
      { op: "interact", durationS: 1.5, expect: { doorState: "open" } },
      { op: "interact", durationS: 1.5, expect: { doorState: "closed" } },
    ],
    timeoutMs: 300_000, install: ue427,
  });
  evidence.phases.persistence = { state: run.state, configRestored: run.configRestored, actionMetrics: run.actionMetrics, errors: run.metrics?.errors };
  await persist();
}

evidence.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ file, blender: evidence.phases.blender?.ok, import: evidence.phases.import?.doorAssets, place: evidence.phases.place?.placed?.length, interaction: evidence.phases.interaction?.state, persistence: evidence.phases.persistence?.state }));
