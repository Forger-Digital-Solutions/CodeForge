import unreal, json

ell, eal = unreal.EditorLevelLibrary, unreal.EditorAssetLibrary
LEVEL = "/Game/ForgeAAA/Maps/FAAA_R82InteriorV2"
report = {"ok": False, "errors": [], "materials": [], "actors": []}
try:
    if not ell.load_level(LEVEL): raise RuntimeError("room level unavailable")
    materials = {}
    for name, color in [("wood", (0.25,0.12,0.045)), ("plaster", (0.65,0.58,0.44)), ("glass", (0.12,0.28,0.34))]:
        asset_path = "/Game/ForgeAAA/R82/M_" + name
        mat = eal.load_asset(asset_path)
        if mat is None:
            mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset("M_"+name,"/Game/ForgeAAA/R82",unreal.Material,unreal.MaterialFactoryNew())
            expr = unreal.MaterialEditingLibrary.create_material_expression(mat,unreal.MaterialExpressionConstant3Vector,0,0)
            expr.set_editor_property("constant",unreal.LinearColor(*color,1))
            unreal.MaterialEditingLibrary.connect_material_property(expr,"",unreal.MaterialProperty.MP_BASE_COLOR)
            rough = unreal.MaterialEditingLibrary.create_material_expression(mat,unreal.MaterialExpressionConstant,0,100)
            rough.set_editor_property("r",0.8 if name != "glass" else 0.1)
            unreal.MaterialEditingLibrary.connect_material_property(rough,"",unreal.MaterialProperty.MP_ROUGHNESS)
            if name == "glass":
                mat.set_editor_property("blend_mode",unreal.BlendMode.BLEND_TRANSLUCENT)
                mat.set_editor_property("two_sided",True)
                opacity = unreal.MaterialEditingLibrary.create_material_expression(mat,unreal.MaterialExpressionConstant,0,200)
                opacity.set_editor_property("r",0.28)
                unreal.MaterialEditingLibrary.connect_material_property(opacity,"",unreal.MaterialProperty.MP_OPACITY)
            unreal.MaterialEditingLibrary.recompile_material(mat)
            eal.save_loaded_asset(mat)
        materials[name] = mat
        report["materials"].append(asset_path)
    assets = list(eal.list_assets("/Game/ForgeAAA/R82",True,False))
    assets += ["/Game/ForgeAAA/door_SM_DoorFrame","/Game/ForgeAAA/door_SM_DoorLeaf"]
    for p in assets:
        mesh = eal.load_asset(p)
        if not isinstance(mesh,unreal.StaticMesh): continue
        slots = mesh.get_editor_property("static_materials")
        for n,slot in enumerate(slots):
            name = str(slot.material_slot_name).lower()
            kind = "glass" if "glass" in name else "plaster" if "plaster" in name else "wood"
            mesh.set_material(n,materials[kind])
        eal.save_loaded_asset(mesh)
    existing = {}
    for actor in ell.get_all_level_actors():
        for tag in actor.tags or []: existing[str(tag)] = actor
    def place(role, cls, location, rotation=(0,0,0)):
        identity = "forge-r82:" + role
        actor = existing.get(identity)
        if actor is None:
            actor = ell.spawn_actor_from_class(cls,unreal.Vector(*location),unreal.Rotator(*rotation))
            actor.tags = [unreal.Name(identity)]
            actor.set_actor_label("R82_"+role)
        report["actors"].append({"role":role,"path":actor.get_path_name()})
        return actor
    place("start",unreal.PlayerStart,(0,-200,96),(0,90,0))
    place("driver",unreal.load_class(None,"/Script/ForgeGameplay.ForgeDoorTestDriver"),(0,-220,0))
    sun = place("sun",unreal.DirectionalLight,(0,0,800),(-35,-30,0))
    sun.get_component_by_class(unreal.DirectionalLightComponent).set_editor_property("intensity",1)
    for x in (0,1000):
        light = place("interior-light-"+str(x),unreal.PointLight,(x,260,215))
        c = light.get_component_by_class(unreal.PointLightComponent)
        c.set_editor_property("intensity",150)
        c.set_editor_property("attenuation_radius",750)
        c.set_editor_property("light_color",unreal.Color(255,220,170,255))
        c.set_editor_property("mobility",unreal.ComponentMobility.MOVABLE)
    light = place("exterior-light",unreal.PointLight,(0,-160,200))
    light.get_component_by_class(unreal.PointLightComponent).set_editor_property("intensity",150)
    light.get_component_by_class(unreal.PointLightComponent).set_editor_property("attenuation_radius",1200)
    ell.get_editor_world().get_world_settings().set_editor_property("default_game_mode",unreal.load_class(None,"/Script/ForgeGameplay.ForgeGameplayMode"))
    if not ell.save_current_level(): raise RuntimeError("level save failed")
    report["actorCount"] = len(ell.get_all_level_actors())
    report["level_saved"] = True
    report["ok"] = True
except Exception as e:
    import traceback
    report["errors"].append(traceback.format_exc())
print("FORGEAAA_REPORT:"+json.dumps(report))
import sys
sys.exit(0 if report["ok"] else 2)
