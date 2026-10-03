import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createSessionPersistence } from '@codeforge/sessions';
import { createEightBitRuntime } from '@codeforge/eight-bit';
import { ProviderError } from '@codeforge/providers';
import { liveSupply } from './live-supply.mjs';

const output = {startedAt:new Date().toISOString(),status:'RUNNING',evidenceClass:'LIVE_FREE_ROLE_CALLS_WITH_CONTROLLED_ADAPTER_BOUNDARY_FAULT',domains:[],limitations:['Faults are explicitly injected at the real adapter boundary; these are not naturally observed upstream outages.','A successful reasoner diagnostic role call is not an autonomous software task completion.'],costState:'UNKNOWN'};
const persist=()=>writeFile(process.argv[2]??'docs/evidence/r67-everyday-completion-reliability/R67-PROVIDER-FAULT-RECOVERY.json',JSON.stringify(output,null,2)+'\n');
let fault;
const supply=await liveSupply('r67-provider-recovery',provider=>{if(fault?.providerId===provider){const f=fault;fault=undefined;throw new ProviderError('R67 controlled adapter-boundary '+(f.status??'ECONNRESET')+' '+f.code,f.code,true,{status:f.status,retryAfter:Date.now()+5000});}});
const refresh=await readFile('docs/evidence/r67-everyday-completion-reliability/R67-HORDE-ROLE-QUALITY-refresh.json','utf8').then(JSON.parse).catch(()=>undefined);
if(refresh?.qualification&&!refresh.qualification.metadata?.transient){await supply.freeCloud.recordReceipt(refresh.qualification);supply.freeCloud.applyReceiptToFirewall(refresh.qualification);}
const db=createSessionPersistence({dbPath:':memory:'});await db.init();
for(const providerId of ['kilo-free-direct','ai-horde']) for(const suffix of ['', '-recover']) await db.upsertSession({id:'r67-controlled-'+providerId+suffix,title:'Public controlled provider recovery',status:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const eight=createEightBitRuntime({firewall:supply.firewall,persistence:db,freeFabric:supply.fabric,routeHealth:supply.health,fabricContext:()=>({userId:'r67-provider-recovery',userIdentities:supply.freeCloud.capacityIdentitiesFor('r67-provider-recovery'),dataContext:{dataClass:'PUBLIC_CODE',userConsented:true}})});
const role='ANALYST';
const allowed=(provider,model)=>{const status=supply.freeCloud.getReceipt(provider,model)?.roleResults[role]?.status;return supply.freeCloud.isForgeAutoEligible(provider,model)&&['QUALIFIED','PROBATION'].includes(status)&&!supply.freeCloud.runtimeRequalificationRoles(provider,model).includes(role);};
const options={policyMode:'adaptive',userId:'r67-provider-recovery',estimatedPromptTokens:150,outputTokenDemand:512,hasAdapter:provider=>!!supply.catalog.get(provider),routeFilter:allowed,roleQualificationTierFor:(provider,model)=>supply.freeCloud.getReceipt(provider,model)?.roleResults[role]?.status??'NOT_TESTED'};
async function call(route,poolId){
  const events=[],start=Date.now();
  for await(const event of supply.catalog.get(route.providerId).streamChat({model:route.modelId,messages:[{role:'system',content:'You are CodeForge Reasoner. Inspect public synthetic code for a concrete defect. Answer briefly.'},{role:'user',content:'Public diagnostic: export function multiply(a,b){return a+b}. The preserved test expects multiply(7,9) to equal 63 but receives 16. State the defective operator and the required replacement.'}],maxTokens:512,temperature:0},AbortSignal.timeout(90000)))events.push(event);
  const text=events.filter(e=>e.type==='text_delta').map(e=>e.text??e.delta??'').join('');
  if(events.some(e=>e.type==='error')||!(/multipli|\*/i.test(text)&&/add|\+/i.test(text)))throw new Error('LIVE_REASONER_DIAGNOSTIC_NOT_VERIFIED');
  eight.recordSuccess(route.providerId,route.modelId,{role,quotaDomainId:poolId,latencyMs:Date.now()-start,requestShape:'production'});
  return {route,poolId,text,events,latencyMs:Date.now()-start,verified:true};
}
try{
  for(const providerId of ['kilo-free-direct','ai-horde']){
    const row={providerId,status:'RUNNING',steps:[]};output.domains.push(row);await persist();
    const id='r67-controlled-'+providerId,scope={sessionId:id,role};
    const initial=await eight.selectInitialRoute(scope,{...options,routeFilter:(p,m)=>p===providerId&&allowed(p,m)},{runId:id});
    if(initial.outcome!=='selected'){row.status='ROLE_INELIGIBLE';row.denial=initial;await persist();continue;}
    const route={providerId:initial.model.providerId,modelId:initial.model.modelId};const poolId=initial.fabric.selected.capacityPoolId;
    row.qualification=supply.freeCloud.getReceipt(route.providerId,route.modelId)?.roleResults[role]?.status;
    row.steps.push({phase:'working-role',...await call(route,poolId)});
    const faultKind=process.argv[3]??'429';
    fault={providerId,code:faultKind==='socket'?'STREAM_FAILED':faultKind==='503'?'TEMPORARY_CAPACITY':'RATE_LIMITED',status:faultKind==='socket'?undefined:Number(faultKind)};
    let injectedError;try{await call(route,poolId);}catch(error){injectedError=error;}
    assert.ok(injectedError);assert.equal(fault,undefined);
    const failure=await eight.handleTurnFailure({...options,sessionId:id,turnId:id+'-fault',runId:id,role,current:route,currentCapacityPoolId:poolId,error:injectedError,isExactPin:false,pinMode:'auto',preferIndependentFromPoolId:poolId});
    row.steps.push({phase:'controlled-degrade-and-rotate',faultCode:injectedError.code,faultStatus:injectedError.status,failure,health:supply.health.assess(route.providerId,route.modelId,{role,quotaDomainId:poolId})});
    const eligibleAlternates=supply.freeCloud.productionCapacityRoutes().filter(candidate=>candidate.providerId!==providerId&&allowed(candidate.providerId,candidate.modelId));
    row.eligibleIndependentAlternates=eligibleAlternates.map(candidate=>({providerId:candidate.providerId,modelId:candidate.modelId}));
    if(eligibleAlternates.length){assert.equal(failure.action,'rotate');assert.notEqual(failure.replacement.providerId,providerId);row.steps.push({phase:'alternate-role',...await call(failure.replacement,failure.capacityPoolId)});}
    else {assert.equal(failure.action,'retry_same');row.steps.push({phase:'bounded-same-route-retry-no-qualified-alternate',...await call(route,poolId)});}
    eight.releaseFabricAdmission(id);
    const waitStarted=Date.now(),deadline=Date.now()+130000;let recovered;
    while(Date.now()<deadline){
      recovered=await eight.selectInitialRoute({sessionId:id+'-recover',role},{...options,routeFilter:(p,m)=>p===providerId&&allowed(p,m)},{runId:id+'-recover'});
      if(recovered.outcome==='selected')break;
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    assert.equal(recovered.outcome,'selected');
    row.steps.push({phase:'cooldown-expired-live-role-reuse',waitMs:Date.now()-waitStarted,admission:recovered.fabric,...await call(route,recovered.fabric.selected.capacityPoolId)});
    eight.releaseFabricAdmission(id+'-recover');row.status='PASS';await persist();
  }
  assert(output.domains.some(row=>row.status==='PASS'&&row.steps.filter(step=>step.verified===true).length>=3),'ACTUAL_LIVE_ROLE_RECOVERY_REQUIRED');
  output.status='PASS_CONTROLLED_LIVE_ROLE_RECOVERY';
}catch(error){output.status='PARTIAL';output.error=String(error);}
output.finishedAt=new Date().toISOString();output.receipts=await db.getWorkItemsByKind('eight_bit_decision_receipt');output.health=supply.health.snapshot();await db.close();await persist();console.log(JSON.stringify({status:output.status,domains:output.domains.map(d=>({provider:d.providerId,status:d.status,steps:d.steps.length})),error:output.error}));
