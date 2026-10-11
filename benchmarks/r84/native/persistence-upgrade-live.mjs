import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateMigration, applyMigration, migrationAssemblyScript, verifySavedMigration, verifyMigration, commitMigration } from "../../../packages/forge-aaa/dist/index.js";
import { R82_ONE_ROOM_BUILDING as source, R82_ONE_ROOM_MODULES as before, R83_TWO_ROOM_BUILDING as target, R83_TWO_ROOM_MODULES as after } from "../../../packages/forge-aaa/dist/r83-building-spec.js";
import { configure } from "./configure-gameplay.mjs";
import { python, unreal, install, project, scratch, evidenceDir } from "./live-utils.mjs";

const stamp=Date.now(), level=`/Game/ForgeAAA/Maps/FAAA_R83_PersistenceUpgrade_${stamp}`, saveSlot=`ForgeR83Upgrade_${stamp}`;
const file=path.join(evidenceDir,`persistence-upgrade-${stamp}.json`), report={startedAt:new Date().toISOString(),level,saveSlot,classification:"Deterministic external engineering campaign; native C++ PlayerInput, CharacterMovement and SaveGame",stages:{}};
const persist=()=>writeFile(file,JSON.stringify(report,null,2));
const identity=instance=>createHash("sha256").update(`forge-building:western-room-a:${instance}`).digest("hex").slice(0,32);
const door=identity("door"), interior=identity("door-interior"), window=identity("window");
report.identities={door,interior,window};
const move=target=>({op:"moveTo",target,timeoutS:12,expect:{arrived:true}}),face=target=>({op:"face",target}),press=state=>({op:"press",key:"E",expect:{dispatched:true,resultState:state}}),wait={op:"wait",durationS:1.2};
const dw=(id,state)=>({op:"expectDoor",door:id,state,toleranceDeg:0.5}),ww=(state,restored)=>({op:"expectWindow",window,state,...(restored===undefined?{}:{expect:{restored}})});
async function native(name,actions) {
  const result=await unreal.runNativeGameplayTest({projectPath:project,levelPath:level,specPath:path.join(scratch,`${name}-${stamp}-spec.json`),reportPath:path.join(evidenceDir,`${name}-${stamp}-driver.json`),saveSlot,actions,install,logPath:path.join(scratch,`${name}-${stamp}.log`),timeoutMs:180000});
  report.stages[name]={state:result.state,exitCode:result.exitCode,pythonModuleLoaded:result.pythonModuleLoaded,metrics:result.metrics,actionMetrics:result.actionMetrics};await persist();
  if(result.state!=="pass")throw new Error(name+" failed: "+JSON.stringify(result.metrics?.failures));
}
try {
  report.sourceAssembly=await unreal.assembleBuilding({projectPath:project,authorizedProjectPath:project,levelPath:level,building:source,modules:before,approved:true,install,scriptPath:path.join(scratch,`persistence-source-${stamp}.py`),logPath:path.join(scratch,`persistence-source-${stamp}.log`),timeoutMs:180000});
  if(!report.sourceAssembly.ok)throw new Error("source assembly failed");
  await configure(level);
  await native("pre-upgrade",[{op:"wait",durationS:1},dw(door,"closed"),ww("closed",false),move([40,-80,96]),face([0,-10,100]),press("door.opening"),wait,dw(door,"open"),move([0,-35,96]),move([0,120,96]),move([0,440,96]),face([25,527,185]),press("window.opening"),wait,ww("open"),{op:"save",expect:{minSavedDoors:1,minSavedWindows:1}},{op:"slotVerify",expect:{slotExists:true,loaded:true,doorStates:{[door]:2},windowStates:{[window]:2}}},{op:"exit"}]);
  const valid=validateMigration(source,target,after,{previousRegistry:before,migrationId:`r83-persistence-${stamp}`});
  const migration=applyMigration(valid,valid.previousRevision.fingerprint);
  report.migration=await python(`persistence-migrate-${stamp}`,migrationAssemblyScript(migration,target,after,level,{receiptPath:path.join(scratch,`persistence-receipt-${stamp}.json`),backupPath:path.join(scratch,`persistence-backup-${stamp}.umap`)}));
  if(!report.migration.ok||report.migration.report?.phase!=="COMMITTED")throw new Error("upgrade migration failed");
  const evidence=await verifySavedMigration(migration,{projectPath:project,levelPath:level,evidenceDirectory:evidenceDir,phase:"COMMITTED"});
  report.commit=commitMigration(verifyMigration(migration),evidence);
  if(report.commit.status!=="COMMITTED")throw new Error("independent saved-level readback failed");
  await native("post-upgrade",[{op:"wait",durationS:1},dw(door,"open"),ww("open",true),dw(interior,"closed"),{op:"slotVerify",expect:{loaded:true,doorStates:{[door]:2},windowStates:{[window]:2}}},move([0,120,96]),move([220,260,96]),face([290,260,107]),press("door.opening"),wait,dw(interior,"open"),move([380,260,96]),move([580,260,96]),move([180,260,96]),{op:"save",expect:{minSavedDoors:2,minSavedWindows:1}},{op:"exit"}]);
  await native("upgrade-fresh-process",[{op:"wait",durationS:1},dw(door,"open"),dw(interior,"open"),ww("open",true),{op:"slotVerify",expect:{loaded:true,doorStates:{[door]:2,[interior]:2},windowStates:{[window]:2}}},move([0,120,96]),move([220,260,96]),move([580,260,96]),move([340,280,96]),face([338,208,107]),press("door.closing"),wait,dw(interior,"closed"),{op:"probe",from:[220,260,100],to:[380,260,100],expect:{blockingHit:true}},face([290,260,107]),press("door.opening"),wait,dw(interior,"open"),move([450,300,96]),move([380,260,96]),move([180,260,96]),move([0,120,96]),move([0,40,96]),wait,move([0,-35,96]),move([0,-140,96]),{op:"exit"}]);
  report.ok=true;
} catch(error){report.error=String(error);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({file,ok:report.ok,error:report.error,stages:Object.fromEntries(Object.entries(report.stages).map(([k,v])=>[k,v.state]))}));
