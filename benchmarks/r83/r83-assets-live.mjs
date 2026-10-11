/**
 * R83-D1/E: Generate the 6 new R83 architectural FBX modules in Blender 4.5 and
 * import them into UE4.27 under /Game/ForgeAAA/R83.
 *
 * New modules:
 *   SM_DoorThreshold     20 × 110 × 10 cm  (floor type)
 *   SM_SharedWall_Front  20 × 225 × 260 cm  (wall, has door socket)
 *   SM_SharedWall_Back   20 × 225 × 260 cm  (wall)
 *   SM_SharedWall_Lintel 20 × 110 × 45 cm  (wall, above door)
 *   SM_FrontWall_B       560 × 20 × 260 cm  (Room B front/back wall)
 *   SM_Ceiling_B         580 × 560 × 10 cm  (Room B ceiling)
 */
import { mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  BlenderAdapter,
  UnrealAdapter,
  architecturalBlenderScript,
} from "../../packages/forge-aaa/dist/index.js";

const root = path.resolve(".scratch");
const pilot = path.join(root, "r83pilot");
const project = path.join(pilot, "DeadTrailsWest.uproject");
const evidenceDir = "docs/evidence/r83-forgeaaa-autonomous-multiroom";
await mkdir(evidenceDir, { recursive: true });
await mkdir(root, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  kind: "R83_ASSET_GENERATION",
  project,
};
const evidenceFile = `${evidenceDir}/r83-assets-${Date.now()}.json`;
const persist = () => writeFile(evidenceFile, JSON.stringify(report, null, 2));

const blender = new BlenderAdapter();
const unreal = new UnrealAdapter();
const install = (await unreal.detect()).installs.find(
  (i) => i.version.major === 4 && i.version.minor === 27
);
if (!install) throw new Error("UE4.27 not found");
report.engine = install;
await persist();

const hash = async (f) =>
  createHash("sha256").update(await readFile(f)).digest("hex");

const fileExists = async (p) => { try { await access(p); return true; } catch { return false; } };

// ──────────────────────────────────────────────────────────────────────
// Phase 1: Generate R83 new modules via Blender
// ──────────────────────────────────────────────────────────────────────
const r83ArchDir = path.join(root, "r83architecture");
await mkdir(r83ArchDir, { recursive: true });

const box = (name, dims, material = "plaster") => ({
  name,
  parts: [{ dimensionsCm: dims, centerCm: [0, 0, 0], material }],
  collision: [{ dimensionsCm: dims, centerCm: [0, 0, 0] }],
});

const r83Meshes = [
  box("SM_DoorThreshold", [20, 110, 10], "wood"),
  box("SM_SharedWall_Front", [20, 225, 260]),
  box("SM_SharedWall_Back", [20, 225, 260]),
  box("SM_SharedWall_Lintel", [20, 110, 45]),
  box("SM_FrontWall_B", [560, 20, 260]),
  box("SM_Ceiling_B", [580, 560, 10], "wood"),
];

// Check if already generated (avoid re-running Blender on retry)
const alreadyGenerated = (await Promise.all(r83Meshes.flatMap(m => [".fbx", ".blend"].map(extension => fileExists(path.join(r83ArchDir, m.name + extension)))))).every(Boolean);
if (alreadyGenerated) {
  const { assetReadback } = await import("./verify-assets-live.mjs");
  Object.assign(report, { kind: "R83_EXISTING_ASSET_VERIFICATION", regenerated: false, reimported: false, readback: assetReadback, ok: assetReadback.ok });
  await persist();
  if (!report.ok) throw new Error("Existing assets failed actual Blender/editor readback; repair must be explicit");
  console.log(JSON.stringify({ evidenceFile, ok: report.ok, regenerated: false }));
  process.exit(0);
} else {
  console.log("Generating R83 architectural meshes via Blender...");
  report.blender = await blender.runHeadless({
    op: "custom",
    approved: true,
    scriptSource: architecturalBlenderScript(r83Meshes),
    args: [r83ArchDir],
    timeoutMs: 300_000,
  });
}
await persist();
if (!report.blender.ok || report.blender.report?.ok !== true) {
  throw new Error("Blender generation failed: " + JSON.stringify(report.blender));
}
console.log(
  "Blender OK:",
  r83Meshes.map((m) => `${m.name} ${m.parts[0].dimensionsCm.map((v) => v.toFixed(1)).join("×")}cm`)
);

// ──────────────────────────────────────────────────────────────────────
// Phase 2: Use R82 FBX files from r82 worktree scratch
// ──────────────────────────────────────────────────────────────────────
const r82ScratchArch = path.resolve(
  "../r82-forgeaaa-modular-western-interior/.scratch/architecture"
);
const r82DoorFbx = path.resolve(
  "../r82-forgeaaa-modular-western-interior/.scratch/door.fbx"
);

let r82FbxFiles = [];
try {
  r82FbxFiles = (await readdir(r82ScratchArch))
    .filter((f) => f.endsWith(".fbx"))
    .map((f) => path.join(r82ScratchArch, f));
  console.log(`R82 FBX files found: ${r82FbxFiles.length}`);
} catch {
  throw new Error("R82 .scratch/architecture not found — ensure R82 pilot assets exist");
}

// ──────────────────────────────────────────────────────────────────────
// Phase 3: Import R82 modules into R83 pilot at /Game/ForgeAAA/R82
// (uses Python script through editor — avoids source-control exit code issue)
// ──────────────────────────────────────────────────────────────────────
const r82Modules = JSON.parse(await readFile("benchmarks/r82/module-registry.json", "utf8"));
const r82DimensionsMap = {};
for (const m of r82Modules) {
  r82DimensionsMap[m.displayName] = [m.dimensions.widthCm, m.dimensions.depthCm, m.dimensions.heightCm];
}

const importR82Script = `import unreal, json, sys
files = json.loads(${JSON.stringify(JSON.stringify(r82FbxFiles))})
dimensions = json.loads(${JSON.stringify(JSON.stringify(r82DimensionsMap))})
report = {"ok": True, "assets": [], "errors": []}
eal = unreal.EditorAssetLibrary
for filename in files:
    task = unreal.AssetImportTask()
    task.filename = filename
    task.destination_path = "/Game/ForgeAAA/R82"
    task.automated = True
    task.save = True
    task.replace_existing = True
    task.replace_existing_settings = True
    opts = unreal.FbxImportUI()
    opts.import_mesh = True
    opts.import_materials = False
    opts.import_textures = False
    opts.import_as_skeletal = False
    opts.static_mesh_import_data.set_editor_property("combine_meshes", False)
    opts.static_mesh_import_data.set_editor_property("transform_vertex_to_absolute", True)
    opts.static_mesh_import_data.set_editor_property("convert_scene_unit", True)
    opts.static_mesh_import_data.set_editor_property("auto_generate_collision", False)
    task.options = opts
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = list(task.imported_object_paths)
    if not paths:
        report["errors"].append("no imported mesh: " + filename)
        continue
    for p in paths:
        asset = eal.load_asset(p)
        if asset is None:
            report["errors"].append("load failed: " + p)
            continue
        name = asset.get_name()
        actor = unreal.EditorLevelLibrary.spawn_actor_from_object(asset, unreal.Vector(0,0,0))
        origin, extent = actor.get_actor_bounds(False)
        measured = [extent.x*2, extent.y*2, extent.z*2]
        actor.destroy_actor()
        entry = {"path": p, "name": name, "dimensionsCm": measured}
        if name in dimensions:
            exp = dimensions[name]
            if max(abs(v-w) for v,w in zip(measured, exp)) > 0.5:
                report["errors"].append("scale mismatch " + name + " got " + str(measured) + " expected " + str(exp))
            else:
                entry["dimensionMatch"] = True
        report["assets"].append(entry)
report["ok"] = not report["errors"]
print("FORGEAAA_REPORT:" + json.dumps(report))
import sys as _sys
_sys.exit(0 if report["ok"] else 2)
`;

const r82ImportScriptPath = path.join(root, "r83-import-r82.py");
await writeFile(r82ImportScriptPath, importR82Script, "utf8");
console.log("Importing R82 architecture modules into R83 pilot...");
report.r82Import = await unreal.runPythonScript({
  projectPath: project,
  scriptPath: r82ImportScriptPath,
  install,
  host: "editor",
  logPath: path.join(root, "r83-import-r82.log"),
  timeoutMs: 300_000,
});
await persist();
if (!report.r82Import.ok || report.r82Import.report?.ok !== true) {
  throw new Error("R82 module import failed: " + JSON.stringify(report.r82Import));
}
console.log(`R82 modules imported: ${report.r82Import.report.assets.length}`);

// Import door FBX via Python (editor mode, same approach as architecture)
const importDoorScript = `import unreal, json, sys
door_fbx = ${JSON.stringify(r82DoorFbx)}
report = {"ok": True, "assets": [], "errors": []}
eal = unreal.EditorAssetLibrary
task = unreal.AssetImportTask()
task.filename = door_fbx
task.destination_path = "/Game/ForgeAAA"
task.automated = True
task.save = True
task.replace_existing = True
task.replace_existing_settings = True
opts = unreal.FbxImportUI()
opts.import_mesh = True
opts.import_materials = False
opts.import_textures = False
opts.import_as_skeletal = False
opts.static_mesh_import_data.set_editor_property("combine_meshes", False)
opts.static_mesh_import_data.set_editor_property("transform_vertex_to_absolute", True)
opts.static_mesh_import_data.set_editor_property("convert_scene_unit", True)
opts.static_mesh_import_data.set_editor_property("auto_generate_collision", False)
task.options = opts
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
paths = list(task.imported_object_paths)
if not paths:
    report["errors"].append("door import produced no paths")
else:
    for p in paths:
        asset = eal.load_asset(p)
        if asset:
            report["assets"].append({"path": p, "name": asset.get_name()})
report["ok"] = not report["errors"]
print("FORGEAAA_REPORT:" + json.dumps(report))
import sys as _sys
_sys.exit(0 if report["ok"] else 2)
`;

const doorImportScriptPath = path.join(root, "r83-import-door.py");
await writeFile(doorImportScriptPath, importDoorScript, "utf8");
console.log("Importing door FBX into R83 pilot...");
report.doorImport = await unreal.runPythonScript({
  projectPath: project,
  scriptPath: doorImportScriptPath,
  install,
  host: "editor",
  logPath: path.join(root, "r83-import-door.log"),
  timeoutMs: 180_000,
});
await persist();
if (!report.doorImport.ok || report.doorImport.report?.ok !== true) {
  throw new Error("Door import failed: " + JSON.stringify(report.doorImport));
}
console.log(`Door assets imported: ${report.doorImport.report.assets.map((a) => a.name).join(", ")}`);

// ──────────────────────────────────────────────────────────────────────
// Phase 4: Import R83 new modules into pilot at /Game/ForgeAAA/R83
// ──────────────────────────────────────────────────────────────────────
const r83FbxFiles = (await readdir(r83ArchDir))
  .filter((f) => f.endsWith(".fbx"))
  .map((f) => path.join(r83ArchDir, f));

const r83ExpectedDims = {};
for (const m of r83Meshes) {
  r83ExpectedDims[m.name] = m.parts[0].dimensionsCm;
}

const importR83Script = `import unreal, json, sys
files = json.loads(${JSON.stringify(JSON.stringify(r83FbxFiles))})
expected = json.loads(${JSON.stringify(JSON.stringify(r83ExpectedDims))})
report = {"ok": True, "assets": [], "errors": []}
eal = unreal.EditorAssetLibrary
for filename in files:
    task = unreal.AssetImportTask()
    task.filename = filename
    task.destination_path = "/Game/ForgeAAA/R83"
    task.automated = True
    task.save = True
    task.replace_existing = True
    task.replace_existing_settings = True
    opts = unreal.FbxImportUI()
    opts.import_mesh = True
    opts.import_materials = False
    opts.import_textures = False
    opts.import_as_skeletal = False
    opts.static_mesh_import_data.set_editor_property("combine_meshes", False)
    opts.static_mesh_import_data.set_editor_property("transform_vertex_to_absolute", True)
    opts.static_mesh_import_data.set_editor_property("convert_scene_unit", True)
    opts.static_mesh_import_data.set_editor_property("auto_generate_collision", False)
    task.options = opts
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    paths = list(task.imported_object_paths)
    if not paths:
        report["errors"].append("no imported mesh: " + filename)
        continue
    for p in paths:
        asset = eal.load_asset(p)
        if asset is None:
            report["errors"].append("load failed: " + p)
            continue
        name = asset.get_name()
        body = asset.get_editor_property("body_setup")
        agg = body.get_editor_property("agg_geom")
        actor = unreal.EditorLevelLibrary.spawn_actor_from_object(asset, unreal.Vector(0,0,0))
        origin, extent = actor.get_actor_bounds(False)
        measured = [extent.x*2, extent.y*2, extent.z*2]
        actor.destroy_actor()
        entry = {"path": p, "name": name, "dimensionsCm": measured,
                 "collisionConvex": len(agg.get_editor_property("convex_elems")),
                 "collisionBoxes": len(agg.get_editor_property("box_elems")),
                 "materials": len(asset.get_editor_property("static_materials"))}
        if name in expected:
            exp = expected[name]
            if max(abs(v-w) for v,w in zip(measured, exp)) > 0.5:
                report["errors"].append("scale mismatch " + name + " measured=" + str(measured) + " expected=" + str(exp))
            else:
                entry["dimensionMatch"] = True
        report["assets"].append(entry)
report["ok"] = not report["errors"]
print("FORGEAAA_REPORT:" + json.dumps(report))
import sys as _sys
_sys.exit(0 if report["ok"] else 2)
`;

const r83ImportScriptPath = path.join(root, "r83-import-r83.py");
await writeFile(r83ImportScriptPath, importR83Script, "utf8");
console.log("Importing R83 modules into pilot...");
report.r83Import = await unreal.runPythonScript({
  projectPath: project,
  scriptPath: r83ImportScriptPath,
  install,
  host: "editor",
  logPath: path.join(root, "r83-import-r83.log"),
  timeoutMs: 300_000,
});
await persist();
if (!report.r83Import.ok || report.r83Import.report?.ok !== true) {
  throw new Error("R83 module import failed: " + JSON.stringify(report.r83Import));
}
console.log(
  "R83 modules imported:",
  report.r83Import.report.assets.map((a) => `${a.name} ${a.dimensionsCm.map((v) => v.toFixed(1)).join("×")}`)
);

// ──────────────────────────────────────────────────────────────────────
// Phase 5: Write content hashes for all R83 modules
// ──────────────────────────────────────────────────────────────────────
const r83Hashes = {};
for (const file of r83FbxFiles) {
  const name = path.basename(file, ".fbx");
  r83Hashes[name] = await hash(file);
}
report.r83Hashes = r83Hashes;
report.finishedAt = new Date().toISOString();
await persist();

console.log(JSON.stringify({
  evidenceFile,
  r82Imported: report.r82Import.report.assets.length,
  doorImported: report.doorImport.report.assets.length,
  r83Imported: report.r83Import.report.assets.length,
  ok: true,
}));
