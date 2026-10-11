import { writeFile } from "node:fs/promises";
import path from "node:path";
import { R83_TWO_ROOM_MODULES } from "../../packages/forge-aaa/dist/r83-building-spec.js";
import { python, evidenceDir } from "./live-utils.mjs";
const modules=R83_TWO_ROOM_MODULES.filter(m=>m.sockets.length>0);
const result=await python(`r83-attachment-sockets-${Date.now()}`,`import unreal,json,sys
spec = json.loads(${JSON.stringify(JSON.stringify(modules))})
report = {"ok":False,"changes":[],"verified":[],"errors":[],"scope":"R83 pilot mesh socket metadata only; source geometry unchanged"}
try:
    for m in spec:
        mesh = unreal.EditorAssetLibrary.load_asset(m["engineAsset"])
        for definition in m["sockets"]:
            socket = mesh.find_socket(definition["id"])
            if socket is None:
                socket = unreal.StaticMeshSocket(outer=mesh)
                socket.set_editor_property("socket_name",definition["id"])
                socket.set_editor_property("relative_location",unreal.Vector(*definition["localPosCm"]))
                mesh.add_socket(socket)
                if not unreal.EditorAssetLibrary.save_loaded_asset(mesh): raise RuntimeError("socket save failed")
                report["changes"].append({"mesh":m["engineAsset"],"socket":definition["id"],"positionCm":definition["localPosCm"]})
            p=socket.relative_location
            if max(abs(v-w) for v,w in zip((p.x,p.y,p.z),definition["localPosCm"]))>0.1: raise RuntimeError("socket placement differs " + definition["id"])
            report["verified"].append({"mesh":m["engineAsset"],"socket":str(socket.socket_name),"positionCm":[p.x,p.y,p.z]})
    report["ok"]=True
except Exception as error: report["errors"].append(str(error))
print("FORGEAAA_REPORT:"+json.dumps(report))
sys.exit(0 if report["ok"] else 2)
`);
const file=path.join(evidenceDir,`attachment-socket-repair-${Date.now()}.json`);await writeFile(file,JSON.stringify(result,null,2));
console.log(JSON.stringify({file,ok:result.ok,report:result.report}));if(!result.ok||!result.report?.ok)process.exitCode=1;
