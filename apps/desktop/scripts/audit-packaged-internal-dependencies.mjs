import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function newestMtime(dir, ext) {
  let newest = 0;
  for (const f of walk(dir)) if (f.endsWith(ext)) newest = Math.max(newest, statSync(f).mtimeMs);
  return newest;
}

function resolveArchive(input) {
  const absolute = resolve(input);
  if (absolute.toLowerCase().endsWith(".asar")) return absolute;
  const candidates = [
    resolve(absolute, "win-unpacked", "resources", "app.asar"),
    resolve(absolute, "resources", "app.asar"),
    resolve(absolute, "app.asar"),
  ];
  return candidates.find((c) => existsSync(c)) ?? absolute;
}

const target = process.argv[2] ?? process.env.CODEFORGE_AUDIT_ASAR ?? "release/win-unpacked/resources/app.asar";
const asarPath = resolveArchive(target);

if (!existsSync(asarPath)) {
  throw new Error(`Packaged archive not found: ${asarPath}`);
}

const entries = listPackage(asarPath);
const archivePath = (entry) => entry.replace(/^\\+/, "");
const normalizedPath = (entry) => archivePath(entry).replaceAll("\\", "/");
const packageNameFromEntry = (entry) => /node_modules\/@codeforge\/([^/]+)\/package\.json$/i.exec(normalizedPath(entry))?.[1];
const shipped = new Set(entries.map(packageNameFromEntry).filter(Boolean));
const runtimeModules = entries.filter((entry) =>
  entry.endsWith(".js")
  && (normalizedPath(entry) === "apps/desktop/dist/main.js" || normalizedPath(entry).includes("node_modules/@codeforge/")),
);
const imports = new Map();

for (const entry of runtimeModules) {
  const source = extractFile(asarPath, archivePath(entry)).toString("utf8");
  for (const match of source.matchAll(/@codeforge\/([a-z0-9-]+)/gi)) {
    const name = match[1].toLowerCase();
    const locations = imports.get(name) ?? [];
    locations.push(entry);
    imports.set(name, locations);
  }
}

const unresolved = [...imports.entries()]
  .filter(([name]) => !shipped.has(name))
  .map(([name, locations]) => ({ name, locations: [...new Set(locations)].sort() }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (unresolved.length > 0) {
  console.error("PACKAGED_INTERNAL_DEPENDENCY_GRAPH_FAIL");
  for (const dependency of unresolved) {
    console.error(`Missing @codeforge/${dependency.name}; imported by ${dependency.locations.join(", ")}`);
  }
  process.exit(1);
}

// Freshness: the archive ships packages/<name>/dist verbatim. tsc -b marks a built project via
// dist/tsconfig.tsbuildinfo, so that file — not any single .js — is the "dist is current" marker.
// A project whose src is newer than its build marker ships code the current source does not
// produce: a silent stale-product bug that unit tests can never see because they run from src.
const staleDist = [];
for (const name of shipped) {
  const pkgDir = resolve(repoRoot, "packages", name);
  const srcMtime = newestMtime(resolve(pkgDir, "src"), ".ts");
  const marker = resolve(pkgDir, "dist", "tsconfig.tsbuildinfo");
  const distMtime = existsSync(marker) ? statSync(marker).mtimeMs : newestMtime(resolve(pkgDir, "dist"), ".js");
  if (srcMtime > 0 && (distMtime === 0 || srcMtime > distMtime)) staleDist.push(name);
}
if (staleDist.length > 0) {
  console.error("PACKAGED_INTERNAL_DEPENDENCY_STALE_DIST");
  for (const name of staleDist) console.error(`@codeforge/${name}: src is newer than dist — run npm run build before packaging`);
  process.exit(1);
}

// Content: every @codeforge dist file inside the archive must equal the repo's built output byte
// for byte. A drifted copy means the installed product is not the code that was reviewed.
const drifted = [];
for (const entry of entries) {
  const match = /node_modules\/@codeforge\/([^/]+)\/dist\/(.+\.js)$/i.exec(normalizedPath(entry));
  if (!match) continue;
  const diskPath = resolve(repoRoot, "packages", match[1], "dist", match[2]);
  if (!existsSync(diskPath) || !readFileSync(diskPath).equals(extractFile(asarPath, archivePath(entry)))) {
    drifted.push(normalizedPath(entry));
  }
}
if (drifted.length > 0) {
  console.error("PACKAGED_INTERNAL_DEPENDENCY_DIST_DRIFT");
  for (const entry of drifted.slice(0, 40)) console.error(`${entry} differs from the repo dist`);
  if (drifted.length > 40) console.error(`…and ${drifted.length - 40} more`);
  process.exit(1);
}

console.log("PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS");
console.log(`Shipped internal packages: ${[...shipped].sort().join(", ")}`);
