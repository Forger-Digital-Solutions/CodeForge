import { writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { unreal, install, project, scratch, evidenceDir } from "./live-utils.mjs";
import { latestAssembly, configure } from "./configure-gameplay.mjs";

const stamp = Date.now();
const source = await latestAssembly();
const level = source.report.summary.level;
const saveSlot = `ForgeR83TwoRoom_${stamp}`;
const report = {startedAt:new Date().toISOString(),source:source.file,level,saveSlot,classification:{input:"SYNTHETIC_INPUT via native PlayerInput",movement:"CharacterMovement with collision; no traversal teleports",gameplay:"native C++; no Python gameplay injection"},stages:{}};
const evidenceFile = path.join(evidenceDir,`r83-gameplay-${stamp}.json`);
const persist = ()=>writeFile(evidenceFile,JSON.stringify(report,null,2));
const identity = instance=>createHash("sha256").update(`forge-building:western-room-a:${instance}`).digest("hex").slice(0,32);
const door=identity("door"), interior=identity("door-interior"), window=identity("window");
report.identities={door,interior,window};
const move=(target,arrived=true,timeoutS=12)=>({op:"moveTo",target,timeoutS,expect:{arrived}});
const face=target=>({op:"face",target});
const press=resultState=>({op:"press",key:"E",expect:{dispatched:true,resultState}});
const wait={op:"wait",durationS:1.2};
const dw=(id,state)=>({op:"expectDoor",door:id,state,toleranceDeg:0.5});
const ww=state=>({op:"expectWindow",window,state});
const probe=(from,to,blockingHit)=>({op:"probe",from,to,expect:{blockingHit}});
const shot=(name,from,target)=>({op:"screenshot",screenshotPath:path.join(evidenceDir,`${name}-${stamp}.png`),from,target});
async function run(name,actions) {
  const result=await unreal.runNativeGameplayTest({projectPath:project,levelPath:level,specPath:path.join(scratch,`${name}-${stamp}-spec.json`),reportPath:path.join(scratch,`${name}-${stamp}-driver.json`),saveSlot,actions,install,logPath:path.join(scratch,`${name}-${stamp}.log`),timeoutMs:240000});
  report.stages[name]={state:result.state,exitCode:result.exitCode,pythonModuleLoaded:result.pythonModuleLoaded,actionMetrics:result.actionMetrics,metrics:result.metrics};
  await persist();
  await copyFile(result.reportPath,path.join(evidenceDir,`${name}-${stamp}-driver.json`)).catch(()=>{});
  console.log(name,result.state,JSON.stringify(result.metrics?.failures));
  if(result.state!=="pass") throw new Error(name+" native gameplay failed");
  return result;
}
try {
  report.configuration=await configure(level);
  await run("two-room-traversal",[
    {op:"wait",durationS:1},dw(door,"closed"),dw(interior,"closed"),ww("closed"),
    move([40,-80,96]),face([0,-10,100]),press("door.opening"),wait,dw(door,"open"),
    probe([0,-40,100],[0,80,100],false),move([0,-35,96]),move([0,120,96]),move([220,260,96]),
    probe([220,260,100],[380,260,100],true),move([380,260,96],false,3),move([220,260,96]),
    face([290,260,107]),press("door.opening"),wait,dw(interior,"open"),
    probe([220,260,100],[380,260,100],false),move([380,260,96]),move([580,260,96]),
    probe([580,260,100],[900,260,100],true),move([900,260,96],false,3),move([580,260,96]),
    probe([580,260,100],[580,260,-100],true),probe([580,260,100],[580,260,400],true),
    move([380,260,96]),move([180,260,96]),move([0,440,96]),face([25,527,185]),press("window.opening"),wait,ww("open"),
    probe([25,480,120],[25,580,120],false),
    {op:"save",expect:{minSavedDoors:2,minSavedWindows:1}},
    {op:"slotVerify",expect:{slotExists:true,loaded:true,doorStates:{[door]:2,[interior]:2},windowStates:{[window]:2}}},
    shot("r83-room-a",[130,80,170],[285,260,120]),shot("r83-room-b",[750,400,175],[300,260,120]),shot("r83-exterior",[600,-480,400],[260,260,100]),
    move([0,120,96]),move([0,-140,96]),{op:"exit"},
  ]);
  await run("two-room-restart",[
    {op:"wait",durationS:1},
    {op:"slotVerify",expect:{slotExists:true,loaded:true,doorStates:{[door]:2,[interior]:2},windowStates:{[window]:2}}},
    dw(door,"open"),dw(interior,"open"),{op:"expectWindow",window,state:"open",expect:{restored:true}},
    move([0,120,96]),move([220,260,96]),move([580,260,96]),move([340,280,96]),
    face([338,208,107]),press("door.closing"),wait,dw(interior,"closed"),dw(door,"open"),
    probe([220,260,100],[380,260,100],true),
    face([290,260,107]),press("door.opening"),wait,dw(interior,"open"),
    move([180,260,96]),move([0,120,96]),move([0,-140,96]),{op:"exit"},
  ]);
  report.summary={traversalOk:true,saveGameRestoreOk:true};
} catch(error) {report.error=String(error);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({evidenceFile,summary:report.summary,error:report.error}));
