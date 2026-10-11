import {readFile,writeFile} from 'node:fs/promises';
import {createModelReviewer} from '../../packages/forge-aaa/dist/index.js';
import {admitFreeRoute,boundedChat} from './free-route.mjs';

const model='nvidia/nemotron-3-ultra-550b-a55b:free', dir='docs/evidence/r82-forgeaaa-modular-western-interior';
const file=`${dir}/independent-review-${Date.now()}.json`,report={startedAt:new Date().toISOString(),model,costUSD:0,scope:'source and structured engine evidence; no image input and no visual-model claim'};
try {
 const receipt=JSON.parse(await readFile('docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json','utf8'));
 const role=receipt.qualification?.roleResults?.REVIEWER;
 if(role?.status!=='QUALIFIED'||receipt.modelId!==model) throw new Error('reviewer not qualified');
 report.qualification={providerId:receipt.providerId,suiteVersion:receipt.qualification.suiteVersion,protocolVersion:receipt.qualification.metadata.roleProtocolVersions.REVIEWER,status:role.status,completedAt:role.completedAt,score:role.overallScore};
 const adapter=await admitFreeRoute(model,report);
 const packet=await readFile(`${dir}/review-packet.md`,'utf8');
 if(packet.length>84000) throw new Error('review packet exceeds bounded budget');
 const reviewer=createModelReviewer({modelId:model,qualification:report.qualification,packetMaxChars:84000,packetOf:()=>packet,chat:req=>boundedChat(adapter,{...req,maxTokens:5000},report)});
 report.review=await reviewer({});
 report.status=report.review.independent?'INDEPENDENTLY_REVIEWED':'BLOCKED';
} catch(e) {report.status='BLOCKED';report.error=String(e);}
report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({file,status:report.status,approved:report.review?.approved,verdict:report.review?.verdict,error:report.error}));
