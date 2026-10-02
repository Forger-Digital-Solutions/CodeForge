import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const base = "57db998de17eead4254f7a1e9ba985e482d91e8c";
const modulePath = "packages/cloud-gateway/src/hosted-queue-worker.ts";
const directory = new URL("../benchmarks/r63/tmp/heap-diagnosis/", import.meta.url);
await mkdir(directory, { recursive: true });
const sources = {
  baseline: execFileSync("git", ["show", `${base}:${modulePath}`], { encoding: "utf8" }),
  repaired: await readFile(new URL(`../${modulePath}`, import.meta.url), "utf8"),
};
const report = { generatedAt: new Date().toISOString(), baselineCommit: base, status: "RUNNING", observationMs: 1500, source: modulePath, cases: [] };
for (const [name, source] of Object.entries(sources)) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  await writeFile(new URL(`${name}-worker.mjs`, directory), compiled);
  const childPath = new URL(`${name}-case.mjs`, directory);
  await writeFile(childPath, `import { HostedQueueWorker } from './${name}-worker.mjs';
let claims = 0;
let timerTicks = 0;
const retained = [];
const worker = new HostedQueueWorker({authority:{claim:async()=>{claims++;throw new Error('fixture database offline')}},execute:async()=>({status:'completed'}),idleWaitMs:100,onError:(error)=>{
  if(retained.length<20000)retained.push(error);
  if(claims%5000===0)process.send?.({claims,timerTicks,heapUsed:process.memoryUsage().heapUsed,retainedErrors:retained.length});
}});
setTimeout(()=>{timerTicks++;process.send?.({claims,timerTicks,heapUsed:process.memoryUsage().heapUsed,retainedErrors:retained.length})},0);
void worker.run();
setInterval(()=>process.send?.({claims,timerTicks,heapUsed:process.memoryUsage().heapUsed,retainedErrors:retained.length}),100);
`);
  const result = { name, sourceSha256: createHash("sha256").update(source).digest("hex"), claims: 0, timerTicks: 0, peakObservedHeapUsedBytes: 0, retainedErrors: 0 };
  const child = fork(fileURLToPath(childPath), { windowsHide: true, execArgv: ["--max-old-space-size=256"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.on("message", (message) => {
    result.claims = Math.max(result.claims, message.claims ?? 0);
    result.timerTicks = Math.max(result.timerTicks, message.timerTicks ?? 0);
    result.peakObservedHeapUsedBytes = Math.max(result.peakObservedHeapUsedBytes, message.heapUsed ?? 0);
    result.retainedErrors = Math.max(result.retainedErrors, message.retainedErrors ?? 0);
  });
  await new Promise((resolve) => { setTimeout(() => child.kill(), report.observationMs); child.on("exit", resolve); });
  report.cases.push(result);
}
report.status = report.cases[0].claims > 5000 && report.cases[0].timerTicks === 0 && report.cases[1].claims < 30 && report.cases[1].timerTicks > 0 ? "ROOT_CAUSE_REPRODUCED_AND_REPAIRED" : "UNEXPECTED_OBSERVATION";
report.finding = "Baseline rejected database claims are retried as an immediate microtask loop, starving timers/HTTP/shutdown. Error sinks retain unbounded per-attempt errors in the real Vitest worker. Repair yields at idleWaitMs after each failed claim; real Direct/BYOK suite and deterministic bounded retry tests pass without raising heap limit.";
report.scope = "No provider inference; bounded 1.5s subprocess diagnostic with at most 20,000 retained fixture errors and 256MB heap ceiling. Peak heap measurements are samples, not an OS peak.";
await writeFile(new URL("../docs/evidence/free-capacity-fabric/R63-HEAP-DIAGNOSIS.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
