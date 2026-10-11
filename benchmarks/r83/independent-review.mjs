import { readFile, writeFile } from "node:fs/promises";
import { createModelReviewer } from "../../packages/forge-aaa/dist/index.js";
import { admitFreeRoute, boundedChat } from "../r82/free-route.mjs";

export async function reviewMilestone(milestone, extraContext="") {
  if(!["r82","r83"].includes(milestone))throw new Error("Unsupported review scope");
  const directory="docs/evidence/r83-forgeaaa-autonomous-multiroom";
  const model="nvidia/nemotron-3-ultra-550b-a55b:free";
  const file=`${directory}/${milestone}-review-addendum-${Date.now()}.json`;
  const report={startedAt:new Date().toISOString(),model,costUSD:0,scope:"Source and structured engine evidence; no image input or visual model review claim"};
  try {
    const raw=JSON.parse(await readFile("docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json","utf8"));
    const role=raw.qualification?.roleResults?.REVIEWER;
    if(raw.modelId!==model||role?.status!=="QUALIFIED")throw new Error("Reviewer qualification unavailable");
    report.qualification={providerId:raw.providerId,suiteVersion:raw.qualification.suiteVersion,protocolVersion:raw.qualification.metadata.roleProtocolVersions.REVIEWER,status:role.status,completedAt:role.completedAt,score:role.overallScore};
    const packet=await readFile(`${directory}/${milestone}-review-packet.md`,"utf8")+extraContext;
    if(packet.length>84000)throw new Error("Review packet exceeds bounded budget");
    const adapter=await admitFreeRoute(model,report);
    const reviewer=createModelReviewer({modelId:model,qualification:report.qualification,packetMaxChars:84000,packetOf:()=>packet,chat:async request=>{
      const raw=await boundedChat(adapter,{...request,maxTokens:5000},report);
      const verdict=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]??"null");
      const nonempty=value=>typeof value==="string"&&value.trim().length>0;
      if(!verdict||!["pass","revision_required"].includes(verdict.verdict)||!nonempty(verdict.summary)||!Array.isArray(verdict.findings)||verdict.findings.some(f=>!f||!nonempty(f.id)||!["blocking","advisory"].includes(f.severity)||!nonempty(f.category)||!nonempty(f.message)||(f.evidence!==undefined&&typeof f.evidence!=="string")))throw new Error("Incomplete independent verdict schema");
      return raw;
    }});
    report.review=await reviewer({});
    report.status=report.review.independent?"INDEPENDENTLY_REVIEWED":"BLOCKED";
  } catch(error){report.status="BLOCKED";report.error=String(error);}
  report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({file,status:report.status,approved:report.review?.approved,error:report.error}));
  return report.review??{approved:false,independent:false,findings:[report.error??"No qualified verdict"]};
}
if(process.argv[1]?.endsWith("independent-review.mjs")) {
  if(!process.argv.includes("--send"))throw new Error("External payload approval must arrive before using --send");
  for(const scope of process.argv.includes("--r82-only")?["r82"]:["r82","r83"])await reviewMilestone(scope);
}
