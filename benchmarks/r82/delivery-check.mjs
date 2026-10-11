import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SecretScanner} from '@codeforge/secrets';
const dir='docs/evidence/r82-forgeaaa-modular-western-interior';
const json=async n=>JSON.parse(await readFile(`${dir}/${n}`,'utf8'));
const base=await json('runtime-regressions.json'),retry=await json('runtime-failures-standalone.json');
const records=new Map();
for(const report of [base,retry])for(const file of report.testResults)file.assertionResults.forEach((a,i)=>records.set(`${file.name}#${i}`,{file:file.name,status:a.status}));
const counts={passed:0,failed:0,skipped:0};for(const r of records.values()){if(r.status==='passed')counts.passed++;else if(r.status==='failed')counts.failed++;else counts.skipped++;}
const modules=JSON.parse(await readFile('benchmarks/r82/module-registry.json','utf8'));
const hashes=[];for(const m of modules){const asset=await readFile('.scratch/'+m.sourceAsset);hashes.push({moduleId:m.moduleId,matches:createHash('sha256').update(asset).digest('hex')===m.contentSha256});}
const fixture=[];
async function checkSources(relative='') {
 for(const entry of await readdir('benchmarks/r82/forge-gameplay-plugin/'+relative,{withFileTypes:true})){
  const name=relative+entry.name;
  if(entry.isDirectory())await checkSources(name+'/');
  else {const source=await readFile('benchmarks/r82/forge-gameplay-plugin/'+name),live=await readFile('.scratch/pilot/Plugins/ForgeGameplay/'+name);fixture.push({name,sha256:createHash('sha256').update(source).digest('hex'),matches:source.equals(live)});}
 }
}
await checkSources();
const evidenceFiles=(await readdir(dir)).filter(n=>/\.(json|md|log)$/.test(n)),scanner=new SecretScanner(),findings=[];
for(const n of evidenceFiles)for(const match of scanner.scan(await readFile(`${dir}/${n}`,'utf8')))findings.push({file:n,type:match.type,line:match.line});
const report={checkedAt:new Date().toISOString(),runtimeReconciliation:{initial:{passed:base.numPassedTests,failed:base.numFailedTests,skipped:base.numPendingTests},standalone:{passed:retry.numPassedTests,failed:retry.numFailedTests,skipped:retry.numPendingTests},uniqueFinal:counts},assetHashes:hashes,nativeFixture:fixture,nativeBinarySha256:createHash('sha256').update(await readFile('.scratch/pilot/Plugins/ForgeGameplay/Binaries/Win64/UE4Editor-ForgeGameplay.dll')).digest('hex'),noRuntimePythonStartup:!(await readFile('.scratch/pilot/Config/DefaultEngine.ini','utf8')).includes('StartupScripts'),evidenceSecretScan:{files:evidenceFiles.length,findings}};
report.ok=counts.failed===0&&hashes.every(h=>h.matches)&&fixture.every(f=>f.matches)&&report.noRuntimePythonStartup&&findings.length===0;
await writeFile(`${dir}/delivery-check.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,runtime:counts,sourceFiles:fixture.length,assets:hashes.length,secrets:findings.length}));if(!report.ok)process.exitCode=1;
