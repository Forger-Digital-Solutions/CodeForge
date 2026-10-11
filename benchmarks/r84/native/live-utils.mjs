import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnrealAdapter } from "../../../packages/forge-aaa/dist/index.js";

export const scratch = path.resolve(".scratch");
export const pilot = path.join(scratch,"r84pilot");
export const project = path.join(pilot,"DeadTrailsWest.uproject");
export const evidenceDir = path.resolve("docs/evidence/r84-free-cloud-autonomy-certification/native");
export const unreal = new UnrealAdapter();
export const install = (await unreal.detect()).installs.find(i=>i.version.major===4&&i.version.minor===27);
if (!install) throw new Error("UE4.27 unavailable");
export async function python(name, script) {
  const scriptPath = path.join(scratch,name+".py");
  const logPath = path.join(scratch,name+".log");
  await writeFile(scriptPath,script,"utf8");
  const result = await unreal.runPythonScript({projectPath:project,scriptPath,host:"editor",install,logPath,timeoutMs:180000});
  const log = await readFile(logPath,"utf8");
  const reports = log.split(/\r?\n/).filter(l=>/FORGEAAA_(?:MIGRATION_)?REPORT:/.test(l)).map(l=>JSON.parse(l.slice(l.indexOf("REPORT:")+7)));
  const report = reports.at(-1);
  return {exitCode:result.exitCode,timedOut:result.timedOut,ok:result.ok,logPath,report,reports};
}
