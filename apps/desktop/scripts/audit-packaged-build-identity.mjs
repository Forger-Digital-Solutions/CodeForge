#!/usr/bin/env node
/**
 * Prove the packaged archive was built from THIS checkout and that its two halves agree.
 *
 * The main process ships `apps/desktop/dist/build-identity.json`; the renderer bundle inlines the
 * same stamp (the `virtual:codeforge-build-identity` module). Both must name the current HEAD commit and carry the same
 * build time. A renderer bundle that is older than the main stamp — the failure R16 caught, where
 * an installer shipped an interface built before the sources changed — fails here instead of in
 * a user's hands. A dirty working tree is reported (and refused with --require-clean).
 *
 *   node scripts/audit-packaged-build-identity.mjs [release|path/to/app.asar] [--require-clean]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

export const PACKAGED_BUILD_IDENTITY_VALID = "PACKAGED_BUILD_IDENTITY_VALID";
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(here, "..");
const repositoryRoot = path.resolve(desktopDirectory, "..", "..");

function resolveArchive(input) {
  const absolute = path.resolve(desktopDirectory, input);
  if (absolute.toLowerCase().endsWith(".asar")) return absolute;
  const candidates = [
    path.join(absolute, "win-unpacked", "resources", "app.asar"),
    path.join(absolute, "resources", "app.asar"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`no app.asar under ${absolute}`);
  return found;
}

/**
 * Every build stamp inlined in a renderer bundle. The minifier may quote the JSON string with `"`
 * or `\"`, so the source is normalised before the JSON objects are parsed.
 */
export function extractRendererStamps(bundleSource) {
  const normalised = bundleSource.replace(/\\"/g, '"');
  const stamps = [];
  const marker = '{"version":"';
  let from = 0;
  for (;;) {
    const start = normalised.indexOf(marker, from);
    if (start === -1) break;
    const end = normalised.indexOf("}", start);
    if (end === -1) break;
    from = end + 1;
    try {
      const parsed = JSON.parse(normalised.slice(start, end + 1));
      if (typeof parsed.commit === "string" && typeof parsed.builtAt === "string") stamps.push({ commit: parsed.commit, dirty: parsed.dirty === true, builtAt: parsed.builtAt });
    } catch {
      // not a stamp
    }
  }
  return stamps;
}

export function validatePackagedBuildIdentity({ stamp, rendererStamps, headCommit, requireClean }) {
  if (!stamp || typeof stamp.commit !== "string" || typeof stamp.builtAt !== "string") throw new Error("main build-identity.json is missing or malformed");
  if (headCommit && stamp.commit !== headCommit) throw new Error(`archive was built from ${stamp.commit.slice(0, 12)}, not the current HEAD ${headCommit.slice(0, 12)}`);
  if (rendererStamps.length === 0) throw new Error("renderer bundle carries no build stamp (stale or unstamped bundle)");
  for (const renderer of rendererStamps) {
    if (renderer.commit !== stamp.commit) throw new Error(`renderer bundle was built from ${String(renderer.commit).slice(0, 12)}, main from ${stamp.commit.slice(0, 12)}`);
    if (renderer.builtAt !== stamp.builtAt) throw new Error(`renderer bundle stamp (${renderer.builtAt}) differs from the main stamp (${stamp.builtAt}) — stale renderer build`);
  }
  if (requireClean && stamp.dirty) throw new Error("archive was built from a dirty working tree; a release must be built from committed sources");
  return { commit: stamp.commit, builtAt: stamp.builtAt, dirty: stamp.dirty === true };
}

function main() {
  const args = process.argv.slice(2);
  const requireClean = args.includes("--require-clean");
  const target = args.find((a) => !a.startsWith("--")) ?? "release";
  const archive = resolveArchive(target);
  // @electron/asar addresses entries with the platform separator on Windows; try both spellings.
  const readEntry = (posixPath) => {
    for (const candidate of [posixPath, posixPath.replace(/\//g, "\\")]) {
      try { return extractFile(archive, candidate).toString("utf8"); } catch { /* try the other layout */ }
    }
    throw new Error(`"${posixPath}" was not found in this archive`);
  };
  const stamp = JSON.parse(readEntry("apps/desktop/dist/build-identity.json"));
  const rendererStamps = [];
  for (const entry of listPackage(archive)) {
    const normalized = entry.replace(/\\/g, "/").replace(/^\//, "");
    if (!/apps\/desktop\/dist\/renderer\/assets\/index-[^/]+\.js$/.test(normalized)) continue;
    const source = readEntry(normalized);
    for (const stampJson of extractRendererStamps(source)) rendererStamps.push(stampJson);
  }
  let headCommit = "";
  try { headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(); } catch {}
  const result = validatePackagedBuildIdentity({ stamp, rendererStamps, headCommit, requireClean });
  console.log(`${PACKAGED_BUILD_IDENTITY_VALID}=PASS`);
  console.log(`commit=${result.commit}`);
  console.log(`builtAt=${result.builtAt}`);
  console.log(`dirty=${result.dirty}`);
  console.log(`archive=${archive}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`${PACKAGED_BUILD_IDENTITY_VALID}=FAIL`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
