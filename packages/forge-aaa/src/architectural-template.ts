export interface ArchitecturalMeshSpec {
  name: string;
  parts: { dimensionsCm: [number, number, number]; centerCm: [number, number, number]; material: "wood" | "plaster" | "glass" }[];
  collision: { dimensionsCm: [number, number, number]; centerCm: [number, number, number] }[];
}

export function architecturalBlenderScript(meshes: readonly ArchitecturalMeshSpec[]): string {
  if (meshes.length === 0 || meshes.length > 64 || new Set(meshes.map((m) => m.name)).size !== meshes.length) throw new Error("invalid mesh set");
  for (const mesh of meshes) {
    if (!/^SM_[A-Za-z0-9_]+$/.test(mesh.name) || !mesh.parts.length || !mesh.collision.length) throw new Error("invalid architectural mesh");
    for (const p of [...mesh.parts, ...mesh.collision]) {
      if (p.dimensionsCm.length !== 3 || p.centerCm.length !== 3 || !p.dimensionsCm.every((n) => Number.isFinite(n) && n > 0 && n <= 10000) || !p.centerCm.every(Number.isFinite)) throw new Error("invalid architectural geometry");
    }
  }
  return TEMPLATE.replace("__SPEC__", JSON.stringify(JSON.stringify(meshes)));
}

const TEMPLATE = `import bpy, bmesh, json, sys, os, mathutils
spec = json.loads(__SPEC__)
out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
materials = {}
for name, color in [("wood",(0.25,0.12,0.045,1)),("plaster",(0.65,0.58,0.44,1)),("glass",(0.16,0.30,0.34,1))]:
    mat = bpy.data.materials.new("Forge_" + name)
    mat.diffuse_color = color
    materials[name] = mat
report = {"ok":True,"engine":"Blender " + bpy.app.version_string,"assets":[],"errors":[]}
def box(name, part):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = [v/100 for v in part["dimensionsCm"]]
    obj.location = [v/100 for v in part["centerCm"]]
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(materials[part.get("material","wood")])
    return obj
for m in spec:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    parts = [box(m["name"] + "_part" + str(i),p) for i,p in enumerate(m["parts"])]
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    mesh = parts[0]
    mesh.name = m["name"]
    bpy.context.scene.cursor.location = (0,0,0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    proxies = [box("UCX_" + m["name"] + "_" + str(i),p) for i,p in enumerate(m["collision"])]
    socket = bpy.data.objects.new("SOCKET_AssemblyOrigin",None)
    bpy.context.collection.objects.link(socket)
    socket.parent = mesh
    checks = []
    for obj in [mesh] + proxies:
        bm = bmesh.new(); bm.from_mesh(obj.data)
        nonmanifold = sum(1 for e in bm.edges if not e.is_manifold)
        degenerate = sum(1 for f in bm.faces if f.calc_area() < 1e-9)
        volume = bm.calc_volume(signed=True)
        checks.append({"name":obj.name,"nonmanifoldEdges":nonmanifold,"degenerateFaces":degenerate,"signedVolumeM3":volume})
        bm.free()
        if nonmanifold or degenerate or volume <= 0: report["errors"].append(obj.name + " invalid topology/normals")
    bpy.context.view_layer.update()
    bounds = [(mesh.matrix_world @ mathutils.Vector(v))*100 for v in mesh.bound_box]
    minimum = [min(v[k] for v in bounds) for k in range(3)]
    maximum = [max(v[k] for v in bounds) for k in range(3)]
    fbx = os.path.join(out,m["name"] + ".fbx")
    blend = os.path.join(out,m["name"] + ".blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    bpy.ops.export_scene.fbx(filepath=fbx, use_selection=False, axis_forward="-Y",axis_up="Z",use_custom_props=True)
    report["assets"].append({"name":m["name"],"boundsMinCm":minimum,"boundsMaxCm":maximum,"dimensionsCm":[maximum[k]-minimum[k] for k in range(3)],"pivotCm":list(mesh.location*100),"scale":list(mesh.scale),"materialSlots":[s.name for s in mesh.data.materials],"collisionCount":len(proxies),"checks":checks,"fbx":fbx,"blend":blend})
report["ok"] = not report["errors"]
print("FORGEAAA_REPORT:" + json.dumps(report))
`;
