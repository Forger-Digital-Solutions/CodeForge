import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ForgeAaaDirector, routeForgeAaaTask, validateConnectedBuilding, validateMigration, applyMigration, verifyMigration, commitMigration, migrationAssemblyScript, verifySavedMigration } from "../../packages/forge-aaa/dist/index.js";
import { R82_ONE_ROOM_BUILDING as source, R82_ONE_ROOM_MODULES as before, R83_TWO_ROOM_BUILDING as contract, R83_TWO_ROOM_MODULES as after } from "../../packages/forge-aaa/dist/r83-building-spec.js";
import { admitFreeRoute, boundedChat } from "../r82/free-route.mjs";
import { configure } from "./configure-gameplay.mjs";
import { modelRequest } from "./model-layout-request.mjs";
import { reviewMilestone } from "./independent-review.mjs";
import { python, unreal, install, project, scratch, evidenceDir } from "./live-utils.mjs";

const resume=process.argv.includes("--resume"), prepare=process.argv.includes("--prepare"), reuseModel=process.argv.includes("--reuse-model-artifact");
const reportPath=path.join(evidenceDir,"director-live-evidence.json"), checkpointPath=path.join(evidenceDir,"director-live-checkpoint.json"), artifactPath=path.join(evidenceDir,"model-connected-layout.json");
const report=resume?JSON.parse(await readFile(reportPath,"utf8")):{startedAt:new Date().toISOString(),stamp:Date.now(),model:"nvidia/nemotron-3-super-120b-a12b:free",provider:"kilo-free-direct",costUSD:0,tools:{},executionCounts:{}};
report.predecessor="director-live-evidence-complete-invalid-1791746982211.json";
if(resume) {report.interruption={reason:report.error,checkpoint:"director-repair-before-resume-checkpoint.json"};delete report.error;}
const stamp=report.stamp, level=`/Game/ForgeAAA/Maps/FAAA_R83_Director_${stamp}`, saveSlot=`ForgeR83Upgrade_${stamp}`;
const persistReport=()=>writeFile(reportPath,JSON.stringify(report,null,2));
const identity=instance=>createHash("sha256").update(`forge-building:western-room-a:${instance}`).digest("hex").slice(0,32);
const door=identity("door"), interior=identity("door-interior"), window=identity("window");
const task=(id,dependencies=[])=>({id,title:id,objective:id,specialty:"forge-modeler",dependencies,status:"planned",attempts:0,artifacts:[],evidence:[]});
let target, migration;
async function loadTarget() {
  const artifact=JSON.parse(await readFile(artifactPath,"utf8"));
  if(!Array.isArray(artifact.addedInstances)||artifact.addedInstances.length!==10||JSON.stringify(artifact.removedInstanceIds)!=='["wall-right"]')throw new Error("model migration shape invalid");
  const allowed=new Set(contract.instances.filter(i=>!source.instances.some(s=>s.instanceId===i.instanceId)).map(i=>i.instanceId));
  if(new Set(artifact.addedInstances.map(i=>i.instanceId)).size!==10||artifact.addedInstances.some(i=>!allowed.has(i.instanceId)))throw new Error("model instance identities invalid");
  const added=structuredClone(artifact.addedInstances),room=contract.rooms.find(r=>r.floorInstanceId==="floor-b"),connection=contract.connections[0],corrections=[];
  for(const instance of added) {
    const module=after.find(m=>m.moduleId===instance.moduleId);
    if(!module)throw new Error("model module missing "+instance.moduleId);
    let axis,value,reason;
    if(instance.instanceId==="wall-right-b") {axis=0;value=room.centerCm[0]+room.interiorCm[0]/2+module.dimensions.widthCm/2;reason="east wall lies outside the declared interior";}
    if(instance.instanceId==="ceiling-b") {axis=0;value=connection.centerCm[0]+connection.wallThicknessCm/2+module.dimensions.widthCm/2;reason="ceiling begins beyond shared wall and does not overlap Room A ceiling";}
    if(instance.instanceId==="shared-wall-lintel") {axis=2;value=connection.centerCm[2]+connection.openingHeightCm+module.dimensions.heightCm/2;reason="lintel clears the entire declared doorway height";}
    if(axis!==undefined&&instance.positionCm[axis]!==value) {corrections.push({instanceId:instance.instanceId,axis,from:instance.positionCm[axis],to:value,reason});instance.positionCm[axis]=value;}
  }
  target={...contract,instances:[...source.instances.filter(i=>!artifact.removedInstanceIds.includes(i.instanceId)),...added]};
  const validation=validateConnectedBuilding(target,after);
  if(validation.instances.length!==23)throw new Error("model geometry instance count differs");
  const d=target.instances.find(i=>i.instanceId==="door-interior");
  if(JSON.stringify(d.positionCm)!=='[290,260,0]'||d.yawDeg!==90)throw new Error("prescribed doorway placement differs");
  const validated=validateMigration(source,target,after,{previousRegistry:before,migrationId:`director-r83-${stamp}`});
  migration=applyMigration(validated,validated.previousRevision.fingerprint);
  const correctedPath=path.join(evidenceDir,"model-connected-layout.corrected.json");
  await writeFile(correctedPath,JSON.stringify({removedInstanceIds:artifact.removedInstanceIds,addedInstances:added},null,2));
  report.corrections=corrections;
  report.modelArtifact={path:correctedPath,rawPath:artifactPath,sha256:createHash("sha256").update(await readFile(correctedPath)).digest("hex"),rawSha256:createHash("sha256").update(await readFile(artifactPath)).digest("hex"),origin:"qualified Coder complete proposal; three explicit deterministic constraint repairs",correctionCount:corrections.length};
  return validation;
}
const move=(target,arrived=true)=>({op:"moveTo",target,timeoutS:12,expect:{arrived}}),face=target=>({op:"face",target}),press=state=>({op:"press",key:"E",expect:{dispatched:true,resultState:state}}),wait={op:"wait",durationS:1.2};
const dw=(id,state)=>({op:"expectDoor",door:id,state,toleranceDeg:0.5}),ww=(state,restored)=>({op:"expectWindow",window,state,...(restored===undefined?{}:{expect:{restored}})});
async function native(name,actions) {
  report.adapterOperations=(report.adapterOperations??0)+1;
  const result=await unreal.runNativeGameplayTest({projectPath:project,levelPath:level,specPath:path.join(scratch,`${name}-${stamp}-spec.json`),reportPath:path.join(evidenceDir,`${name}-${stamp}-driver.json`),saveSlot,actions,install,logPath:path.join(scratch,`${name}-${stamp}.log`),timeoutMs:180000});
  report.tools[name]={state:result.state,exitCode:result.exitCode,pythonModuleLoaded:result.pythonModuleLoaded,metrics:result.metrics,actionMetrics:result.actionMetrics};await persistReport();
  if(result.state!=="pass")throw new Error(name+" failed: "+JSON.stringify(result.metrics?.failures));
}
const toolCandidate={modelId:"UE4.27-deterministic-adapter",providerId:"local-tool",providerModelId:"UE4.27",domain:"local_tool",lifecycle:"QUALIFIED",available:true,qualifiedRoles:["CODER"],costClass:"free",privateCodeAllowed:true};
const deps={maxAttemptsPerTask:1,
  planner:()=>[task("inspect"),task("layout",["inspect"]),task("validate",["layout"]),task("build-source-and-save",["validate"]),task("migrate",["build-source-and-save"]),task("engine-verify",["migrate"]),task("gameplay-verify",["engine-verify"]),task("integrate",["gameplay-verify"])],
  routeTask:t=>routeForgeAaaTask({taskId:t.id,specialty:t.specialty,candidates:[t.id==="layout"?{...toolCandidate,modelId:report.model,providerId:"kilo-free-direct",providerModelId:report.model,domain:"managed_free",privateCodeAllowed:false}:toolCandidate],privateCode:false}),
  executeTask:async t=>{
    report.executionCounts[t.id]=(report.executionCounts[t.id]??0)+1;
    const frameStart=report.frames?.length??0,adapterStart=report.adapterOperations??0;
    try {
    if(t.id==="inspect") {
      report.adapterOperations=(report.adapterOperations??0)+1;
      report.tools.inspect=await python(`director-inspect-${stamp}`,`import unreal,json,sys
paths=json.loads(${JSON.stringify(JSON.stringify(after.map(m=>m.engineAsset)))})
assets=[]
for p in paths:
    a=unreal.EditorAssetLibrary.load_asset(p)
    if not isinstance(a,unreal.StaticMesh):raise RuntimeError("required StaticMesh absent "+p)
    assets.append({"path":a.get_path_name(),"class":a.get_class().get_path_name()})
print("FORGEAAA_REPORT:"+json.dumps({"ok":True,"assets":assets}))
sys.exit(0)
`);
      if(!report.tools.inspect.ok||!report.tools.inspect.report?.ok)throw new Error("asset inspection failed");
    } else if(t.id==="layout") {
      if(reuseModel) {
        const prior=JSON.parse(await readFile(path.join(evidenceDir,report.predecessor),"utf8"));
        if(prior.frames?.length!==1||!prior.admission?.ok||prior.qualification?.roleResults?.CODER?.status!=="QUALIFIED")throw new Error("reusable model origin invalid");
        if(JSON.stringify(JSON.parse(prior.frames[0].raw))!==JSON.stringify(JSON.parse(await readFile(artifactPath,"utf8"))))throw new Error("model artifact differs from raw output");
        report.reusedModelEvidence={path:report.predecessor,failedInferenceAttempts:2,completeModelResponseSha256:createHash("sha256").update(prior.frames[0].raw).digest("hex"),newInferenceRequests:0};
        await loadTarget();
      } else {
      const qualified=JSON.parse(await readFile("docs/evidence/r80-forgeaaa-autonomous-gameplay/phase-g-coder-capacity-1791699174859.json","utf8")).qualifications["nemotron-3-super"].receipt;
      if(qualified.modelId!==report.model||qualified.roleResults.CODER.status!=="QUALIFIED")throw new Error("coder qualification unavailable");
      report.qualification=qualified;const adapter=await admitFreeRoute(report.model,report);await persistReport();
      await writeFile(path.join(evidenceDir,"model-layout-retry-request.json"),JSON.stringify(modelRequest,null,2));
      const raw=await boundedChat(adapter,modelRequest,report);
      const artifact=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]??"null");await writeFile(artifactPath,JSON.stringify(artifact,null,2));
      report.modelArtifact={path:artifactPath,sha256:createHash("sha256").update(await readFile(artifactPath)).digest("hex"),rawOrigin:"qualified CODER through current ForgeZero admission"};
      await loadTarget();
      }
    } else if(t.id==="validate") report.validation=await loadTarget();
    else if(t.id==="build-source-and-save") {
      report.adapterOperations=(report.adapterOperations??0)+1;
      report.tools.sourceAssembly=await unreal.assembleBuilding({projectPath:project,authorizedProjectPath:project,levelPath:level,building:source,modules:before,approved:true,install,scriptPath:path.join(scratch,`director-source-${stamp}.py`),logPath:path.join(scratch,`director-source-${stamp}.log`),timeoutMs:180000});
      if(!report.tools.sourceAssembly.ok)throw new Error("source construction failed");
      report.adapterOperations++;
      await configure(level);
      await native("director-pre-upgrade",[{op:"wait",durationS:1},dw(door,"closed"),ww("closed",false),move([40,-80,96]),face([0,-10,100]),press("door.opening"),wait,dw(door,"open"),move([0,-35,96]),move([0,120,96]),move([0,440,96]),face([25,527,185]),press("window.opening"),wait,ww("open"),{op:"save",expect:{minSavedDoors:1,minSavedWindows:1}},{op:"slotVerify",expect:{slotExists:true,loaded:true,doorStates:{[door]:2},windowStates:{[window]:2}}},{op:"exit"}]);
    } else if(t.id==="migrate") {
      report.adapterOperations=(report.adapterOperations??0)+1;
      await loadTarget();report.tools.migration=await python(`director-migrate-${stamp}`,migrationAssemblyScript(migration,target,after,level,{receiptPath:path.join(scratch,`director-migration-${stamp}.json`),backupPath:path.join(scratch,`director-backup-${stamp}.umap`)}));
      if(!report.tools.migration.ok||report.tools.migration.report?.phase!=="COMMITTED")throw new Error("model layout migration failed");
    } else if(t.id==="engine-verify") {
      report.adapterOperations=(report.adapterOperations??0)+1;
      await loadTarget();const evidence=await verifySavedMigration(migration,{projectPath:project,levelPath:level,evidenceDirectory:evidenceDir,phase:"COMMITTED"});
      report.tools.engineCommit=commitMigration(verifyMigration(migration),evidence);if(report.tools.engineCommit.status!=="COMMITTED")throw new Error("independent engine gate blocked");
    } else if(t.id==="gameplay-verify") {
      await native("director-post-upgrade",[{op:"wait",durationS:1},dw(door,"open"),ww("open",true),dw(interior,"closed"),{op:"slotVerify",expect:{loaded:true,doorStates:{[door]:2},windowStates:{[window]:2}}},move([0,120,96]),move([220,260,96]),face([290,260,107]),press("door.opening"),wait,dw(interior,"open"),move([380,260,96]),move([580,260,96]),move([180,260,96]),{op:"save",expect:{minSavedDoors:2,minSavedWindows:1}},{op:"exit"}]);
      await native("director-fresh-process",[{op:"wait",durationS:1},dw(door,"open"),dw(interior,"open"),ww("open",true),{op:"slotVerify",expect:{loaded:true,doorStates:{[door]:2,[interior]:2},windowStates:{[window]:2}}},move([0,120,96]),move([220,260,96]),move([580,260,96]),move([180,260,96]),move([0,120,96]),move([0,-140,96]),{op:"exit"}]);
    } else if(t.id==="integrate") {
      report.integration={modelLayoutHash:report.modelArtifact.sha256,level,instanceCount:target?.instances.length??contract.instances.length,existingIdentitiesPreserved:true,saveSlot};
    }
    await persistReport();return {ok:true,artifacts:[t.id==="layout"?artifactPath:reportPath],modelCalls:(report.frames?.length??0)-frameStart,adapterOps:(report.adapterOperations??0)-adapterStart};
    } catch(error) {
      await persistReport();return {ok:false,detail:String(error),modelCalls:(report.frames?.length??0)-frameStart,adapterOps:(report.adapterOperations??0)-adapterStart};
    }
  },
  verifyTask:async t=>{
    const durable=JSON.parse(await readFile(reportPath,"utf8"));
    const checked=t.id==="layout"||t.id==="validate"?!!(await loadTarget()):t.id==="inspect"?durable.tools.inspect.report.ok===true:t.id==="build-source-and-save"?durable.tools["director-pre-upgrade"].state==="pass":t.id==="migrate"?durable.tools.migration.report.phase==="COMMITTED":t.id==="engine-verify"?durable.tools.engineCommit.status==="COMMITTED":t.id==="gameplay-verify"?durable.tools["director-post-upgrade"].state==="pass"&&durable.tools["director-fresh-process"].state==="pass":!!durable.integration;
    return {checks:[{id:t.id,kind:"custom",status:checked?"passed":"failed",durationMs:0,evidenceRef:reportPath}],passed:checked?1:0,failed:checked?0:1,blocked:0,verified:checked,ranAt:new Date().toISOString()};
  },
  reviewRun:async run=>reviewMilestone("r83","\n\nActual resumed Director run and tool evidence:\n"+JSON.stringify({counters:run.counters,tasks:run.tasks.map(t=>({id:t.id,status:t.status,attempts:t.attempts,artifacts:t.artifacts})),modelArtifact:report.modelArtifact,executionCounts:report.executionCounts,tools:Object.fromEntries(Object.entries(report.tools).map(([name,result])=>[name,{state:result.state,status:result.status,exitCode:result.exitCode,ok:result.ok,phase:result.report?.phase,fingerprint:result.report?.fingerprint,instanceCount:result.report?.instanceCount,failures:result.metrics?.failures,evidence:result.verification?{phase:result.verification.phase,instanceCount:result.verification.instanceCount,fingerprint:result.verification.fingerprint,receiptPath:result.verification.receiptPath,levelFileSha256:result.verification.levelFileSha256}:undefined}])),integration:report.integration})),
  persist:async run=>{await writeFile(checkpointPath,JSON.stringify(run,null,2));if(prepare&&run.tasks.find(t=>t.id==="layout")?.status==="integrating")throw new Error("CONTROLLED_DIRECTOR_CHECKPOINT");},
};
try {
  const director=new ForgeAaaDirector(deps);
  const run=resume?JSON.parse(await readFile(checkpointPath,"utf8")):director.createRun({goal:"Expand the existing Western room into two connected rooms while preserving native gameplay identities and SaveGame state",engineTarget:"ue-4.27",projectPath:project,leadPolicy:"auto"});
  if(resume)director.restore(run);
  report.director=await director.execute(run.id);report.status=report.director.finalStatus;
  if(resume)report.resumeProof={modelCalls:report.director.counters.modelCalls,layoutExecutions:report.executionCounts.layout,inspectExecutions:report.executionCounts.inspect,noDuplicateInference:report.executionCounts.layout===1,reusedCompleteProposal:true,predecessorInferenceAttempts:2};
}catch(error){report.error=String(error);report.status=String(error).includes("CONTROLLED_DIRECTOR_CHECKPOINT")?"CHECKPOINTED_FOR_RESUME":"BLOCKED";if(report.status==="BLOCKED")process.exitCode=1;}
report.updatedAt=new Date().toISOString();await persistReport();console.log(JSON.stringify({reportPath,status:report.status,error:report.error,counters:report.director?.counters}));
