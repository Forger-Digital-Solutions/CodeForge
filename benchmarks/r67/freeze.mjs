import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const file='packages/server/src/autonomous-orchestrator.ts';
await writeFile(file,(await readFile(file,'utf8')).trimEnd()+'\n');
execFileSync(process.execPath,['benchmarks/r67/recertify-source-state.mjs'],{stdio:'inherit'});
const state=JSON.parse(await readFile('docs/codeforge-forgegreen-certified-source-state.json','utf8'));
const hashes=await Promise.all(state.materialFiles.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
await writeFile('docs/evidence/r67-everyday-completion-reliability/R67-SOURCE-FREEZE.json',JSON.stringify({at:new Date().toISOString(),baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceStateId:state.sourceStateId,sourceAggregateSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),files:hashes},null,2)+'\n');
