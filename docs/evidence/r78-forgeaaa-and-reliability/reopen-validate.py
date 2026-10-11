import unreal, json, sys
report = {"ok": True, "level": "/Game/ForgeAAA/Maps/FAAA_StairTest", "actors": [], "errors": []}
try:
    level_lib = unreal.EditorLevelLibrary
    asset_lib = unreal.EditorAssetLibrary
    if not asset_lib.does_asset_exist(report["level"]):
        report["ok"] = False
        report["errors"].append("level asset missing")
    else:
        level_lib.load_level(report["level"])
        actors = [a for a in level_lib.get_all_level_actors() if a.get_actor_label().startswith("FAAA_StairV2_")]
        report["matched"] = len(actors)
        for a in actors:
            e = {"label": a.get_actor_label()}
            loc = a.get_actor_location(); rot = a.get_actor_rotation()
            e["location"] = [round(loc.x,2), round(loc.y,2), round(loc.z,2)]
            e["rotation"] = [round(rot.pitch,2), round(rot.yaw,2), round(rot.roll,2)]
            try:
                smc = a.static_mesh_component
                if smc is not None:
                    sm = smc.static_mesh
                    e["mesh_ref"] = sm.get_path_name() if sm else "none"
                    e["collision_enabled"] = str(smc.get_editor_property("body_instance").get_editor_property("collision_enabled"))
                    e["mobility"] = str(smc.mobility)
                else:
                    e["mesh_ref"] = "no smc"
            except Exception as ex:
                e["component_err"] = str(ex)
            report["actors"].append(e)
        if len(actors) != 10:
            report["errors"].append("expected 10 actors, found " + str(len(actors)))
except Exception as e:
    report["ok"] = False
    report["errors"].append("fatal: " + str(e))
report["ok"] = report["ok"] and len(report["errors"]) == 0
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0)
