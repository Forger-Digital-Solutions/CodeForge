import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {UnrealAdapter} from '../../packages/forge-aaa/dist/index.js';

const dir='docs/evidence/r82-forgeaaa-modular-western-interior', scratch=path.resolve('.scratch');
await mkdir(dir,{recursive:true});
const report={startedAt:new Date().toISOString(),classification:{input:'SYNTHETIC_INPUT via native PlayerInput',movement:'scripted AddMovementInput with CharacterMovement collision',gameplay:'native C++, no Python gameplay injection'},stages:{}};
const file=`${dir}/gameplay-${Date.now()}.json`;
const persist=()=>writeFile(file,JSON.stringify(report,null,2));
const identity=(building,instance)=>createHash('sha256').update(`forge-building:${building}:${instance}`).digest('hex').slice(0,32);
const door=identity('western-room-a','door'),window=identity('western-room-a','window'),doorB=identity('western-room-b','door'),windowB=identity('western-room-b','window');
report.identities={door,window,doorB,windowB};
const unreal=new UnrealAdapter(); const install=(await unreal.detect()).installs.find(i=>i.version.major===4&&i.version.minor===27);
const move=(target,arrived=true)=>({op:'moveTo',target,timeoutS:12,expect:{arrived}});
const face=target=>({op:'face',target});
const press=(dispatched=true,resultState)=>({op:'press',key:'E',expect:{dispatched,...(resultState?{resultState}:{})}});
const wait={op:'wait',durationS:1.2};
const probe=(from,to,blockingHit)=>({op:'probe',from,to,expect:{blockingHit}});
const dw=state=>({op:'expectDoor',door,state});
const ww=(state,restored)=>({op:'expectWindow',window,state,...(restored===undefined?{}:{expect:{restored}})});
const shot=(name,from,target)=>({op:'screenshot',screenshotPath:path.resolve(`${dir}/${name}.png`),from,target});
const run=async(name,actions)=>{
 const result=await unreal.runNativeGameplayTest({projectPath:path.join(scratch,'pilot/DeadTrailsWest.uproject'),levelPath:'/Game/ForgeAAA/Maps/FAAA_R82InteriorV2',specPath:path.join(scratch,name+'-spec.json'),reportPath:path.join(scratch,name+'-report.json'),checkpointPath:path.join(scratch,name+'-checkpoint.json'),saveSlot:'ForgeR82InteriorTest',actions,install,logPath:path.join(scratch,name+'.log'),timeoutMs:240000});
 report.stages[name]={state:result.state,actionMetrics:result.actionMetrics,metrics:result.metrics,durationMs:result.durationMs,error:result.error};await persist();
 await copyFile(path.join(scratch,name+'-report.json'),`${dir}/${name}-driver-${Date.now()}.json`).catch(()=>{});
 return result.state==='pass';
};
try {
await rm(path.join(scratch,'pilot/Saved/SaveGames/ForgeR82InteriorTest.sav'),{force:true});
const model=JSON.parse(await readFile('benchmarks/r82/model-window-actions.json','utf8'));
const modelActions=model.actions.map(a=>a.window==='WINDOW_ID'?{...a,window}:a);
report.modelArtifact='benchmarks/r82/model-window-actions.json';
const ok=await run('stage1',[
 {op:'wait',durationS:2},dw('closed'),ww('closed',false),
 face([0,-10,100]),press(false),
 probe([0,-80,100],[0,70,100],true),
 move([0,80,96],false),move([40,-80,96]),face([0,-10,100]),press(true,'door.opening'),wait,dw('open'),
 probe([0,-40,100],[0,80,100],false),move([0,-35,96]),move([0,120,96]),
 probe([0,200,100],[400,200,100],true),move([400,200,96],false),move([100,200,96]),
 probe([100,200,100],[100,200,-100],true),probe([100,200,100],[100,200,400],true),
 move([0,300,96]),face([25,527,120]),press(false),
 move([0,440,96]),ww('closed'),...modelActions,
 move([160,260,96]),{op:'save',expect:{minSavedDoors:2,minSavedWindows:2}},
 {op:'slotVerify',expect:{slotExists:true,loaded:true,doorStates:{[door]:2,[doorB]:0},windowStates:{[window]:2,[windowB]:0}}},
 shot('interior',[180,60,175],[0,450,135]),shot('window',[70,380,150],[0,530,150]),shot('exterior',[400,-480,280],[0,220,120]),
 {op:'reloadMap'},dw('open'),ww('open',true),{op:'expectWindow',window:windowB,state:'closed',expect:{restored:true}},
 probe([25,480,120],[25,580,120],false),move([0,100,96]),move([0,-140,96]),{op:'exit'}
]);
if(!ok) throw new Error('stage1 failed; failure evidence retained');
const fresh=await run('stage2',[
 {op:'wait',durationS:1},dw('open'),ww('open',true),{op:'expectDoor',door:doorB,state:'closed'},
 {op:'expectWindow',window:windowB,state:'closed',expect:{restored:true}},
 probe([0,-40,100],[0,80,100],false),probe([25,480,120],[25,580,120],false),
 move([0,120,96]),move([0,440,96]),face([25,527,185]),press(true,'window.closing'),wait,ww('closed'),probe([25,480,120],[25,580,120],true),
 face([25,527,185]),press(true,'window.opening'),wait,ww('open'),
 move([0,120,96]),move([0,-140,96]),face([-52,-60,100]),press(true,'door.closing'),wait,dw('closed'),
 probe([0,-100,100],[0,80,100],true),move([40,-80,96]),face([0,-10,100]),press(true,'door.opening'),wait,dw('open'),
 {op:'save',expect:{minSavedDoors:2,minSavedWindows:2}},{op:'writeInvalidWindowRecord',window},{op:'exit'}
]);
if(!fresh) throw new Error('stage2 failed');
if(!await run('stage3',[{op:'wait',durationS:1},{op:'slotVerify',expect:{slotExists:true,loaded:true}},dw('open'),ww('closed',false),{op:'expectWindow',window:windowB,state:'closed',expect:{restored:true}},{op:'writeCorruptSave'},{op:'exit'}])) throw new Error('invalid-window-record stage failed');
if(!await run('stage4',[{op:'wait',durationS:1},{op:'slotVerify',expect:{slotExists:true,loaded:false}},dw('closed'),ww('closed',false),{op:'deleteSave'},{op:'slotVerify',expect:{slotExists:false}},{op:'exit'}])) throw new Error('corrupt-save stage failed');
} catch(e) {report.error=String(e);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({file,stages:Object.fromEntries(Object.entries(report.stages).map(([k,v])=>[k,v.state])),error:report.error}));
