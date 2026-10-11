import { writeFile, readFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateMigration, applyMigration, migrationAssemblyScript, verifySavedMigration, rollbackMigration, commitMigration, verifyMigration } from "../../../packages/forge-aaa/dist/index.js";
import { R82_ONE_ROOM_BUILDING as source, R82_ONE_ROOM_MODULES as before, R83_TWO_ROOM_BUILDING as target, R83_TWO_ROOM_MODULES as after } from "../../../packages/forge-aaa/dist/r83-building-spec.js";
import { python, unreal, install, project, scratch, pilot, evidenceDir } from "./live-utils.mjs";
const stamp=Date.now(), level=`/Game/ForgeAAA/Maps/FAAA_R83_FaultCampaign_${stamp}`;
const levelFile=path.join(pilot,"Content",level.slice(6)+".umap");
const file=path.join(evidenceDir,`migration-fault-campaign-${stamp}.json`), report={startedAt:new Date().toISOString(),level,cases:{}};
const persist=()=>writeFile(file,JSON.stringify(report,null,2));
const hash=async file=>createHash("sha256").update(await readFile(file)).digest("hex");
const plan=(sourceBuilding=source,targetModules=after)=>{
  const valid=validateMigration(sourceBuilding,target,targetModules,{previousRegistry:before});
  return applyMigration(valid,valid.previousRevision.fingerprint);
};
async function invoke(name,migration,extra={}) {
  const options={receiptPath:path.join(scratch,`${name}-${stamp}-receipt.json`),backupPath:path.join(scratch,`${name}-${stamp}-backup.umap`),levelFilePath:levelFile,...extra};
  const result=await python(`${name}-${stamp}`,migrationAssemblyScript(migration,target,migration.targetModules,level,options));
  report.cases[name]={...result,levelHash:await hash(levelFile)};await persist();return {result,options};
}
try {
  report.assembly=await unreal.assembleBuilding({projectPath:project,authorizedProjectPath:project,approved:true,levelPath:level,building:source,modules:before,install,scriptPath:path.join(scratch,`fault-source-${stamp}.py`),logPath:path.join(scratch,`fault-source-${stamp}.log`),timeoutMs:180000});
  if(!report.assembly.ok) throw new Error("fault source assembly failed");
  report.sourceHash=await hash(levelFile);await persist();
  const missing=structuredClone(after);missing.find(m=>m.displayName==="SM_Ceiling_B").engineAsset="/Game/ForgeAAA/R83/SM_RequiredMissing";
  const a=await invoke("missing-mesh",plan(source,missing));
  if(a.result.report?.mutation_started || a.result.report?.phase!=="BLOCKED" || await hash(levelFile)!==report.sourceHash) throw new Error("missing mesh failed to preserve source");
  const b=await invoke("source-conflict",plan({...source,attachmentToleranceCm:1}));
  if(b.result.report?.mutation_started || b.result.report?.phase!=="BLOCKED" || await hash(levelFile)!==report.sourceHash) throw new Error("source conflict failed to preserve source");
  const migration=plan();
  const c=await invoke("fault-after-three",migration,{failAfterMutations:3});
  if(c.result.report?.phase!=="ROLLED_BACK" || await hash(levelFile)!==report.sourceHash) throw new Error("fault rollback failed");
  const proof=await verifySavedMigration(migration,{projectPath:project,levelPath:level,evidenceDirectory:evidenceDir,phase:"ROLLED_BACK"});
  report.cases["fault-after-three"].state=rollbackMigration(migration,proof).status;
  const d=await invoke("interrupted",migration,{interruptAfterMutations:3});
  report.interruptionReceipt=JSON.parse(await readFile(d.options.receiptPath,"utf8"));
  await copyFile(d.options.receiptPath,path.join(evidenceDir,`interrupted-before-recovery-${stamp}.json`));
  if(d.result.exitCode!==86 || report.interruptionReceipt.phase!=="INTERRUPTED" || await hash(levelFile)===report.sourceHash) throw new Error("controlled partial-save interruption not observed");
  const recovered=await invoke("interrupted-recovery",migration,{...d.options,recoverInterrupted:true});
  if(recovered.result.report?.phase!=="ROLLED_BACK" || recovered.result.report?.recoveredInterrupted!==true || await hash(levelFile)!==report.sourceHash) throw new Error("durable interruption recovery failed");
  const recoveredProof=await verifySavedMigration(migration,{projectPath:project,levelPath:level,evidenceDirectory:evidenceDir,phase:"ROLLED_BACK"});
  report.cases["interrupted-recovery"].state=rollbackMigration(migration,recoveredProof).status;
  const copied=JSON.parse(JSON.stringify(recoveredProof));
  report.cases["caller-evidence"]={boolean:commitMigration(verifyMigration(migration),true).status,copiedRollback:rollbackMigration(migration,copied).status};
  if(report.cases["caller-evidence"].boolean!=="BLOCKED"||report.cases["caller-evidence"].copiedRollback!=="BLOCKED") throw new Error("caller evidence accepted");
  const committed=await invoke("commit-before-repeat",migration);
  if(!committed.result.ok||committed.result.report?.phase!=="COMMITTED")throw new Error("strict commit before repeat failed");
  const committedHash=await hash(levelFile);
  const repeated=await invoke("idempotency-repeat",migration,committed.options);
  if(!repeated.result.ok||repeated.result.report?.ok!==true||repeated.result.report?.idempotent!==true||repeated.result.report?.instanceCount!==23||await hash(levelFile)!==committedHash)throw new Error("repeat changed level or duplicated instances");
  const committedProof=await verifySavedMigration(migration,{projectPath:project,levelPath:level,evidenceDirectory:evidenceDir,phase:"COMMITTED"});
  report.cases["separate-process-commit"]={state:commitMigration(verifyMigration(migration),committedProof).status,evidence:committedProof};
  if(report.cases["separate-process-commit"].state!=="COMMITTED")throw new Error("fresh commit readback blocked");
  report.ok=true;
} catch(error){report.error=String(error);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({file,ok:report.ok,error:report.error,cases:Object.fromEntries(Object.entries(report.cases).map(([k,v])=>[k,v.report?.phase??v]))}));
