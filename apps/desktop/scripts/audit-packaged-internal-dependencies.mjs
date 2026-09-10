import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractFile, listPackage } from "@electron/asar";

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

console.log("PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS");
console.log(`Shipped internal packages: ${[...shipped].sort().join(", ")}`);
