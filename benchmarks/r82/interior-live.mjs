import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { BlenderAdapter, UnrealAdapter, architecturalBlenderScript, doorBlenderScript, validateDoorSpec, validateBuildingDefinition } from "../../packages/forge-aaa/dist/index.js";
import { room, roomGeometry, roomBuilding } from "./room-spec.mjs";

const root=path.resolve('.scratch'), project=path.join(root,'pilot','DeadTrailsWest.uproject');
const evidenceDir='docs/evidence/r82-forgeaaa-modular-western-interior';
await mkdir(evidenceDir,{recursive:true}); await mkdir(root,{recursive:true});
const report={startedAt:new Date().toISOString(),kind:'R82_INTERIOR_ENGINE_CAMPAIGN',phase:process.argv[2]??'assets',project,room};
const evidenceFile=`${evidenceDir}/${report.phase}-${Date.now()}.json`;
const persist=()=>writeFile(evidenceFile,JSON.stringify(report,null,2));
const blender=new BlenderAdapter(), unreal=new UnrealAdapter();
const install=(await unreal.detect()).installs.find(i=>i.version.major===4&&i.version.minor===27);
if(!install) throw new Error('UE4.27 unavailable');
report.engine=install;
const hash=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const runPython=async(name,source)=>{
 const scriptPath=path.join(root,name+'.py'); await writeFile(scriptPath,source);
 const result=await unreal.runPythonScript({projectPath:project,scriptPath,install,host:'editor',logPath:path.join(root,name+'.log'),timeoutMs:240000});
 await writeFile(`${evidenceDir}/${name}-${Date.now()}.json`,JSON.stringify(result,null,2));
 if(!result.ok||result.report?.ok!==true) throw new Error(name+': '+JSON.stringify(result.report??result.error));
 return result.report;
};
try {
if(report.phase==='assets') {
 report.blender=await blender.runHeadless({op:'custom',approved:true,scriptSource:architecturalBlenderScript(roomGeometry()),args:[path.join(root,'architecture')],timeoutMs:240000}); await persist();
 if(!report.blender.ok||report.blender.report?.ok!==true) throw new Error('architecture generation failed');
 const doorDoc=JSON.parse(await readFile('docs/evidence/r80-forgeaaa-autonomous-gameplay/model-door-spec-1791696265026.json','utf8'));
 const doorSpec=validateDoorSpec(doorDoc.doorSpec);
 report.door=await blender.runHeadless({op:'custom',approved:true,scriptSource:doorBlenderScript(doorSpec),args:[path.join(root,'door.glb'),path.join(root,'door.fbx')],timeoutMs:240000}); await persist();
 if(!report.door.ok) throw new Error('door generation failed');
 const files=(await readdir(path.join(root,'architecture'))).filter(f=>f.endsWith('.fbx')).map(f=>path.join(root,'architecture',f));
 report.import=await runPython('import-architecture',`import unreal,json
eal=unreal.EditorAssetLibrary
files=json.loads(${JSON.stringify(JSON.stringify(files))})
dimensions=json.loads(${JSON.stringify(JSON.stringify(Object.fromEntries(report.blender.report.assets.map(a=>[a.name,a.dimensionsCm]))))})
report={"ok":True,"assets":[],"errors":[]}
for filename in files:
 task=unreal.AssetImportTask(); task.filename=filename; task.destination_path="/Game/ForgeAAA/R82"; task.automated=True; task.save=True; task.replace_existing=True
 task.replace_existing_settings=True
 opts=unreal.FbxImportUI(); opts.import_mesh=True; opts.import_materials=False; opts.import_textures=False; opts.import_as_skeletal=False
 opts.static_mesh_import_data.set_editor_property("combine_meshes",False)
 opts.static_mesh_import_data.set_editor_property("transform_vertex_to_absolute",True)
 opts.static_mesh_import_data.set_editor_property("convert_scene_unit",True)
 opts.static_mesh_import_data.set_editor_property("auto_generate_collision",False)
 task.options=opts
 expected="/Game/ForgeAAA/R82/"+filename.replace("\\\\","/").rsplit("/",1)[-1].replace(".fbx","")
 if eal.does_asset_exist(expected):
  existing_data=eal.load_asset(expected).get_editor_property("asset_import_data")
  existing_data.set_editor_property("transform_vertex_to_absolute",True)
  existing_data.set_editor_property("convert_scene_unit",True)
  eal.save_loaded_asset(eal.load_asset(expected))
 unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
 paths=list(task.imported_object_paths)
 if not paths: report["errors"].append("no imported mesh: "+filename)
 for p in paths:
  asset=eal.load_asset(p)
  body=asset.get_editor_property("body_setup")
  agg=body.get_editor_property("agg_geom")
  actor=unreal.EditorLevelLibrary.spawn_actor_from_object(asset,unreal.Vector(0,0,0))
  origin,extent=actor.get_actor_bounds(False)
  measured=[extent.x*2,extent.y*2,extent.z*2]
  actor.destroy_actor()
  if max(abs(v-w) for v,w in zip(measured,dimensions[asset.get_name()]))>0.2: report["errors"].append("import scale mismatch: "+asset.get_name()+str(measured))
  report["assets"].append({"path":p,"class":asset.get_class().get_name(),"dimensionsCm":measured,"collisionConvex":len(agg.get_editor_property("convex_elems")),"collisionBoxes":len(agg.get_editor_property("box_elems")),"materials":len(asset.get_editor_property("static_materials")),"assemblySocket":asset.find_socket("AssemblyOrigin") is not None})
report["ok"]=not report["errors"]
print("FORGEAAA_REPORT:"+json.dumps(report))
import sys
sys.exit(0 if report["ok"] else 2)
`);
 report.doorImport=await unreal.importAssets({projectPath:project,files:[path.join(root,'door.fbx')],destinationPath:'/Game/ForgeAAA',settingsPath:path.join(root,'door-import.json'),timeoutMs:240000,install});
 report.doorFiles=(await readdir(path.join(root,'pilot/Content/ForgeAAA'))).filter(f=>f.includes('Door'));
 if(report.doorFiles.length!==2) throw new Error('door import incomplete');
 const modules=[];
 for(const a of report.blender.report.assets) {
  if(a.name==='SM_WindowSash') continue;
  const dims=a.dimensionsCm;
  const type=a.name==='SM_WindowFrame'?'window':a.name.includes('Floor')?'floor':a.name==='SM_Ceiling'?'roof':'wall';
  modules.push({contractVersion:1,moduleVersion:1,moduleId:'forge/building/'+a.name+'/v1',moduleType:type,displayName:a.name,dimensions:{widthCm:dims[0],depthCm:dims[1],heightCm:dims[2]},pivot:{kind:type==='window'?'custom':'center',...(type==='window'?{offsetCm:[0,0,0]}:{})},sockets:a.name==='SM_PlankFloor'?[{id:'door',localPosCm:[0,-room.depthCm/2-room.wallThicknessCm/2,room.floorThicknessCm/2],accepts:['door']},{id:'window',localPosCm:[0,room.depthCm/2+room.wallThicknessCm/2,room.sillCm+room.floorThicknessCm/2],accepts:['window']}]:[],collision:{profile:'block-all'},provenance:{authoredBy:'deterministic'},engines:{unreal:['4.27'],blender:['4.5']},sourceAsset:'architecture/'+a.name+'.fbx',engineAsset:'/Game/ForgeAAA/R82/'+a.name,coordinateSystem:'unreal-cm-z-up',materials:a.materialSlots,dependencies:[],validationStatus:'geometry-verified',contentSha256:await hash(path.join(root,'architecture',a.name+'.fbx')),...(type==='window'?{nativeClass:'/Script/ForgeGameplay.ForgeInteractableWindow',leafAsset:'/Game/ForgeAAA/R82/SM_WindowSash',persistence:{identityFrom:'instanceId',stateFields:['state','slideCm'],schemaVersion:1},interaction:{interface:'IForgeInteractable',states:['closed','opening','open','closing'],initialState:'closed'}}:{})});
 }
 const door=JSON.parse(await readFile('benchmarks/r81/module-contracts/door-western.module.json','utf8'));
 modules.push({...door,moduleVersion:1,sourceAsset:'door.fbx',engineAsset:'/Game/ForgeAAA/door_SM_DoorFrame',leafAsset:'/Game/ForgeAAA/door_SM_DoorLeaf',nativeClass:'/Script/ForgeGameplay.ForgeInteractableDoor',coordinateSystem:'unreal-cm-z-up',materials:['wood'],dependencies:[],validationStatus:'geometry-verified',contentSha256:await hash(path.join(root,'door.fbx')),persistence:{...door.persistence,identityFrom:'instanceId'}});
 await writeFile('benchmarks/r82/module-registry.json',JSON.stringify(modules,null,2));
 await writeFile('benchmarks/r82/building.json',JSON.stringify(validateBuildingDefinition(roomBuilding(modules),modules),null,2));
}
if(report.phase==='assemble') {
 const modules=JSON.parse(await readFile('benchmarks/r82/module-registry.json','utf8'));
 const building=JSON.parse(await readFile('benchmarks/r82/building.json','utf8'));
 const req={projectPath:project,authorizedProjectPath:project,levelPath:'/Game/ForgeAAA/Maps/FAAA_R82InteriorV2',building,modules,approved:true,install,timeoutMs:240000};
 report.first=await unreal.assembleBuilding({...req,scriptPath:path.join(root,'assemble-a.py'),logPath:path.join(root,'assemble-a.log')}); await persist();
 if(!report.first.ok) throw new Error('assembly failed: '+JSON.stringify(report.first.report));
 report.repeated=await unreal.assembleBuilding({...req,scriptPath:path.join(root,'assemble-repeat.py'),logPath:path.join(root,'assemble-repeat.log')}); await persist();
 if(!report.repeated.ok||report.repeated.report.placed.some(p=>p.action!=='reused')) throw new Error('idempotency failed');
 const other=roomBuilding(modules,'western-room-b',[1000,0,0]);
 report.distinct=await unreal.assembleBuilding({...req,building:other,scriptPath:path.join(root,'assemble-b.py'),logPath:path.join(root,'assemble-b.log')}); await persist();
 if(!report.distinct.ok) throw new Error('second identity assembly failed');
 report.configure=await runPython('configure-room',await readFile('benchmarks/r82/configure-room.py','utf8'));
}
report.finishedAt=new Date().toISOString();
} catch(e) {report.error=String(e);report.finishedAt=new Date().toISOString();process.exitCode=1;}
await persist(); console.log(JSON.stringify({evidenceFile,phase:report.phase,error:report.error}));
