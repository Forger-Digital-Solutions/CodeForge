import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {UnrealAdapter} from '../../packages/forge-aaa/dist/index.js';

const root=path.resolve('.scratch'), dir='docs/evidence/r82-forgeaaa-modular-western-interior';
const file=`${dir}/legacy-compatibility-${Date.now()}.json`,report={startedAt:new Date().toISOString(),stages:{},classification:'actual R81 binary writes original schema; R82 binary reads it'};
const adapter=new UnrealAdapter(),install=(await adapter.detect()).installs.find(i=>i.version.major===4&&i.version.minor===27);
async function run(name,project,level,slot,actions) {
 const result=await adapter.runNativeGameplayTest({projectPath:path.join(root,project,'DeadTrailsWest.uproject'),levelPath:level,saveSlot:slot,actions,specPath:path.join(root,name+'-spec.json'),reportPath:path.join(root,name+'-report.json'),logPath:path.join(root,name+'.log'),install,timeoutMs:180000});
 report.stages[name]={state:result.state,actions:result.actionMetrics,metrics:result.metrics,error:result.error};
 await writeFile(file,JSON.stringify(report,null,2));
 if(result.state!=='pass') throw new Error(name+' failed');
}
try {
 await run('legacy-writer','legacy','/Game/ForgeAAA/Maps/FAAA_NativeDoorTest','ForgeR81DoorTest',[
 {op:'wait',durationS:1},{op:'expectDoor',door:'door-western-a',state:'closed'},
 {op:'moveTo',target:[40,-70,92],timeoutS:15,expect:{arrived:true}},{op:'face',target:[0,0,90]},{op:'press',key:'E',expect:{dispatched:true}},
 {op:'wait',durationS:1.5},{op:'expectDoor',door:'door-western-a',state:'open'},
 {op:'save',expect:{minSavedDoors:2}},{op:'slotVerify',expect:{loaded:true,doorStates:{'door-western-a':2,'door-western-b':0}}},{op:'exit'}]);
 const oldSave=path.join(root,'legacy/Saved/SaveGames/ForgeR81DoorTest.sav');
 report.legacySaveSha256=createHash('sha256').update(await readFile(oldSave)).digest('hex');
 await mkdir(path.join(root,'pilot/Saved/SaveGames'),{recursive:true});
 await copyFile(oldSave,path.join(root,'pilot/Saved/SaveGames/ForgeR82LegacyCompatibility.sav'));
 await run('r82-reader','pilot','/Game/ForgeAAA/Maps/FAAA_NativeDoorTest','ForgeR82LegacyCompatibility',[
 {op:'wait',durationS:1},{op:'expectDoor',door:'door-western-a',state:'open'},{op:'expectDoor',door:'door-western-b',state:'closed'},
 {op:'slotVerify',expect:{loaded:true,doorStates:{'door-western-a':2,'door-western-b':0}}},
 {op:'probe',from:[0,-40,100],to:[0,80,100],expect:{blockingHit:false}},{op:'exit'}]);
 await run('missing-window-record','pilot','/Game/ForgeAAA/Maps/FAAA_R82InteriorV2','ForgeR82LegacyCompatibility',[
 {op:'wait',durationS:1},{op:'expectWindow',window:'75c84e620f55e7cf42b23d97b7cf4773',state:'closed',expect:{restored:false}},
 {op:'slotVerify',expect:{loaded:true,doorStates:{'door-western-a':2,'door-western-b':0}}},{op:'deleteSave'},{op:'exit'}]);
 report.ok=true;
} catch(e) {report.ok=false;report.error=String(e);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,ok:report.ok,error:report.error}));
