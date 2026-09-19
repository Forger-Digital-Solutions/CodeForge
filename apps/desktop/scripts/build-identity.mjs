#!/usr/bin/env node
/**
 * Stamp the build with its source identity: writes `dist/build-identity.json` (read by the main
 * process for About/diagnostics and inlined into the renderer by the Vite build) and prints it.
 *
 *   node scripts/build-identity.mjs            → writes dist/build-identity.json, prints it
 *   node scripts/build-identity.mjs --print    → prints only (no write)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeBuildIdentity, desktopDirectory } from "./build-identity-lib.mjs";

const identity = computeBuildIdentity();
if (!process.argv.includes("--print")) {
  const outDir = resolve(desktopDirectory, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(identity)}\n`);
