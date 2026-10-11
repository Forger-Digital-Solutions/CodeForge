import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateMigration, applyMigration, migrationAssemblyScript } from "../../packages/forge-aaa/dist/index.js";
import { R82_ONE_ROOM_BUILDING as source, R82_ONE_ROOM_MODULES as before, R83_TWO_ROOM_BUILDING as target, R83_TWO_ROOM_MODULES as after } from "../../packages/forge-aaa/dist/r83-building-spec.js";
import { python, unreal, install, project, scratch, pilot, evidenceDir } from "./live-utils.mjs";
const stamp=Date.now(),level=`/Game/ForgeAAA/Maps/FAAA_R83_PathSafety_${stamp}`;
const levelFile=path.join(pilot,"Content",level.slice(6)+".umap"),file=path.join(evidenceDir,`artifact-path-safety-${stamp}.json`);
const report={startedAt:new Date().toISOString(),level,cases:{}};
const hash=async()=>createHash("sha256").update(await readFile(levelFile)).digest("hex");
try {
  report.assembly=await unreal.assembleBuilding({projectPath:project,authorizedProjectPath:project,approved:true,levelPath:level,building:source,modules:before,install,scriptPath:path.join(scratch,`path-source-${stamp}.py`),logPath:path.join(scratch,`path-source-${stamp}.log`),timeoutMs:180000});
  if(!report.assembly.ok)throw new Error("source assembly failed");
  report.sourceHash=await hash();
  const valid=validateMigration(source,target,after,{previousRegistry:before}),migration=applyMigration(valid,valid.previousRevision.fingerprint);
  for(const [name,receiptPath,backupPath] of [
    ["receipt-aliases-level",levelFile,path.join(scratch,`path-backup-${stamp}.umap`)],
    ["backup-aliases-level",path.join(scratch,`path-receipt-${stamp}.json`),levelFile],
    ["receipt-temp-aliases-backup",path.join(scratch,`path-temp-${stamp}.json`),path.join(scratch,`path-temp-${stamp}.json.tmp`)],
  ]) {
    const result=await python(`${name}-${stamp}`,migrationAssemblyScript(migration,target,after,level,{receiptPath,backupPath}));
    report.cases[name]={...result,levelHash:await hash()};
    if(result.report?.phase!=="BLOCKED"||result.report?.mutation_started||await hash()!==report.sourceHash)throw new Error("artifact alias failed to preserve source "+name);
  }
  report.ok=true;
} catch(error){report.error=String(error);process.exitCode=1;}
report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2));console.log(JSON.stringify({file,ok:report.ok,error:report.error}));
