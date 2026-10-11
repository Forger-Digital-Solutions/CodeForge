import { readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const directory="docs/evidence/r83-forgeaaa-autonomous-multiroom";
const head=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
const index=JSON.parse(await readFile(`${directory}/continuation-evidence-index.json`,"utf8"));
const hash=source=>createHash("sha256").update(source).digest("hex");
let packet=`R83 independent review packet; prepared ${new Date().toISOString()}; source checkpoint ${head} plus pending source below.\n\nAssess actual fixes, saved-level verification, faults, idempotency, gameplay, persistence and the Director status recorded in the evidence index. The milestone remains PARTIAL while qualified review and full workspace validation are unsatisfied. Prepared code alone does not prove execution; actual task states and receipts do. Images were inspected by the engineering agent; this text request carries no images and supports no visual-model-review claim. Historical bypassed success reports and all failed attempts remain preserved.\n\n`;
const compactIndex={...index,modelEligibility:{checkedAt:index.modelEligibility.checkedAt,models:Object.fromEntries(Object.entries(index.modelEligibility.models).map(([role,m])=>[role,{model:m.model,qualification:m.qualification,status:m.status,admission:m.admission}]))},externalApproval:{status:index.externalApproval.status,approval:index.externalApproval.approval}};
packet+=JSON.stringify(compactIndex)+"\n\n";
for(const file of ["packages/forge-aaa/src/building-revision.ts","packages/forge-aaa/src/connected-building.ts","benchmarks/r83/director-live.mjs"]) {
  const source=await readFile(file,"utf8");packet+=`SOURCE ${file}; sha256 ${hash(source)}\n${source}\n\n`;
}
const diff=spawnSync("git",["diff","--no-index","--","benchmarks/r82/forge-gameplay-plugin/Source/ForgeGameplay/Private/ForgeDoorTestDriver.cpp","benchmarks/r83/forge-gameplay-plugin/Source/ForgeGameplay/Private/ForgeDoorTestDriver.cpp"],{encoding:"utf8",maxBuffer:1024*1024});
if(diff.error||![0,1].includes(diff.status))throw new Error("Native diff failed");
const nativeDiff=diff.stdout;
packet+="Native driver changes (complete diff):\n"+nativeDiff+"\n";
packet+="Report provenance: R83-FINAL-REPORT.md sha256 "+hash(await readFile(`${directory}/R83-FINAL-REPORT.md`,"utf8"))+". Current limitations: full workspace build and repository lint fail outside changed scope; ForgeAAA and native builds and changed-source lint pass. Secret/public-claims/doc-links gates pass; dependency gate has eight moderate and zero high/critical advisories. R76 lacks independent zero-touch free quota redundancy. R82 historical reviewer timeout is retained. This snapshot precedes the final Director context appended to its actual review request; pending Director flags are superseded only by actual completed task evidence in that context.\n";
if(packet.length>78000)throw new Error(`Review packet too large: ${packet.length}`);
await writeFile(`${directory}/r83-review-packet.md`,packet);
const original=await readFile("docs/evidence/r82-forgeaaa-modular-western-interior/review-packet.md","utf8");
await writeFile(`${directory}/r82-review-packet.md`,"R82 dated addendum request. Original R82 source/evidence remain unchanged at f1b02e3f4ae5c522964743ccf04a33d004a91c33. The prior qualified reviewer timeout remains historical evidence; this new request is not approval. Review the original scope below, without attributing R83 changes to R82. No image input or visual-model claim.\n\n"+original);
console.log(JSON.stringify({r83Chars:packet.length,r82Chars:original.length,inferenceSent:false}));
