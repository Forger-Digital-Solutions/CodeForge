import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { python, evidenceDir } from "./live-utils.mjs";
export async function latestAssembly() {
  const names = (await readdir(evidenceDir)).filter(f=>/^r83-assemble-\d+\.json$/.test(f)).sort().reverse();
  for (const name of names) {
    const report = JSON.parse(await readFile(path.join(evidenceDir,name),"utf8"));
    if (report.summary?.migrationCommitted && report.summary.level.includes("Strict")) return {file:name,report};
  }
  throw new Error("strict migration evidence missing");
}
export async function configure(level) {
  let source = await readFile("benchmarks/r82/configure-room.py","utf8");
  source = source.replace('LEVEL = "/Game/ForgeAAA/Maps/FAAA_R82InteriorV2"', `LEVEL = ${JSON.stringify(level)}`)
    .replace('assets += [', 'assets += list(eal.list_assets("/Game/ForgeAAA/R83",True,False))\n    assets += [')
    .replace('"forge-r82:"','"forge-r83:"').replace('"R82_"','"R83_"')
    .replace('unreal.Rotator(*rotation)','unreal.Rotator(pitch=rotation[0],yaw=rotation[1],roll=rotation[2])')
    .replace('for x in (0,1000):','for x in (0,580):');
  const result = await python(`r83-configure-${Date.now()}`,source);
  await writeFile(path.join(evidenceDir,`gameplay-configuration-${Date.now()}.json`),JSON.stringify({level,...result},null,2));
  if (!result.ok || result.report?.ok !== true) throw new Error("gameplay level configuration failed: "+JSON.stringify(result.report));
  return result;
}
if (process.argv[1]?.endsWith("configure-gameplay.mjs")) {
  const {report} = await latestAssembly();
  console.log(JSON.stringify(await configure(report.summary.level)));
}
