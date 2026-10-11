import unreal, json, sys

# R81 native test map builder — dev-time editor automation only. Builds
# /Game/ForgeAAA/Maps/FAAA_NativeDoorTest: geometry identical in convention to
# the R80 door rig (frame+leaf at origin, hinge x=-48, walls/lintel/floor) plus
# a second door instance at y=800, a PlayerStart, the ForgeDoorTestDriver, and
# ForgeGameplayMode bound in WorldSettings. All gameplay behavior lives in the
# compiled ForgeGameplay module — this script only authors level content.

LEVEL = "/Game/ForgeAAA/Maps/FAAA_NativeDoorTest"
report = {"ok": True, "level": LEVEL, "actors": [], "errors": []}
ell = unreal.EditorLevelLibrary
eal = unreal.EditorAssetLibrary

try:
    if eal.does_asset_exist(LEVEL):
        ell.load_level(LEVEL)
        report["level_action"] = "loaded"
    else:
        ell.new_level(LEVEL)
        report["level_action"] = "created"

    # Idempotent rebuild: drop prior FAAA_* and ForgeGameplay actors.
    doomed = []
    for a in ell.get_all_level_actors():
        try:
            cname = a.get_class().get_name()
            label = a.get_actor_label()
            if label.startswith("FAAA_") or cname in ("ForgeInteractableDoor", "ForgeDoorTestDriver", "PlayerStart"):
                doomed.append(a)
        except Exception:
            pass
    for a in doomed:
        try:
            a.destroy_actor()
        except Exception:
            pass

    def place(name, asset_path, loc, scale=None):
        asset = eal.load_asset(asset_path)
        if asset is None:
            report["errors"].append("asset missing: " + asset_path)
            return None
        a = ell.spawn_actor_from_object(asset, unreal.Vector(*loc), unreal.Rotator(0, 0, 0))
        if a is None:
            report["errors"].append("spawn failed: " + name)
            return None
        a.set_actor_label(name)
        if scale is not None:
            a.set_actor_scale3d(unreal.Vector(*scale))
        report["actors"].append(name)
        return a

    OW, OH, JW, WT = 100, 210, 5, 255
    place("FAAA_Floor", "/Engine/BasicShapes/Cube", (0, 400, -5), (40, 40, 0.1))
    for y in (0, 800):
        place("FAAA_WallL_%d" % y, "/Engine/BasicShapes/Cube", (-150, y + 5, 127.5), (2, 0.2, 2.55))
        place("FAAA_WallR_%d" % y, "/Engine/BasicShapes/Cube", (150, y + 5, 127.5), (2, 0.2, 2.55))
        place("FAAA_Lintel_%d" % y, "/Engine/BasicShapes/Cube", (0, y + 5, 240), (1.1, 0.2, 0.4))

    door_cls = unreal.load_class(None, "/Script/ForgeGameplay.ForgeInteractableDoor")
    gm_cls = unreal.load_class(None, "/Script/ForgeGameplay.ForgeGameplayMode")
    drv_cls = unreal.load_class(None, "/Script/ForgeGameplay.ForgeDoorTestDriver")
    ps_cls = unreal.load_class(None, "/Script/Engine.PlayerStart")
    if door_cls is None or drv_cls is None or gm_cls is None:
        report["errors"].append("ForgeGameplay classes unavailable — plugin module not loaded")
        raise SystemExit(2)
    leaf = eal.load_asset("/Game/ForgeAAA/door_SM_DoorLeaf")
    frame = eal.load_asset("/Game/ForgeAAA/door_SM_DoorFrame")
    if leaf is None or frame is None:
        report["errors"].append("door meshes missing — run the R80 import first")
        raise SystemExit(2)

    for did, y in (("door-western-a", 0), ("door-western-b", 800)):
        d = ell.spawn_actor_from_class(door_cls, unreal.Vector(0, y, 0), unreal.Rotator(0, 0, 0))
        if d is None:
            report["errors"].append("door spawn failed: " + did)
            continue
        d.set_actor_label("FAAA_" + did)
        d.set_editor_property("DoorInstanceId", did)
        d.set_editor_property("OpenAngleDeg", -95.0)
        d.set_editor_property("TransitionS", 0.8)
        fm = d.get_editor_property("FrameMesh")
        if fm is not None:
            fm.set_editor_property("static_mesh", frame)
        lm = d.get_editor_property("LeafMesh")
        if lm is not None:
            lm.set_editor_property("static_mesh", leaf)
        report["actors"].append(did)

    ps = ell.spawn_actor_from_class(ps_cls, unreal.Vector(0, -150, 92), unreal.Rotator(0, 90, 0))
    if ps is not None:
        ps.set_actor_label("FAAA_PlayerStart")
        report["actors"].append("playerstart")

    drv = ell.spawn_actor_from_class(drv_cls, unreal.Vector(0, -300, 0), unreal.Rotator(0, 0, 0))
    if drv is not None:
        drv.set_actor_label("FAAA_Driver")
        report["actors"].append("driver")

    # Bind the Forge game mode through the map's WorldSettings — no ini needed.
    # (WorldSettings is not returned by get_all_level_actors; it hangs off the
    # editor world object directly.)
    ws = ell.get_editor_world().get_world_settings()
    bound = False
    if ws is not None:
        ws.set_editor_property("default_game_mode", gm_cls)
        bound = True
    report["game_mode_bound"] = bound
    if not bound:
        report["errors"].append("no WorldSettings object on editor world")

    ell.save_current_level()
    report["level_saved"] = True
    report["actor_count"] = len(ell.get_all_level_actors())
except SystemExit:
    pass
except Exception as e:
    report["ok"] = False
    report["errors"].append("fatal: " + str(e))

report["ok"] = report["ok"] and len(report["errors"]) == 0
print("FORGEAAA_REPORT:" + json.dumps(report))
sys.exit(0 if report["ok"] else 2)
