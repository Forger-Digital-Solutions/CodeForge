import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { ForgeAaaDirector, routeForgeAaaTask } from '../../packages/forge-aaa/dist/index.js';
import { admitFreeRoute,boundedChat } from './free-route.mjs';

const model='nvidia/nemotron-3-super-120b-a12b:free';
const dir='docs/evidence/r82-forgeaaa-modular-western-interior';await mkdir(dir,{recursive:true});
const file=`${dir}/model-window-test-${Date.now()}.json`;
const report={startedAt:new Date().toISOString(),model,provider:'kilo-free-direct',costUSD:0,evidenceClass:'MODEL_AUTHORED_NATIVE_WINDOW_REGRESSION'};
try {
 const qualified=JSON.parse(await readFile('docs/evidence/r80-forgeaaa-autonomous-gameplay/phase-g-coder-capacity-1791699174859.json','utf8')).qualifications['nemotron-3-super'].receipt;
 if(qualified.roleResults.CODER.status!=='QUALIFIED'||qualified.modelId!==model) throw new Error('CODER_NOT_QUALIFIED');
 report.qualification=qualified;
 const adapter=await admitFreeRoute(model,report);
 const candidate={modelId:model,providerId:adapter.providerId,providerModelId:model,domain:'managed_free',lifecycle:'QUALIFIED',available:true,qualifiedRoles:['CODER'],costClass:'free',privateCodeAllowed:false};
 const director=new ForgeAaaDirector({maxAttemptsPerTask:1,
  planner:()=>[{id:'window-regression',title:'Author native sash regression',objective:'Design a failing-capable native window gameplay regression used in the engine campaign',specialty:'forge-gameplay',dependencies:[],status:'planned',attempts:0,artifacts:[],evidence:[]}],
  routeTask:task=>routeForgeAaaTask({taskId:task.id,specialty:task.specialty,candidates:[candidate],privateCode:false}),
  executeTask:async()=>{
   const raw=await boundedChat(adapter,{model,temperature:0,maxTokens:5000,messages:[{role:'system',content:'You design game-engine regression tests. Output ONLY complete JSON {"actions":[...]}. Each action MUST have an op string, e.g. {"op":"face","target":[25,527,185]}, {"op":"press","key":"E","expect":{"dispatched":true,"resultState":"window.opening"}}, {"op":"wait","durationS":1.2}, {"op":"expectWindow","window":"WINDOW_ID","state":"open"}, {"op":"probe","from":[25,480,120],"to":[25,580,120],"expect":{"blockingHit":false}}. No code or actor manipulation. The first engine execution failed: aiming at z120 hit the solid sill before reaching the window. Repair the targeting using the observed geometry; do not change collision or weaken assertions. Wait 1.2 seconds after every press, transition takes 0.8s.'},{role:'user',content:'Author a sliding-sash window regression for UE4.27. Character at [0,440,96] indoors. Window initially closed: lower sash x [-53,53], z [95,160], y=527. Upper fixed sash z [165,225], y=533. Opening moves lower sash up 65 cm. Full 3D controller aim, Native sweep radius40cm, reach90cm, window eligibility150cm. The character capsule center settles at z90.15. At closed aim z120 the sweep hits sill at distance39cm and never reaches window. Aiming [25,527,185] was observed to reach FrameMesh at distance64.7cm. Use this clear aim for each E press, including the closed window. Every probe MUST use exactly from [25,480,120] to [25,580,120], the horizontal aperture crossing. The last repair incorrectly used a vertical probe from z120 to z200 at y527, which would hit the raised sash. Repair that probe and preserve z185 aim. Open through E, assert opening dispatch, wait, assert settled open and clear aperture. Close through E aimed at elevated sash; assert closing dispatch, wait, assert closed and blocked aperture. Reopen, wait, assert open; end open for persistence. 12..22 actions. Three settled assertions and both collision outcomes required. WINDOW_ID literal. Public synthetic geometry.'}]},report);
   const doc=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]??'null');
   if(!doc||!Array.isArray(doc.actions)||doc.actions.length>22||doc.actions.length<12) throw new Error('invalid model action count');
   if(doc.actions.some(a=>!['face','press','wait','expectWindow','probe'].includes(a.op))) throw new Error('unauthorized model operation');
   if(doc.actions.filter(a=>a.op==='expectWindow').length<3||!doc.actions.some(a=>a.op==='probe'&&a.expect?.blockingHit===false)||!doc.actions.some(a=>a.op==='probe'&&a.expect?.blockingHit===true)) throw new Error('missing negative regression assertions');
   if(doc.actions.some(a=>a.op==='probe'&&(JSON.stringify(a.from)!=='[25,480,120]'||JSON.stringify(a.to)!=='[25,580,120]'))) throw new Error('probe must cross horizontal aperture');
   report.rawArtifact=doc;
   await writeFile('benchmarks/r82/model-window-actions.json',JSON.stringify(doc,null,2));
   return {ok:true,artifacts:['benchmarks/r82/model-window-actions.json'],partial:true,detail:'schema-valid model test authored; real engine execution still required'};
  },
  verifyTask:async()=>({checks:[{id:'schema',kind:'custom',status:'passed',detail:'allowlisted operations and substantive collision/state assertions',durationMs:0}],passed:1,failed:0,blocked:0,verified:true,ranAt:new Date().toISOString()}),
  persist:run=>writeFile(`${dir}/director-model-task.json`,JSON.stringify(run,null,2))
 });
 const run=director.createRun({goal:'Create a native regression test for the functional modular Western room window',engineTarget:'ue-4.27',leadPolicy:'auto'});
 report.director=await director.execute(run.id);
 report.status=report.rawArtifact?'MODEL_TEST_AUTHORED_PENDING_ENGINE':'BLOCKED';
} catch(e){report.status='BLOCKED';report.error=String(e);}
report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({file,status:report.status,error:report.error}));
