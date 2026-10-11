/**
 * R83 pilot initializer. Creates .scratch/r83pilot — an isolated copy of the R82
 * project skeleton + ForgeGameplay plugin. Refuses to overwrite an existing pilot.
 * Must be run from the r83 worktree root.
 */
import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".scratch");
const pilot = path.join(root, "r83pilot");
try {
  await access(path.join(pilot, "DeadTrailsWest.uproject"));
  throw new Error("R83 pilot already exists at " + pilot + "; inspect it instead of overwriting.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await mkdir(root, { recursive: true });
// Copy project skeleton and plugin from r82 benchmarks (versioned source)
await cp("benchmarks/r82/project", pilot, { recursive: true });
await cp("benchmarks/r83/forge-gameplay-plugin", path.join(pilot, "Plugins/ForgeGameplay"), { recursive: true });
// Use workspace-local DDC to avoid polluting the machine's shared cache
const ddc = path.join(root, "r83ddc").replaceAll("\\", "/");
await mkdir(ddc, { recursive: true });
const local = `Local=(Type=FileSystem,ReadOnly=false,Clean=false,Flush=false,PurgeTransient=true,DeleteUnused=true,UnusedFileAge=34,FoldersToClean=-1,Path="${ddc}")`;
await writeFile(
  path.join(pilot, "Config/DefaultEngine.ini"),
  `[DerivedDataBackendGraph]\n${local}\n[InstalledDerivedDataBackendGraph]\n${local}\n[/Script/Engine.RendererSettings]\nr.DefaultFeature.AutoExposure=False\nr.DefaultFeature.MotionBlur=False\nr.DefaultFeature.Bloom=False\n`
);
// Mark this as an R83-specific isolated pilot
const descriptor = JSON.parse(await readFile(path.join(pilot, "DeadTrailsWest.uproject"), "utf8"));
descriptor.Description = "ForgeAAA R83 isolated two-room connected building test fixture";
await writeFile(path.join(pilot, "DeadTrailsWest.uproject"), JSON.stringify(descriptor, null, 2));
console.log("R83 pilot initialized at:", pilot);
