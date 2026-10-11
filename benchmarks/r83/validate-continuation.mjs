import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const directory="docs/evidence/r83-forgeaaa-autonomous-multiroom";
const checks=[
  ["forge-aaa-build",process.execPath,["G:/CodeForge/node_modules/typescript/bin/tsc","-b","packages/forge-aaa"]],
  ["workspace-build","cmd.exe",["/d","/s","/c","npm run build --script-shell=cmd.exe"]],
  ["lint",process.execPath,["G:/CodeForge/node_modules/oxlint/bin/oxlint","--deny-warnings","--ignore-pattern","tests/evidence/**","packages","apps","tests","scripts"]],
  ["secret-scan",process.execPath,["scripts/security/secret-scan.mjs","--self-test","--scan","--json",`${directory}/secret-scan.json`]],
  ["dependency-audit",process.execPath,["scripts/security/audit-dependencies.mjs","--json",`${directory}/dependency-audit.json`,"--sbom",`${directory}/sbom.json`]],
  ["public-claims",process.execPath,["scripts/security/public-claims-scan.mjs","--json",`${directory}/public-claims.json`]],
  ["doc-links",process.execPath,["scripts/security/validate-doc-links.mjs","--json",`${directory}/doc-links.json`]],
];
const report={startedAt:new Date().toISOString(),checks:[]};
for(const [name,executable,args] of checks) {
  const started=Date.now();
  const result=spawnSync(executable,args,{cwd:process.cwd(),env:process.env,encoding:"utf8",windowsHide:true,timeout:300000,maxBuffer:32*1024*1024});
  const logPath=path.join(directory,`validation-${name}.log`);
  await writeFile(logPath,(result.stdout??"")+(result.stderr??""));
  report.checks.push({name,command:[executable,...args],exitCode:result.status,error:result.error?.message,signal:result.signal,durationMs:Date.now()-started,logPath});
  await writeFile(path.join(directory,"validation-continuation.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.checks.at(-1)));
}
report.finishedAt=new Date().toISOString();await writeFile(path.join(directory,"validation-continuation.json"),JSON.stringify(report,null,2));
