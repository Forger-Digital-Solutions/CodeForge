import unreal, json, sys
report = {"ok": True, "created": [], "errors": []}
# Sockets: name -> (mesh asset path, relative_location, documented purpose)
SOCKETS = [
    ("stair-module-v2_Step_00", "Socket_MountBottom", (-13.5, 0.0, 0.0), "entry edge, floor level"),
    ("stair-module-v2_Step_05", "Socket_MountTop", (13.5, 0.0, 18.0), "top landing edge"),
    ("stair-module-v2_Handrail", "Socket_RailStart", (11.28, -40.0, 104.67), "lower rail end"),
    ("stair-module-v2_Handrail", "Socket_RailEnd", (150.72, -40.0, 201.33), "upper rail end"),
]
try:
    lib = unreal.EditorAssetLibrary
    for mesh_name, sock_name, loc, purpose in SOCKETS:
        path = "/Game/ForgeAAA/" + mesh_name
        mesh = lib.load_asset(path)
        if mesh is None:
            report["errors"].append("missing mesh: " + path)
            continue
        try:
            existing = mesh.find_socket(sock_name)
            if existing is not None:
                report["created"].append({"mesh": mesh_name, "socket": sock_name, "action": "already-present"})
                continue
            sock = unreal.StaticMeshSocket(mesh)
            sock.set_editor_property("socket_name", sock_name)
            sock.set_editor_property("relative_location", unreal.Vector(loc[0], loc[1], loc[2]))
            sock.set_editor_property("relative_rotation", unreal.Rotator(0, 0, 0))
            mesh.add_socket(sock)
            lib.save_loaded_asset(mesh)
            back = mesh.find_socket(sock_name)
            entry = {"mesh": mesh_name, "socket": sock_name, "action": "created", "purpose": purpose,
                     "verified": back is not None}
            if back is not None:
                rl = back.get_editor_property("relative_location")
                entry["rel"] = [round(rl.x, 2), round(rl.y, 2), round(rl.z, 2)]
            report["created"].append(entry)
        except Exception as e:
            report["errors"].append(mesh_name + "/" + sock_name + ": " + str(e))
except Exception as e:
    report["ok"] = False
    report["errors"].append("fatal: " + str(e))
report["ok"] = report["ok"] and len(report["errors"]) == 0 and all(c.get("verified") or c.get("action") == "already-present" for c in report["created"]) and len(report["created"]) == len(SOCKETS)
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0)
