import unreal,json,sys
mesh=unreal.EditorAssetLibrary.load_asset("/Game/ForgeAAA/R82/SM_PlankFloor")
data=mesh.get_editor_property("asset_import_data")
actor=unreal.EditorLevelLibrary.spawn_actor_from_object(mesh,unreal.Vector(0,0,0))
origin,extent=actor.get_actor_bounds(False)
report={"ok":True,"dimensionsCm":[extent.x*2,extent.y*2,extent.z*2],"options":{k:str(data.get_editor_property(k)) for k in ["transform_vertex_to_absolute","convert_scene_unit","convert_scene","import_uniform_scale","bake_pivot_in_vertex"]}}
print("FORGEAAA_REPORT:"+json.dumps(report))
sys.exit(0)
