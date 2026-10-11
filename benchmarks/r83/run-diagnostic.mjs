import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { UnrealAdapter } from "../../packages/forge-aaa/dist/index.js";

const evidence = path.resolve("docs/evidence/r83-forgeaaa-autonomous-multiroom");
const stamp = Date.now();
const recovery = path.join(evidence, "continuation-start");
await mkdir(recovery, { recursive: true });
for (const file of ["packages/forge-aaa/src/building-revision.ts", "benchmarks/r83/r83-assemble-live.mjs", "benchmarks/r83/r83-assets-live.mjs", ".scratch/r83-migration-receipt.json", ".scratch/r83-rollback-receipt.json"]) {
  await copyFile(file, path.join(recovery, path.basename(file) + ".txt"));
}
await writeFile(path.join(recovery,"git-state.txt"), execFileSync("git", ["-c","core.fsmonitor=false","status","--short"], {encoding:"utf8"}) + execFileSync("git", ["rev-parse","HEAD"], {encoding:"utf8"}));
const adapter = new UnrealAdapter();
const install = (await adapter.detect()).installs.find(i => i.version.major === 4 && i.version.minor === 27);
const logPath = path.resolve(`.scratch/native-diagnostic-${stamp}.log`);
const result = await adapter.runPythonScript({ projectPath: path.resolve(".scratch/r83pilot/DeadTrailsWest.uproject"), scriptPath: path.resolve("benchmarks/r83/native-placement-diagnostic.py"), host:"editor", install, logPath, timeoutMs:120000 });
const log = await readFile(logPath,"utf8");
const lines = log.split(/\r?\n/).filter(line => line.includes("FORGEAAA_REPORT:"));
const reports = lines.map(line => JSON.parse(line.slice(line.indexOf("FORGEAAA_REPORT:")+16)));
await writeFile(path.join(evidence,`native-diagnostic-${stamp}.json`), JSON.stringify({exitCode:result.exitCode,timedOut:result.timedOut,logPath,reports},null,2));
console.log(JSON.stringify({exitCode:result.exitCode,timedOut:result.timedOut,reports},null,2));
