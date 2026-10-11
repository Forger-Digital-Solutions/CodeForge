import unreal, json, os, uuid

ell, eal = unreal.EditorLevelLibrary, unreal.EditorAssetLibrary
level = "/Game/ForgeAAA/Maps/R83_NativeDiagnostic_" + uuid.uuid4().hex[:12]
identity = "r83-diagnostic:" + uuid.uuid4().hex
report = {"ok": False, "level": level, "identity": identity, "requested": {"positionCm": [290,260,0], "yawDeg": 90}, "steps": [], "bindings": {}}
for name, obj in [("Rotator", unreal.Rotator), ("Transform", unreal.Transform), ("spawn_actor_from_class", ell.spawn_actor_from_class), ("set_actor_location", unreal.Actor.set_actor_location), ("set_actor_rotation", unreal.Actor.set_actor_rotation), ("set_actor_transform", unreal.Actor.set_actor_transform)]:
    report["bindings"][name] = obj.__doc__
def vec(v): return [v.x,v.y,v.z]
def capture(actor, step, result=None):
    root = actor.root_component
    rot = actor.get_actor_rotation()
    report["steps"].append({"step": step, "result": str(result), "actor": actor.get_path_name(), "class": actor.get_class().get_path_name(), "root": root.get_path_name(), "mobility": str(root.mobility), "tags": [str(t) for t in actor.tags], "positionCm": vec(actor.get_actor_location()), "rotation": {"pitch": rot.pitch,"yaw": rot.yaw,"roll": rot.roll}, "scale": vec(actor.get_actor_scale3d())})
try:
    # Inspect historical placement without changing the saved level.
    if ell.load_level("/Game/ForgeAAA/Maps/FAAA_R83_RoomA"):
        report["historical"] = []
        for a in ell.get_all_level_actors():
            tags = [str(t) for t in a.tags]
            if "forge-building:western-room-a:door-interior" in tags:
                r = a.get_actor_rotation()
                report["historical"].append({"actor": a.get_path_name(), "class": a.get_class().get_path_name(), "tags": tags, "positionCm": vec(a.get_actor_location()), "rotation": {"pitch": r.pitch,"yaw": r.yaw,"roll": r.roll}})
    report["recoveryPath"] = {"exists": eal.does_asset_exist("/Game/ForgeAAA/MigrationRecoveryTransient"), "diskExists": os.path.isfile(os.path.join(unreal.Paths.project_content_dir(), "ForgeAAA/MigrationRecoveryTransient.umap"))}
    if not ell.new_level(level): raise RuntimeError("diagnostic level creation failed")
    cls = unreal.load_class(None, "/Script/ForgeGameplay.ForgeInteractableDoor")
    actor = ell.spawn_actor_from_class(cls, unreal.Vector(290,260,0), unreal.Rotator(0,90,0))
    if actor is None: raise RuntimeError("spawn returned None")
    actor.tags = [unreal.Name(identity)]
    capture(actor, "spawn positional Rotator(0,90,0)", actor)
    capture(actor, "set_actor_location", actor.set_actor_location(unreal.Vector(290,260,0), False, True))
    capture(actor, "set_actor_rotation positional", actor.set_actor_rotation(unreal.Rotator(0,90,0), True))
    named = unreal.Rotator(pitch=0,yaw=90,roll=0)
    capture(actor, "set_actor_rotation named", actor.set_actor_rotation(named, True))
    transform = unreal.Transform(location=unreal.Vector(290,260,0), rotation=named, scale=unreal.Vector(1,1,1))
    capture(actor, "set_actor_transform named", actor.set_actor_transform(transform, False, True))
    actor.get_editor_property("FrameMesh").set_editor_property("static_mesh", eal.load_asset("/Game/ForgeAAA/door_SM_DoorFrame"))
    actor.get_editor_property("LeafMesh").set_editor_property("static_mesh", eal.load_asset("/Game/ForgeAAA/door_SM_DoorLeaf"))
    capture(actor, "mesh properties")
    if not ell.save_current_level(): raise RuntimeError("diagnostic save failed")
    capture(actor, "after save")
    report["ok"] = True
except Exception as error:
    report["error"] = str(error)
print("FORGEAAA_REPORT:" + json.dumps(report))
import sys
sys.exit(0 if report["ok"] else 2)
