import { readFile, writeFile } from "node:fs/promises";
import { admitFreeRoute } from "../r82/free-route.mjs";
const report={checkedAt:new Date().toISOString(),inferenceRequests:0,projectPayloadsSent:0,models:{}};
for(const [role,model,receiptPath] of [
  ["CODER","nvidia/nemotron-3-super-120b-a12b:free","docs/evidence/r80-forgeaaa-autonomous-gameplay/phase-g-coder-capacity-1791699174859.json"],
  ["REVIEWER","nvidia/nemotron-3-ultra-550b-a55b:free","docs/evidence/r74-autonomous-completion-and-free-reliability/reviewer-nvidia_nemotron-3-ultra-550b-a55b_free-1791628393855.json"],
]) {
  const evidence=report.models[role]={model,role,qualificationReceiptPath:receiptPath};
  try {
    const raw=JSON.parse(await readFile(receiptPath,"utf8"));
    const receipt=role==="CODER"?raw.qualifications["nemotron-3-super"].receipt:raw;
    const qualification=role==="CODER"?receipt:receipt.qualification;
    if(receipt.modelId!==model||qualification.roleResults[role].status!=="QUALIFIED")throw new Error("historical qualification missing");
    evidence.qualification={historical:true,status:qualification.roleResults[role].status,score:qualification.roleResults[role].overallScore};
    await admitFreeRoute(model,evidence);
    evidence.status="CURRENT_FREE_ADMISSION_PASSED";
  } catch(error){evidence.status="BLOCKED";evidence.error=String(error);}
}
await writeFile("docs/evidence/r83-forgeaaa-autonomous-multiroom/model-eligibility.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.models).map(([role,e])=>[role,{status:e.status,error:e.error}]))));
