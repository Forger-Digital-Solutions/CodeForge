import { createHash } from "node:crypto";
import { buildingActorIdentity, type BuildingDefinition, type BuildingModuleDefinition } from "./building-definition.js";

export function buildingAssemblyScript(building: BuildingDefinition, modules: readonly BuildingModuleDefinition[], level: string): string {
  const spec = {
    level,
    instances: building.instances.map((i) => ({
      ...i,
      module: modules.find((m) => m.moduleId === i.moduleId),
      identity: buildingActorIdentity(building.buildingInstanceId, i.instanceId),
      persistentId: createHash("sha256").update(buildingActorIdentity(building.buildingInstanceId, i.instanceId)).digest("hex").slice(0, 32),
    })),
    fingerprint: createHash("sha256").update(JSON.stringify({ building, modules })).digest("hex"),
  };
  return ASSEMBLY_PY.replace("__SPEC__", JSON.stringify(JSON.stringify(spec)));
}

const ASSEMBLY_PY = `import unreal, json
spec = json.loads(__SPEC__)
ell, eal = unreal.EditorLevelLibrary, unreal.EditorAssetLibrary
report = {"ok": False, "placed": [], "errors": [], "level_saved": False, "fingerprint": spec["fingerprint"]}
created = []
try:
    resolved = {}
    for i in spec["instances"]:
        m = i["module"]
        mesh = eal.load_asset(m["engineAsset"])
        leaf = eal.load_asset(m["leafAsset"]) if m.get("leafAsset") else None
        cls = unreal.load_class(None, m["nativeClass"]) if m.get("nativeClass") else None
        if mesh is None or (m.get("nativeClass") and (cls is None or leaf is None)):
            raise RuntimeError("unresolved module: " + i["moduleId"])
        resolved[i["instanceId"]] = (mesh, leaf, cls)
    if eal.does_asset_exist(spec["level"]):
        if not ell.load_level(spec["level"]): raise RuntimeError("level load failed")
    else:
        if not ell.new_level(spec["level"]): raise RuntimeError("level creation failed")
    existing = {}
    for actor in ell.get_all_level_actors():
        for tag in actor.tags or []:
            t = str(tag)
            if t.startswith("forge-building:"):
                if t in existing: raise RuntimeError("duplicate actor identity " + t)
                existing[t] = actor
    revision = "forge-revision:" + spec["fingerprint"]
    for i in spec["instances"]:
        actor = existing.get(i["identity"])
        if actor and revision not in [str(t) for t in actor.tags]:
            raise RuntimeError("existing building revision differs; explicit migration required")
        if actor:
            pos = actor.get_actor_location()
            rot, scale = actor.get_actor_rotation(), actor.get_actor_scale3d()
            if max(abs(v-w) for v,w in zip((pos.x,pos.y,pos.z),i["positionCm"])) > 0.1 or abs((rot.yaw-i["yawDeg"]+180)%360-180) > 0.1 or abs(rot.pitch)>0.1 or abs(rot.roll)>0.1 or max(abs(v-1) for v in (scale.x,scale.y,scale.z))>0.001:
                raise RuntimeError("existing actor placement differs")
            mesh, leaf, cls = resolved[i["instanceId"]]
            if cls:
                window = i["module"]["moduleType"] == "window"
                if actor.get_class() != cls or str(actor.get_editor_property("WindowInstanceId" if window else "DoorInstanceId")) != i["persistentId"] or actor.get_editor_property("FrameMesh").get_editor_property("static_mesh") != mesh or actor.get_editor_property("SashMesh" if window else "LeafMesh").get_editor_property("static_mesh") != leaf:
                    raise RuntimeError("existing native module identity or asset differs")
            elif not isinstance(actor,unreal.StaticMeshActor) or actor.static_mesh_component.get_editor_property("static_mesh") != mesh:
                raise RuntimeError("existing structural asset differs")
    for i in spec["instances"]:
        actor = existing.get(i["identity"])
        action = "reused"
        if actor is None:
            mesh, leaf, cls = resolved[i["instanceId"]]
            pos, yaw = i["positionCm"], i["yawDeg"]
            if cls:
                actor = ell.spawn_actor_from_class(cls, unreal.Vector(*pos), unreal.Rotator(0,yaw,0))
            else:
                actor = ell.spawn_actor_from_object(mesh, unreal.Vector(*pos), unreal.Rotator(0,yaw,0))
            if actor is None: raise RuntimeError("spawn failed " + i["identity"])
            created.append(actor)
            actor.tags = [unreal.Name(i["identity"]), unreal.Name(revision)]
            actor.set_actor_label(i["identity"].replace(":","_"))
            if cls:
                is_window = i["module"]["moduleType"] == "window"
                actor.set_editor_property("WindowInstanceId" if is_window else "DoorInstanceId", i["persistentId"])
                actor.get_editor_property("FrameMesh").set_editor_property("static_mesh", mesh)
                actor.get_editor_property("SashMesh" if is_window else "LeafMesh").set_editor_property("static_mesh", leaf)
            action = "spawned"
        origin, extent = actor.get_actor_bounds(False)
        if not i["module"].get("nativeClass"):
            d = i["module"]["dimensions"]
            want = [d["widthCm"],d["depthCm"],d["heightCm"]]
            if abs(i["yawDeg"] % 180) == 90: want[0],want[1] = want[1],want[0]
            if max(abs(v*2-w) for v,w in zip((extent.x,extent.y,extent.z),want)) > 0.2:
                raise RuntimeError("imported geometry dimension mismatch " + i["identity"] + " observed=" + str([extent.x*2,extent.y*2,extent.z*2]) + " expected=" + str(want))
        report["placed"].append({"instanceId":i["instanceId"],"persistentId":i["persistentId"],"identity":i["identity"],"actor":actor.get_path_name(),"action":action,"boundsCm":[origin.x,origin.y,origin.z,extent.x,extent.y,extent.z]})
    if not ell.save_current_level(): raise RuntimeError("level save failed")
    report["level_saved"] = True
    report["ok"] = True
    report["actorCount"] = len(ell.get_all_level_actors())
except Exception as e:
    report["errors"].append(str(e))
    for actor in created: actor.destroy_actor()
    report["rolledBackActors"] = len(created)
print("FORGEAAA_REPORT:" + json.dumps(report))
import sys
sys.exit(0 if report["ok"] else 2)
`;
