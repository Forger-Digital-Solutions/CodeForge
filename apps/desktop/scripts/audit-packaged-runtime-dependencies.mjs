import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
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
if (!existsSync(asarPath)) throw new Error(`Packaged archive not found: ${asarPath}`);

const entries = listPackage(asarPath);
const archivePath = (entry) => entry.replace(/^\\+/, "");
const normalizedPath = (entry) => archivePath(entry).replaceAll("\\", "/");
const externalPackageName = (specifier) => {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
};
const shipped = new Set(
  entries
    .map(normalizedPath)
    .filter((entry) => entry.startsWith("node_modules/"))
    .map((entry) => entry.split("/").slice(0, entry.startsWith("node_modules/@") ? 3 : 2).join("/")),
);
const ignored = new Set(["electron", "pg-native", "pg-cloudflare"]);
for (const builtin of builtinModules) {
  ignored.add(builtin);
  ignored.add(builtin.replace(/^node:/, ""));
}
const imports = new Map();
const runtimeModules = entries.filter((entry) => {
  const normalized = normalizedPath(entry);
  return normalized.endsWith(".js")
    && !normalized.includes("/test/")
    && !normalized.endsWith("/test.js")
    && !normalized.endsWith(".test.js")
    && (
      normalized.startsWith("apps/desktop/dist/")
      || normalized.includes("node_modules/@codeforge/")
      || normalized.includes("node_modules/pg/")
      || normalized.includes("node_modules/pg-")
      || normalized.includes("node_modules/postgres-")
      || normalized.includes("node_modules/pgpass/")
      || normalized.includes("node_modules/xtend/")
    )
    && !normalized.includes("node_modules/@codeforge/ui/");
});

for (const entry of runtimeModules) {
  const source = extractFile(asarPath, archivePath(entry)).toString("utf8");
  for (const match of source.matchAll(/(?:from|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier || specifier.includes("\${") || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("@codeforge/")) continue;
    const packageName = externalPackageName(specifier);
    if (ignored.has(packageName)) continue;
    const locations = imports.get(packageName) ?? [];
    locations.push(entry);
    imports.set(packageName, locations);
  }
}

const missing = [...imports.entries()]
  .filter(([name]) => !shipped.has(`node_modules/${name}`))
  .map(([name, locations]) => ({ name, locations: [...new Set(locations)].sort() }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (missing.length > 0) {
  console.error("PACKAGED_RUNTIME_DEPENDENCY_GRAPH_FAIL");
  for (const dependency of missing) console.error(`Missing ${dependency.name}; imported by ${dependency.locations.join(", ")}`);
  process.exit(1);
}

console.log("PACKAGED_RUNTIME_DEPENDENCY_GRAPH_PASS");
console.log(`Scanned ${runtimeModules.length} packaged runtime modules and ${imports.size} external packages.`);
