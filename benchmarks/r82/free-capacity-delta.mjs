import {readFile,writeFile} from 'node:fs/promises';
import {createKiloFreeDirectAdapter,createBlockRunFreeAdapter} from '@codeforge/providers';
import {reverifyKiloPolicy} from '@codeforge/model-registry';
const dir='docs/evidence/r82-forgeaaa-modular-western-interior';
const previous=JSON.parse(await readFile('docs/evidence/r81-forgeaaa-native-gameplay/phase-h-capacity-delta-1791727704467.json','utf8'));
const report={startedAt:new Date().toISOString(),catalogs:{},delta:{},inferenceRequests:0,costUSD:0,status:'CODEFORGE_R76_PARTIAL'};
try {
 report.policy=await reverifyKiloPolicy(report.startedAt);
 for(const [provider,adapter] of [['kilo-free-direct',createKiloFreeDirectAdapter()],['blockrun-free-direct',createBlockRunFreeAdapter()]]) {
  try {
   const models=(await adapter.listModels()).filter(m=>m.isFree).map(m=>m.modelId);
   report.catalogs[provider]={ok:true,models};
   const old=provider==='kilo-free-direct'?previous.catalogs[provider].filter(m=>m.isFree).map(m=>m.modelId):previous.catalogs[provider].models;
   report.delta[provider]={added:models.filter(id=>!old.includes(id)),removed:old.filter(id=>!models.includes(id))};
  } catch(e){report.catalogs[provider]={ok:false,error:String(e)};}
 }
 report.independentCoderQuotaDomains=1;
 report.note='Catalog delta only. Historical qualifications do not prove present inference health; same Kilo anonymous quota domain. No unchanged-route requalification and no new domain certification.';
} catch(e){report.error=String(e);}
report.finishedAt=new Date().toISOString();const file=`${dir}/free-capacity-delta-${Date.now()}.json`;await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,delta:report.delta,error:report.error}));
