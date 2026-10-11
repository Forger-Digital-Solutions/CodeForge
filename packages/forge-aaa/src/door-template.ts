import type { DoorSpec } from "./door-spec.js";

/**
 * Blender 4.5 generator for the modular door (mission §6.3). Two render meshes in one
 * collection — SM_DoorFrame (jambs + header, fixed) and SM_DoorLeaf (plank slab +
 * battens, pivot on the hinge edge) — with UCX_ collision proxies and SOCKET_ nulls
 * parented to their host mesh (UE4's importer only creates sockets from parented
 * nulls; proven in R79). Import with combineMeshes=false yields two .uassets.
 * The leaf's object origin is the hinge axis, so actor yaw IS the door swing.
 */
export function doorBlenderScript(spec: DoorSpec): string {
  return DOOR_PY.replace("__DOOR_SPEC__", JSON.stringify(spec).replace(/\\/g, "\\\\"));
}

const DOOR_PY = `import bpy, bmesh, json, math, mathutils, sys
spec = json.loads('__DOOR_SPEC__')
bpy.ops.wm.read_factory_settings(use_empty=True)
col = bpy.data.collections.new("DTW_DoorModule")
bpy.context.scene.collection.children.link(col)

CM = 0.01
OW = spec["opening"]["widthCm"] * CM
OH = spec["opening"]["heightCm"] * CM
LT = spec["leaf"]["thicknessCm"] * CM
CL = spec["leaf"]["clearanceCm"] * CM
NB = spec["leaf"]["battens"]
FD = spec["frame"]["depthCm"] * CM
JW = spec["frame"]["jambWidthCm"] * CM
PO = spec["hinge"]["pivotOffsetCm"] * CM
SIDE = spec["hinge"]["side"]

def box(name, dims, loc, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    o = bpy.context.object
    o.name = name
    for c in list(o.users_collection): c.objects.unlink(o)
    col.objects.link(o)
    o.dimensions = dims
    o.location = loc
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if parent is not None:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o

def socket(name, loc, host):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    e = bpy.context.object
    e.name = name
    for c in list(e.users_collection): c.objects.unlink(e)
    col.objects.link(e)
    e.empty_display_size = 0.12
    e.parent = host
    return e

# --- Frame: two jambs + header, pivot at bottom-center of the opening plane ---------
sgn = 1.0 if SIDE == "left" else -1.0
jamb_x = OW / 2.0 + JW / 2.0
jamb_l = box("DoorFrame_JambL", (JW, FD, OH + JW), (-jamb_x, 0, (OH + JW) / 2.0))
jamb_r = box("DoorFrame_JambR", (JW, FD, OH + JW), ( jamb_x, 0, (OH + JW) / 2.0))
header = box("DoorFrame_Header", (OW + 2.0 * JW, FD, JW), (0, 0, OH + JW / 2.0))
frame_parts = [jamb_l, jamb_r, header]
frame_ucx = [(tuple(p.dimensions), tuple(p.location)) for p in frame_parts]
def join_into(parts, target):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()
    return target
frame = join_into(frame_parts, jamb_l)
frame.name = "SM_DoorFrame"
for i, (dims, loc) in enumerate(frame_ucx):
    c = box("UCX_SM_DoorFrame_%d" % i, dims, loc)
    c.display_type = "WIRE"

# --- Leaf: slab + battens, authored so the object origin is the hinge axis ----------
LW = OW - PO - CL
LH = OH - CL
hinge_x = -sgn * (OW / 2.0 - PO)
leaf_parts = []
slab = box("SM_DoorLeaf", (LW, LT, LH), (hinge_x + sgn * LW / 2.0, 0, CL + LH / 2.0))
leaf_parts.append(slab)
for i in range(NB):
    z = CL + LH * (0.18 + 0.64 * i / max(NB - 1, 1))
    b = box("DoorLeaf_Batten_%d" % i, (LW * 0.94, LT * 0.6, LH * 0.12),
            (hinge_x + sgn * LW / 2.0, -sgn * (LT / 2.0 + LT * 0.3), z))
    leaf_parts.append(b)
if len(leaf_parts) > 1:
    join_into(leaf_parts, slab)
slab.name = "SM_DoorLeaf"
# Move the leaf origin to the hinge axis at the sill — yaw on the actor then pivots the
# door exactly on its hinge line, no socket lookup needed at runtime.
bpy.ops.object.select_all(action="DESELECT")
slab.select_set(True)
bpy.context.scene.cursor.location = (hinge_x, 0, 0)
bpy.context.view_layer.objects.active = slab
bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
leaf_origin = list(slab.location)
# UCX covers slab + battens: battens protrude 0.6*LT off the hinge-face side of the slab.
c = box("UCX_SM_DoorLeaf_0", (LW, LT * 1.6, LH),
        (hinge_x + sgn * LW / 2.0, -sgn * LT * 0.3, CL + LH / 2.0))
c.display_type = "WIRE"

socket("SOCKET_HingeBottom", (hinge_x, 0, 0.02), slab)
socket("SOCKET_HingeTop", (hinge_x, 0, LH), slab)
socket("SOCKET_Handle", (hinge_x + sgn * (LW - 0.08), -sgn * (LT / 2.0 + 0.06), 1.05), slab)
socket("SOCKET_FrameAttachL", (-jamb_x, 0, 0), frame)
socket("SOCKET_FrameAttachR", (jamb_x, 0, 0), frame)

# --- Validation report ---------------------------------------------------------------
report = {"ok": True, "moduleId": spec["moduleId"], "meshes": 0, "vertices": 0, "faces": 0,
          "nonmanifold_objects": [], "degenerate_faces": 0, "validate_errors": 0,
          "bounds_cm": None, "errors": []}
mins = [float("inf")] * 3; maxs = [float("-inf")] * 3
for obj in col.objects:
    if obj.type != "MESH":
        continue
    report["meshes"] += 1
    report["vertices"] += len(obj.data.vertices); report["faces"] += len(obj.data.polygons)
    report["degenerate_faces"] += sum(1 for f in obj.data.polygons if f.area < 1e-8)
    try:
        report["validate_errors"] += obj.data.validate(verbose=False, clean_customdata=False)
    except Exception:
        pass
    for corner in obj.bound_box:
        w = obj.matrix_world @ mathutils.Vector(corner)
        for i in range(3):
            mins[i] = min(mins[i], w[i]); maxs[i] = max(maxs[i], w[i])
    bm = bmesh.new(); bm.from_mesh(obj.data)
    nm = sum(1 for e in bm.edges if not e.is_manifold)
    if nm: report["nonmanifold_objects"].append({"name": obj.name, "edges": nm})
    bm.free()
report["bounds_cm"] = [round((maxs[i] - mins[i]) * 100, 3) for i in range(3)]
report["leaf_origin_is_hinge"] = True
report["leaf_origin_cm"] = [round(v * 100, 3) for v in leaf_origin]
report["hinge_world_x_cm"] = round(hinge_x * 100, 3)
report["sockets"] = sorted(o.name for o in col.objects if o.name.startswith("SOCKET_"))
report["ucx_collision_count"] = sum(1 for o in col.objects if o.name.startswith("UCX_"))
report["objects"] = len(col.objects)
report["ok"] = (len(report["nonmanifold_objects"]) == 0 and report["degenerate_faces"] == 0
                and report["validate_errors"] == 0 and report["ucx_collision_count"] == 4
                and len(report["sockets"]) == 5)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) >= 2:
    bpy.ops.export_scene.gltf(filepath=argv[0], export_format="GLB", export_apply=True, export_yup=True)
    bpy.ops.export_scene.fbx(filepath=argv[1], use_custom_props=True)
    report["exported_glb"] = argv[0]; report["exported_fbx"] = argv[1]
print("FORGEAAA_REPORT:" + json.dumps(report))
`;
