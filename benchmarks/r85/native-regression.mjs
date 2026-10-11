import { mkdir, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const original = path.resolve("../r84-free-cloud-autonomy-certification/.scratch/r84pilot");
const pilot = path.resolve(".scratch/r85pilot");
const directory = "docs/evidence/r85-free-onboarding-autonomy-and-forgeaaa-review/native";
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function manifest(root, relative = "") {
  const entries = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push(...await manifest(root, file));
    else if (entry.isFile()) entries.push({ file, sha256: await hash(path.join(root, file)) });
    else throw new Error("Unexpected pilot symlink");
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), original, pilot, status: "RUNNING", campaigns: [] };
const persist = () => writeFile(`${directory}/preservation.json`, JSON.stringify(report, null, 2));
try {
  await mkdir(path.dirname(pilot), { recursive: true });
  await mkdir(pilot, { recursive: false });
  report.before = await manifest(path.join(original, "Content"));
  for (const part of ["Binaries", "Config", "Content", "Plugins", "Source", "DeadTrailsWest.uproject"]) await cp(path.join(original, part), path.join(pilot, part), { recursive: true, force: false, errorOnExist: true });
  await persist();
  for (const file of ["migration-fault-campaign.mjs", "persistence-upgrade-live.mjs"]) {
    const before = Date.now();
    await import(`./native/${file}`);
    report.campaigns.push({ file, elapsedMs: Date.now() - before, exitCode: process.exitCode ?? 0 });
    await persist();
    if (process.exitCode) break;
  }
  report.after = await manifest(path.join(original, "Content"));
  if (JSON.stringify(report.before) !== JSON.stringify(report.after)) throw new Error("Original pilot content changed during regression");
  report.originalContentPreserved = true;
  report.status = process.exitCode ? "BLOCKED" : "VERIFIED";
} catch (error) { report.status = "BLOCKED"; report.error = String(error); process.exitCode = 1; }
report.finishedAt = new Date().toISOString(); await persist();
console.log(JSON.stringify({ status: report.status, error: report.error, originalContentPreserved: report.originalContentPreserved }));
