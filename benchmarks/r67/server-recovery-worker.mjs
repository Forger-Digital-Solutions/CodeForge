import { writeFile } from 'node:fs/promises';
import { createServer } from '@codeforge/server';
import { liveSupply } from './live-supply.mjs';
const [dbPath, workspacePath, worktreeParentDir] = process.argv.slice(2);
const owner = 'r67-live-parent-public';
const supply = await liveSupply(owner);
const server = createServer({ port: 0, dbPath, worktreeParentDir, useRealRuntime: true, subagentsR1Enabled: true, firewall: supply.firewall, providerCatalog: supply.catalog, freeCloud: supply.freeCloud, routeHealth: supply.health, localUserId: owner, freeDataContext: () => ({ dataClass: 'PUBLIC_CODE', userConsented: true }) });
const started = Date.now();
await server.start();
const listenMs = Date.now() - started;
const runId = 'run-00000000-0000-4000-8000-000000000068';
let run;
const deadline = Date.now() + 600000;
while (Date.now() < deadline) {
  const response = await fetch(`http://127.0.0.1:${server.httpPort}/api/orchestrator/${runId}`, { signal: AbortSignal.timeout(10000) });
  run = await response.json();
  if (['completed','blocked','failed','cancelled'].includes(run.status) && (run.result || run.error !== 'Server restarted during active execution')) break;
  await new Promise(resolve => setTimeout(resolve,1000));
}
await writeFile(dbPath+'.recovered.json',JSON.stringify({ listenMs, status: run?.status, result: run?.result, error: run?.error, supply: supply.receipts, routeHealth: supply.health.snapshot() },null,2));
console.log(JSON.stringify({ listenMs,status:run?.status,error:run?.error }));
await server.stop();
process.exitCode = run?.status === 'completed' && run.result?.completion?.outcome === 'completed' ? 0 : 3;
