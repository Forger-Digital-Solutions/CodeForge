import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BlenderAdapter, UnrealAdapter, createManifest, inspectForgeAaaProject, classifyForgeAaaProject, sha256Hex,
} from "../src/index.js";

/**
 * Stair module v2 — beyond geometric existence (directive §11): handrail, UCX collision
 * proxies, modular sockets, normals validation, FBX export for UE4 (UCX collision only
 * survives the FBX path), plus a REAL `ImportAssets` commandlet attempt into the Dead
 * Trails West project. Import success is asserted only if a .uasset lands on disk.
 * Requires FORGE_AAA_LIVE=1.
 */
const LIVE = process.env.FORGE_AAA_LIVE === "1";
const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/evidence/r77-forge-aaa-auto");
const ARTIFACT_DIR = path.join(EVIDENCE_DIR, "artifacts", "stair-v2");
const DTW_DIR = process.env.FORGE_AAA_PROJECT_DIR ?? "C:\\Users\\Daddy_FDS\\Documents\\ChatGPT\\Dead Trails West";
const DTW_UPROJECT = path.join(DTW_DIR, "DeadTrailsWest.uproject");
const LIVE_TEST_TIMEOUT = 15 * 60_000;

const STAIR_V2_PY = `import bpy, bmesh, json, math, mathutils, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.data.collections.new("DTW_StairModule_v2")
bpy.context.scene.collection.children.link(col)
RISE, TREAD, WIDTH, STEPS = 0.18, 0.27, 0.90, 6
RAIL_H = 0.90
def move(obj, name=None):
    if name: obj.name = name
    for c in list(obj.users_collection): c.objects.unlink(obj)
    col.objects.link(obj)
    return obj
steps = []
for i in range(STEPS):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    s = move(bpy.context.object, "Step_%02d" % i)
    s.dimensions = (TREAD, WIDTH, RISE)
    s.location = (i * TREAD, 0.0, i * RISE + RISE / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    steps.append(s)
# Handrail: posts at first/middle/last step nosing, continuous rail along the slope.
posts = []
for i in (0, STEPS // 2, STEPS - 1):
    top_z = (i + 1) * RISE
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    p = move(bpy.context.object, "RailPost_%02d" % i)
    p.dimensions = (0.06, 0.06, RAIL_H)
    p.location = (i * TREAD + TREAD / 2.0, WIDTH / 2.0 - 0.05, top_z + RAIL_H / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    posts.append(p)
x0, z0 = posts[0].location.x, posts[0].location.z + RAIL_H / 2.0
x1, z1 = posts[-1].location.x, posts[-1].location.z + RAIL_H / 2.0
length = math.dist((x0, 0, z0), (x1, 0, z1))
angle = math.atan2(z1 - z0, x1 - x0)
bpy.ops.mesh.primitive_cube_add(size=1.0)
rail = move(bpy.context.object, "Handrail")
rail.dimensions = (length, 0.08, 0.08)
rail.location = ((x0 + x1) / 2.0, WIDTH / 2.0 - 0.05, (z0 + z1) / 2.0)
rail.rotation_euler = (0.0, -angle, 0.0)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
# UCX collision proxies — UE4 FBX importer binds UCX_<RenderMesh>_* as collision.
for i, s in enumerate(steps):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    c = move(bpy.context.object, "UCX_Step_%02d" % i)
    c.dimensions = s.dimensions
    c.location = s.location
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    c.display_type = "WIRE"
# Modular connection sockets — UE4 FBX convention: a null named SOCKET_<name> PARENTED
# to a mesh becomes a real socket on that mesh at import. Top-level empties (the v2 bug)
# are dropped silently; parenting is what makes them land.
for name, loc, host in (
    ("SOCKET_Bottom", (-TREAD / 2.0, 0.0, 0.0), steps[0]),
    ("SOCKET_Top", (STEPS * TREAD + TREAD / 2.0, 0.0, STEPS * RISE), steps[-1]),
    ("SOCKET_RailStart", (x0, WIDTH / 2.0 - 0.05, z0), rail),
    ("SOCKET_RailEnd", (x1, WIDTH / 2.0 - 0.05, z1), rail),
):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    e = move(bpy.context.object, name)
    e.empty_display_size = 0.15
    e.parent = host
report = {"ok": True, "meshes": 0, "vertices": 0, "faces": 0, "nonmanifold_objects": [],
          "degenerate_faces": 0, "validate_errors": 0, "bounds_cm": None, "errors": []}
mins = [float("inf")] * 3; maxs = [float("-inf")] * 3
for obj in col.objects:
    if obj.type != "MESH":
        continue
    report["meshes"] += 1
    report["vertices"] += len(obj.data.vertices); report["faces"] += len(obj.data.polygons)
    report["degenerate_faces"] += sum(1 for f in obj.data.polygons if f.area < 1e-8)
    try:
        report["validate_errors"] += obj.data.validate(verbose=False, clean_customdata=False)
    except Exception:
        pass
    for corner in obj.bound_box:
        w = obj.matrix_world @ mathutils.Vector(corner)
        for i in range(3):
            mins[i] = min(mins[i], w[i]); maxs[i] = max(maxs[i], w[i])
    bm = bmesh.new(); bm.from_mesh(obj.data)
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    if nm: report["nonmanifold_objects"].append({"name": obj.name, "edges": nm})
    bm.free()
report["bounds_cm"] = [round((maxs[i] - mins[i]) * 100, 3) for i in range(3)]
report["rise_cm"] = RISE * 100; report["tread_cm"] = TREAD * 100; report["width_cm"] = WIDTH * 100
report["rail_height_cm"] = RAIL_H * 100
report["objects"] = len(col.objects)
report["ucx_collision_count"] = sum(1 for o in col.objects if o.name.startswith("UCX_"))
report["sockets"] = [o.name for o in col.objects if o.name.startswith("SOCKET_")]
report["ok"] = (len(report["nonmanifold_objects"]) == 0 and report["degenerate_faces"] == 0
                and report["validate_errors"] == 0 and report["ucx_collision_count"] == STEPS
                and len(report["sockets"]) == 4)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) >= 2:
    bpy.ops.export_scene.gltf(filepath=argv[0], export_format="GLB", export_apply=True, export_yup=True)
    bpy.ops.export_scene.fbx(filepath=argv[1], use_custom_props=True)
    report["exported_glb"] = argv[0]; report["exported_fbx"] = argv[1]
print("FORGEAAA_REPORT:" + json.dumps(report))
`;

describe.runIf(LIVE)("ForgeAAA stair v2 + Unreal import (directive §11-12)", () => {
  it("builds a collision-ready modular stair in Blender 4.5 and attempts real UE4.27 import", async () => {
    const blender = new BlenderAdapter();
    const unreal = new UnrealAdapter();
    const [bDet, uDet] = await Promise.all([blender.detect(), unreal.detect()]);
    const ue427 = uDet.installs.find((i) => i.version.major === 4 && i.version.minor === 27);
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });

    const project = await inspectForgeAaaProject(DTW_DIR);
    const classification = classifyForgeAaaProject(project);
    // Truthful either way: an empty/scaffold DTW is PILOT; once ForgeAAA-generated
    // .uassets exist under Content/, the project IS existing content and must not be
    // silently reclassified back to disposable.
    expect(classification.mode).toBe(project.contentSignals.authoredAssetCount > 0 ? "EXISTING_PROJECT" : "PILOT_PROJECT");

    const glb = path.join(ARTIFACT_DIR, "stair-module-v2.glb");
    const fbx = path.join(ARTIFACT_DIR, "stair-module-v2.fbx");
    const result = await blender.runHeadless({ op: "custom", scriptSource: STAIR_V2_PY, approved: true, args: [glb, fbx], timeoutMs: 300_000 });
    await fs.writeFile(path.join(EVIDENCE_DIR, "stair-v2-run.json"), JSON.stringify({ detection: bDet, run: result, classification }, null, 2), "utf8");

    expect(result.ok).toBe(true);
    const r = result.report as Record<string, unknown>;
    expect(r.nonmanifold_objects).toEqual([]);
    expect(r.degenerate_faces).toBe(0);
    expect(r.ucx_collision_count).toBe(6);
    expect(r.sockets).toEqual(["SOCKET_Bottom", "SOCKET_Top", "SOCKET_RailStart", "SOCKET_RailEnd"]);
    expect(existsSync(glb)).toBe(true);
    expect(existsSync(fbx)).toBe(true);

    const fbxBytes = await fs.readFile(fbx);
    const manifest = createManifest({
      assetId: "dtw/farmhouse/stair-module/v2",
      taskId: "stair-v2-live",
      provenance: { generator: "forge-aaa-stair-v2", generatorVersion: bDet.version?.raw, tool: "blender" },
      license: { commercialUse: "yes", detail: "procedurally generated" },
      files: [
        { path: path.basename(fbx), role: "output", sha256: sha256Hex(fbxBytes), bytes: fbxBytes.length },
        { path: path.basename(glb), role: "output", sha256: sha256Hex(await fs.readFile(glb)), bytes: (await fs.readFile(glb)).length },
      ],
      units: { system: "metric", scale: 1, upAxis: "Z" },
      stats: { vertices: r.vertices as number, triangles: r.faces as number, boundsCm: r.bounds_cm as [number, number, number], nonmanifoldEdges: 0 },
      engines: { blender: bDet.version ? [bDet.version.raw] : [], unreal: ["4.27"] },
      validation: { checks: [{ id: "manifold+ucx+sockets", kind: "blender-scene", status: "passed" }], validatedAt: new Date().toISOString() },
      revision: 2, supersedes: "dtw/farmhouse/stair-module",
    });
    await fs.writeFile(path.join(ARTIFACT_DIR, "stair-module-v2.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // Real import attempt: UE4.27 ImportAssets commandlet on the FBX → /Game/ForgeAAA.
    // The commandlet takes -importSettings=<path-to-json> (AutomatedAssetImportData).
    const contentDir = path.join(DTW_DIR, "Content");
    const before = existsSync(contentDir) ? await fs.readdir(contentDir).catch(() => [] as string[]) : [];
    const importResult = ue427
      ? await unreal.importAssets({
          projectPath: DTW_UPROJECT,
          files: [fbx],
          destinationPath: "/Game/ForgeAAA",
          groupName: "ForgeAAA",
          settingsPath: path.join(ARTIFACT_DIR, "import-settings.json"),
          timeoutMs: 300_000,
          install: ue427,
        })
      : { ok: false, exitCode: null, timedOut: false, durationMs: 0, logTail: "", error: "no UE 4.27 install", settingsPath: "" };
    const after = existsSync(contentDir) ? await fs.readdir(contentDir).catch(() => [] as string[]) : [];
    const newFiles = after.filter((f) => !before.includes(f));
    const importedAssets = (await walkFor(contentDir, ".uasset")).filter((f) => f.includes("ForgeAAA"));

    await fs.writeFile(path.join(EVIDENCE_DIR, "unreal-import-attempt.json"), JSON.stringify({
      commandlet: "ImportAssets",
      result: importResult,
      newTopLevelFiles: newFiles,
      importedAssets,
      imported: importedAssets.length > 0,
    }, null, 2), "utf8");

    // Hard gate: real .uasset files must exist under /Game/ForgeAAA. The commandlet's
    // exit code is not the authority — the launcher build counts the expected
    // "no source control" error in its summary even when import succeeds.
    expect(ue427).toBeDefined();
    expect(importedAssets.length).toBeGreaterThan(0);
    for (const asset of importedAssets) expect((await fs.stat(asset)).size).toBeGreaterThan(0);
  }, LIVE_TEST_TIMEOUT);
});

async function walkFor(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFor(p, ext));
    else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
  }
  return out;
}
