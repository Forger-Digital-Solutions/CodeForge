import unreal, json, sys
names = [
    "stair-module-v2_Step_00", "stair-module-v2_Step_01", "stair-module-v2_Step_02",
    "stair-module-v2_Step_03", "stair-module-v2_Step_04", "stair-module-v2_Step_05",
    "stair-module-v2_RailPost_00", "stair-module-v2_RailPost_03", "stair-module-v2_RailPost_05",
    "stair-module-v2_Handrail",
]
report = {"ok": True, "assets": [], "errors": []}
for n in names:
    p = "/Game/ForgeAAA/" + n
    try:
        a = unreal.EditorAssetLibrary.load_asset(p)
        if a is None:
            report["errors"].append("load_asset returned None: " + p)
            continue
        e = {"path": p}
        try:
            bs = a.get_editor_property("body_setup")
            if bs is not None:
                e["collision_trace_flag"] = str(bs.get_editor_property("collision_trace_flag"))
                ag = bs.get_editor_property("agg_geom")
                if ag is not None:
                    e["convex_elems"] = len(ag.get_editor_property("convex_elems") or [])
                    e["box_elems"] = len(ag.get_editor_property("box_elems") or [])
            else:
                e["body_setup"] = "none"
        except Exception as ex:
            e["collision_err"] = str(ex)
        found = []
        for sn in ("Socket_Bottom", "Socket_Top"):
            try:
                s = a.find_socket(sn)
                if s is not None:
                    rl = s.get_editor_property("relative_location")
                    found.append({"name": sn, "loc": [round(rl.x,2), round(rl.y,2), round(rl.z,2)]})
            except Exception as ex:
                found.append({"name": sn, "err": str(ex)})
        e["sockets"] = found
        report["assets"].append(e)
    except Exception as ex:
        report["errors"].append(p + ": " + str(ex))
report["ok"] = len(report["errors"]) == 0 and len(report["assets"]) == len(names)
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0)
