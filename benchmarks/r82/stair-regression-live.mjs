import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {UnrealAdapter} from '../../packages/forge-aaa/dist/index.js';

const adapter=new UnrealAdapter(),install=(await adapter.detect()).installs.find(i=>i.version.major===4&&i.version.minor===27);
const report={option:'C: separate preserved staircase validation area; six steps, 108cm rise; not a second story',classification:'legacy Python traversal driver; actual CharacterMovement; separate from native R82 gameplay',runs:{}};
const tests={ascend:{spawn:[-160,0,100],inputDirection:[1,0,0],durationS:5,stopWhen:{minZ:195},expect:{minZ:195,minDisplacementCm:200}},descend:{spawn:[250,0,210],inputDirection:[-1,0,0],durationS:5,stopWhen:{maxZ:92,minDisplacementCm:250},expect:{maxZ:92,minDisplacementCm:250}},side:{spawn:[78,0,180],inputDirection:[0,-1,0],durationS:3,expect:{maxDisplacementCm:15}}};
const file=`docs/evidence/r82-forgeaaa-modular-western-interior/stair-regression-${Date.now()}.json`;
for(const [name,traversal] of Object.entries(tests)) {
 const r=await adapter.runFunctionalTest({projectPath:path.resolve('.scratch/pilot/DeadTrailsWest.uproject'),levelPath:'/Game/ForgeAAA/Maps/FAAA_Traversal',scriptPath:path.resolve('.scratch/stair-'+name+'.py'),logPath:path.resolve('.scratch/stair-'+name+'.log'),traversal,install,timeoutMs:180000});
 report.runs[name]={state:r.state,metrics:r.metrics,configRestored:r.configRestored,error:r.error};
 await writeFile(file,JSON.stringify(report,null,2));
}
report.ok=Object.values(report.runs).every(r=>r.state==='pass'&&r.configRestored!==false);
await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,ok:report.ok}));if(!report.ok) process.exitCode=1;
