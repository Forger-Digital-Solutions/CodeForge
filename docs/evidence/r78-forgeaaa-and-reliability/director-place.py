import unreal, json, sys
spec = json.loads("{\"level\":\"/Game/ForgeAAA/Maps/FAAA_StairTest\",\"placements\":[{\"name\":\"FAAA_StairV2_Step_00\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_00\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Step_01\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_01\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Step_02\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_02\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Step_03\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_03\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Step_04\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_04\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Step_05\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Step_05\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_RailPost_00\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_RailPost_00\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_RailPost_03\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_RailPost_03\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_RailPost_05\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_RailPost_05\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]},{\"name\":\"FAAA_StairV2_Handrail\",\"asset\":\"/Game/ForgeAAA/stair-module-v2_Handrail\",\"location\":[0,0,0],\"rotation\":[0,0,0],\"scale\":[1,1,1]}]}")
report = {"ok": True, "level": spec["level"], "placed": [], "actors_in_level": 0, "errors": []}
try:
    asset_lib = unreal.EditorAssetLibrary
    level_lib = unreal.EditorLevelLibrary
    if asset_lib.does_asset_exist(spec["level"]):
        level_lib.load_level(spec["level"])
        report["level_action"] = "loaded"
    else:
        level_lib.new_level(spec["level"])
        report["level_action"] = "created"
    existing = {}
    try:
        for a in level_lib.get_all_level_actors():
            try:
                existing[a.get_actor_label()] = a
            except Exception:
                pass
    except Exception:
        pass
    for p in spec["placements"]:
        try:
            asset = asset_lib.load_asset(p["asset"])
            if asset is None:
                report["errors"].append("asset missing: " + p["asset"])
                continue
            loc = unreal.Vector(p["location"][0], p["location"][1], p["location"][2])
            rot = unreal.Rotator(p["rotation"][0], p["rotation"][1], p["rotation"][2])
            scl = unreal.Vector(p["scale"][0], p["scale"][1], p["scale"][2])
            if p["name"] in existing:
                actor = existing[p["name"]]
                actor.set_actor_transform(unreal.Transform(loc, rot, scl), sweep=False, teleport=True)
                action = "updated"
            else:
                actor = level_lib.spawn_actor_from_object(asset, loc, rot)
                if actor is None:
                    report["errors"].append("spawn returned None: " + p["name"])
                    continue
                actor.set_actor_label(p["name"])
                if list(p["scale"]) != [1, 1, 1]:
                    actor.set_actor_scale3d(scl)
                action = "spawned"
            entry = {"name": p["name"], "actor": actor.get_actor_label(), "action": action}
            try:
                origin, extent = actor.get_actor_bounds(False)
                entry["bounds_cm"] = [round(v, 2) for v in (origin.x, origin.y, origin.z, extent.x, extent.y, extent.z)]
            except Exception:
                pass
            report["placed"].append(entry)
        except Exception as e:
            report["errors"].append(p["name"] + ": " + str(e))
    level_lib.save_current_level()
    report["level_saved"] = True
    try:
        report["actors_in_level"] = len(level_lib.get_all_level_actors())
    except Exception:
        report["actors_in_level"] = len(report["placed"])
except Exception as e:
    report["ok"] = False
    report["errors"].append("fatal: " + str(e))
report["ok"] = report["ok"] and len(report["errors"]) == 0 and len(report["placed"]) == len(spec["placements"])
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0 if report["ok"] else 2)
