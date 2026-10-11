import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { python, evidenceDir } from "./live-utils.mjs";
const file = (await readdir(evidenceDir)).filter(f=>/^native-diagnostic-\d+\.json$/.test(f)).sort().at(-1);
const prior = JSON.parse(await readFile(path.join(evidenceDir,file),"utf8")).reports[0];
const result = await python("r83-diagnostic-reload",`import unreal, json, sys
ell = unreal.EditorLevelLibrary
level = ${JSON.stringify(prior.level)}
identity = ${JSON.stringify(prior.identity)}
report = {"ok": False, "level":level, "identity":identity, "actors":[], "newBlankMapBinding":unreal.EditorLoadingAndSavingUtils.new_blank_map.__doc__}
try:
    if not ell.load_level(level): raise RuntimeError("load failed")
    for a in ell.get_all_level_actors():
        if identity in [str(t) for t in a.tags]:
            p,r,s = a.get_actor_location(),a.get_actor_rotation(),a.get_actor_scale3d()
            report["actors"].append({"actor":a.get_path_name(),"positionCm":[p.x,p.y,p.z],"rotation":{"pitch":r.pitch,"yaw":r.yaw,"roll":r.roll},"scale":[s.x,s.y,s.z]})
    if len(report["actors"]) != 1: raise RuntimeError("identity count mismatch")
    a = report["actors"][0]
    if max(abs(v-w) for v,w in zip(a["positionCm"],[290,260,0]))>0.1 or abs(a["rotation"]["yaw"]-90)>0.1 or abs(a["rotation"]["pitch"])+abs(a["rotation"]["roll"])>0.1: raise RuntimeError("reload transform mismatch")
    world = unreal.EditorLoadingAndSavingUtils.new_blank_map(False)
    report["unloadedWorld"] = world.get_path_name() if world else None
    if world is None: raise RuntimeError("blank map failed")
    report["ok"] = True
except Exception as error: report["error"] = str(error)
print("FORGEAAA_REPORT:"+json.dumps(report))
sys.exit(0 if report["ok"] else 2)
`);
await writeFile(path.join(evidenceDir,`native-reload-${Date.now()}.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
