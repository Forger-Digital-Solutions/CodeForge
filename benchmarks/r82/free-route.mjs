import { createKiloFreeDirectAdapter } from "@codeforge/providers";
import { NormalizedModelRegistry, discoverAndVerifyFree, reverifyKiloPolicy } from "@codeforge/model-registry";
import { ForgeZero } from "@codeforge/forge-zero";

export async function admitFreeRoute(modelId, evidence) {
  const adapter=createKiloFreeDirectAdapter();
  evidence.policy=await reverifyKiloPolicy(new Date().toISOString());
  if(evidence.policy.status!=="VERIFIED") throw new Error('POLICY_'+evidence.policy.status);
  const catalog=await adapter.listModels();
  evidence.catalog=catalog.map(m=>({modelId:m.modelId,isFree:m.isFree}));
  const model=catalog.find(m=>m.modelId===modelId&&m.isFree);
  if(!model) throw new Error('MODEL_NOT_CURRENTLY_FREE');
  const registry=new NormalizedModelRegistry();
  const result=discoverAndVerifyFree(registry,adapter.providerId,catalog.map(m=>({...m,...m.capabilities})));
  const firewall=new ForgeZero({privacyMode:'MAXIMUM_FREE',requireOngoingFree:true});
  for(const record of result.records) firewall.register({...record,health:{status:'available',lastCheckedAt:new Date().toISOString()}});
  const admission=firewall.verify(adapter.providerId,modelId);
  evidence.admission={ok:admission.ok,...(!admission.ok?{error:admission.error.message}:{costProfile:admission.value.costProfile,privacyClass:admission.value.privacyClass})};
  if(!admission.ok) throw new Error('FORGEZERO_DENIED: '+admission.error.message);
  return adapter;
}

export async function boundedChat(adapter, request, evidence) {
  const frame={model:request.model,startedAt:new Date().toISOString(),events:0,raw:''};
  evidence.frames??=[]; evidence.frames.push(frame);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),90000);
  try {
    for await(const event of adapter.streamChat({...request,signal:controller.signal})) {
      frame.events++;
      if(event.type==='text_delta') frame.raw+=event.delta;
      if(event.type==='error') throw new Error(event.message);
    }
    return frame.raw;
  } finally {clearTimeout(timer);frame.finishedAt=new Date().toISOString();}
}
