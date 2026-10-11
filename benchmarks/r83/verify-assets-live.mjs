import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { BlenderAdapter } from "../../packages/forge-aaa/dist/index.js";
import { R83_TWO_ROOM_MODULES } from "../../packages/forge-aaa/dist/r83-building-spec.js";
import { python, scratch, evidenceDir } from "./live-utils.mjs";
const modules=R83_TWO_ROOM_MODULES.filter(m=>m.engineAsset.startsWith("/Game/ForgeAAA/R83/"));
const dir=path.join(scratch,"r83architecture"), report={startedAt:new Date().toISOString(),kind:"EXISTING_ASSET_READBACK",regenerated:false};
const file=path.join(evidenceDir,`asset-readback-${Date.now()}.json`);
report.sourceHashes={};
for(const m of modules) {
  const name=path.basename(m.engineAsset);
  report.sourceHashes[name]={fbx:createHash("sha256").update(await readFile(path.join(dir,name+".fbx"))).digest("hex"),blend:createHash("sha256").update(await readFile(path.join(dir,name+".blend"))).digest("hex")};
}
report.blender=await new BlenderAdapter().runHeadless({op:"custom",approved:true,timeoutMs:120000,scriptPath:path.join(scratch,"r83-inspect-existing-assets.py"),scriptSource:`import bpy, bmesh, mathutils, json, os
spec = json.loads(${JSON.stringify(JSON.stringify(modules))})
directory = ${JSON.stringify(dir)}
report = {"ok":True,"assets":[],"errors":[],"version":bpy.app.version_string}
for m in spec:
    name = m["engineAsset"].split("/")[-1]
    bpy.ops.wm.open_mainfile(filepath=os.path.join(directory,name+".blend"))
    mesh = bpy.data.objects.get(name)
    if mesh is None: raise RuntimeError("source mesh missing " + name)
    bounds = [(mesh.matrix_world @ mathutils.Vector(v))*100 for v in mesh.bound_box]
    low = [min(v[k] for v in bounds) for k in range(3)]
    high = [max(v[k] for v in bounds) for k in range(3)]
    dimensions = [high[k]-low[k] for k in range(3)]
    want = [m["dimensions"][k] for k in ["widthCm","depthCm","heightCm"]]
    bm = bmesh.new(); bm.from_mesh(mesh.data)
    entry = {"name":name,"dimensionsCm":dimensions,"pivotCm":list(mesh.location*100),"materialSlots":[s.name for s in mesh.data.materials],"signedVolumeM3":bm.calc_volume(signed=True),"nonmanifoldEdges":sum(1 for e in bm.edges if not e.is_manifold),"degenerateFaces":sum(1 for f in bm.faces if f.calc_area()<1e-9),"inwardBoxNormals":sum(1 for f in bm.faces if f.normal.dot(f.calc_center_median())<=0),"invalidMaterialAssignments":sum(1 for f in bm.faces if f.material_index<0 or f.material_index>=len(mesh.data.materials)),"sockets":[{"name":o.name,"positionCm":list(o.location*100)} for o in bpy.data.objects if o.name.startswith("SOCKET_")],"collisionNames":[o.name for o in bpy.data.objects if o.name.startswith("UCX_")]}
    bm.free()
    if max(abs(v-w) for v,w in zip(dimensions,want))>0.1 or max(abs(v) for v in entry["pivotCm"])>0.01 or entry["nonmanifoldEdges"] or entry["degenerateFaces"] or entry["inwardBoxNormals"] or entry["invalidMaterialAssignments"] or entry["signedVolumeM3"]<=0 or not entry["collisionNames"]: report["errors"].append("invalid source " + name)
    report["assets"].append(entry)
report["ok"] = not report["errors"]
print("FORGEAAA_REPORT:"+json.dumps(report))
`});
await writeFile(file,JSON.stringify(report,null,2));
if(!report.blender.ok||report.blender.report?.ok!==true) throw new Error("source asset readback failed");
report.unreal=await python(`r83-assets-readback-${Date.now()}`,`import unreal, json, sys
spec = json.loads(${JSON.stringify(JSON.stringify(modules))})
report = {"ok":False,"assets":[],"errors":[]}
registry = unreal.AssetRegistryHelpers.get_asset_registry()
try:
    for m in spec:
        p = m["engineAsset"]
        mesh = unreal.EditorAssetLibrary.load_asset(p)
        data = registry.get_asset_by_object_path(p+"."+p.split("/")[-1])
        if not data.is_valid() or not isinstance(mesh,unreal.StaticMesh): raise RuntimeError("StaticMesh/registry load failed " + p)
        actor = unreal.EditorLevelLibrary.spawn_actor_from_object(mesh,unreal.Vector(0,0,0),unreal.Rotator(pitch=0,yaw=0,roll=0))
        origin,extent = actor.get_actor_bounds(False)
        actor.destroy_actor()
        agg = mesh.get_editor_property("body_setup").get_editor_property("agg_geom")
        slots = mesh.get_editor_property("static_materials")
        sockets = [mesh.find_socket(name) for name in ["AssemblyOrigin"] + [s["id"] for s in m["sockets"]]]
        sockets = [s for s in sockets if s is not None]
        entry = {"path":mesh.get_path_name(),"registryClass":str(data.asset_class),"dimensionsCm":[extent.x*2,extent.y*2,extent.z*2],"pivotOffsetCm":[origin.x,origin.y,origin.z],"convexCollisionCount":len(agg.get_editor_property("convex_elems")),"boxCollisionCount":len(agg.get_editor_property("box_elems")),"slots":[{"name":str(s.material_slot_name),"material":s.material_interface.get_path_name() if s.material_interface else None} for s in slots],"sockets":[{"name":str(s.socket_name),"positionCm":[s.relative_location.x,s.relative_location.y,s.relative_location.z]} for s in sockets],"contractSockets":m["sockets"]}
        want = [m["dimensions"][k] for k in ["widthCm","depthCm","heightCm"]]
        if max(abs(v-w) for v,w in zip(entry["dimensionsCm"],want))>0.1 or max(abs(v) for v in entry["pivotOffsetCm"])>0.1 or entry["convexCollisionCount"]+entry["boxCollisionCount"]<1 or len(slots)!=len(m["materials"]) or any(s["material"] is None for s in entry["slots"]): raise RuntimeError("imported asset contract mismatch " + p)
        found = {s["name"]:s["positionCm"] for s in entry["sockets"]}
        expected_sockets = [{"id":"AssemblyOrigin","localPosCm":[0,0,0]}] + m["sockets"]
        for socket in expected_sockets:
            if socket["id"] not in found or max(abs(v-w) for v,w in zip(found[socket["id"]],socket["localPosCm"]))>0.1: raise RuntimeError("imported socket mismatch " + p + " " + socket["id"])
        report["assets"].append(entry)
    report["ok"] = True
except Exception as error: report["errors"].append(str(error))
print("FORGEAAA_REPORT:"+json.dumps(report))
sys.exit(0 if report["ok"] else 2)
`);
report.ok=report.unreal.ok&&report.unreal.report?.ok===true;
report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({file,ok:report.ok,errors:report.unreal.report?.errors}));
if(!report.ok) process.exitCode=1;
export const assetReadback=report;
