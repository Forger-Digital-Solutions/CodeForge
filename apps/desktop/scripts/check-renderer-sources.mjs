#!/usr/bin/env node
/**
 * Refuse to bundle a renderer whose source tree contains emitted JavaScript.
 *
 * Renderer imports use `.js` specifiers (`./AuthScreen.js`) that Vite maps onto the `.tsx`
 * sources. If a stray `AuthScreen.js` sits beside `AuthScreen.tsx` — the output of running
 * `tsc` against the renderer project, or of any editor build task — Vite bundles that file
 * instead, and every later build silently ships whatever the sources were when it was emitted.
 * R16 caught an installer produced exactly that way. This guard runs before every Vite build.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(here, "..");
const repositoryRoot = resolve(desktopDirectory, "..", "..");
const roots = [
  resolve(desktopDirectory, "src"),
  resolve(repositoryRoot, "packages", "ui", "src"),
];
const ALLOWED = new Set(["preload.cjs"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(js|jsx|mjs|js\.map|d\.ts\.map)$/.test(entry) && !ALLOWED.has(entry)) out.push(full);
    if (entry.endsWith(".d.ts") && !/^(electron|virtual-modules)\.d\.ts$/.test(entry)) out.push(full);
  }
}

const offenders = [];
for (const root of roots) walk(root, offenders);
if (offenders.length > 0) {
  console.error("RENDERER_SOURCE_TREE=FAIL");
  console.error("Emitted JavaScript/declaration files shadow the TypeScript sources Vite must bundle:");
  for (const file of offenders) console.error(`  ${relative(repositoryRoot, file)}`);
  console.error("Delete them (they are build output, never sources). The renderer tsconfig is noEmit; do not run tsc against it with emit enabled.");
  process.exit(1);
}
console.log(`RENDERER_SOURCE_TREE=PASS (${roots.map((r) => relative(repositoryRoot, r)).join(", ")})`);
