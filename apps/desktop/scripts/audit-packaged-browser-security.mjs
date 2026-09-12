#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

export const PACKAGED_BROWSER_SECURITY_VALID = "PACKAGED_BROWSER_SECURITY_VALID";

const REQUIRED_SETTINGS = [
  ["sandbox", /\bsandbox\s*:\s*true\b/],
  ["nodeIntegration", /\bnodeIntegration\s*:\s*false\b/],
  ["contextIsolation", /\bcontextIsolation\s*:\s*true\b/],
  ["webSecurity", /\bwebSecurity\s*:\s*true\b/],
];

const FORBIDDEN_BYPASSES = [
  ["sandbox:false", /\bsandbox\s*:\s*false\b/],
  ["nodeIntegration:true", /\bnodeIntegration\s*:\s*true\b/],
  ["contextIsolation:false", /\bcontextIsolation\s*:\s*false\b/],
  ["webSecurity:false", /\bwebSecurity\s*:\s*false\b/],
  ["--no-sandbox", /appendSwitch\s*\(\s*["']no-sandbox["']/],
  ["--disable-setuid-sandbox", /appendSwitch\s*\(\s*["']disable-setuid-sandbox["']/],
  // The per-process control-plane bearer must never be handed to a renderer as an argument.
  ["additionalArguments", /\badditionalArguments\s*:/],
];

// The local control plane is reachable only with a per-process bearer that the main process
// attaches to the primary window's own requests. Both halves must ship: the injection hook and
// the header the server checks.
const REQUIRED_CONTROL_PLANE_CONTRACT = [
  ["control-plane bearer injection hook", /webRequest\.onBeforeSendHeaders\s*\(/],
  ["control-plane bearer header", /X-CodeForge-Control-Token/],
];

// The shipped preload must not expose the bearer (or anything derived from process arguments).
const FORBIDDEN_PRELOAD_CONTENT = [
  ["controlPlaneToken", /controlPlaneToken/],
  ["control-plane-token argument", /control-plane-token/],
  ["process.argv", /process\.argv/],
];

export function validatePackagedBrowserSecuritySource(source, preloadSource) {
  if (typeof source !== "string" || source.length === 0) throw new Error("packaged main bundle is empty");
  for (const [name, pattern] of REQUIRED_SETTINGS) {
    if (!pattern.test(source)) throw new Error(`packaged BrowserWindow is missing required ${name} setting`);
  }
  for (const [name, pattern] of FORBIDDEN_BYPASSES) {
    if (pattern.test(source)) throw new Error(`packaged main bundle contains forbidden browser security bypass ${name}`);
  }
  for (const [name, pattern] of REQUIRED_CONTROL_PLANE_CONTRACT) {
    if (!pattern.test(source)) throw new Error(`packaged main bundle is missing required ${name}`);
  }
  if (preloadSource !== undefined) {
    if (typeof preloadSource !== "string" || preloadSource.length === 0) throw new Error("packaged preload bridge is empty");
    for (const [name, pattern] of FORBIDDEN_PRELOAD_CONTENT) {
      if (pattern.test(preloadSource)) throw new Error(`packaged preload bridge exposes forbidden ${name}`);
    }
  }
  return {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    controlPlaneBearerInjection: true,
    preloadBearerFree: preloadSource !== undefined,
  };
}

function resolveArchive(input) {
  const absolute = path.resolve(input);
  if (absolute.toLowerCase().endsWith(".asar")) return absolute;
  const candidates = [
    path.join(absolute, "win-unpacked", "resources", "app.asar"),
    path.join(absolute, "resources", "app.asar"),
    path.join(absolute, "app.asar"),
  ];
  const archive = candidates.find((candidate) => existsSync(candidate));
  if (!archive) throw new Error(`app.asar not found under ${absolute}`);
  return archive;
}

function readPackagedFile(archive, basename, description) {
  const candidates = [`apps/desktop/dist/${basename}`, `apps\\desktop\\dist\\${basename}`, `dist/${basename}`];
  for (const filename of candidates) {
    try {
      return extractFile(archive, filename).toString("utf8");
    } catch {
      // Try the other known electron-builder layout.
    }
  }
  throw new Error(`packaged ${description} is missing from app.asar`);
}

export function auditPackagedBrowserSecurity(input) {
  const archive = resolveArchive(input);
  const main = readPackagedFile(archive, "main.js", "main bundle");
  const preload = readPackagedFile(archive, "preload.cjs", "preload bridge");
  return { ...validatePackagedBrowserSecuritySource(main, preload), archive };
}

function main(argv) {
  if (argv.length !== 1) {
    console.error("usage: audit-packaged-browser-security.mjs <artifact-dir|app.asar>");
    process.exitCode = 2;
    return;
  }
  try {
    const result = auditPackagedBrowserSecurity(argv[0]);
    console.log(`${PACKAGED_BROWSER_SECURITY_VALID}=PASS`);
    console.log("sandbox=true");
    console.log("nodeIntegration=false");
    console.log("contextIsolation=true");
    console.log("webSecurity=true");
    console.log("controlPlaneBearerInjection=true");
    console.log("preloadBearerFree=true");
    console.log(`archive=${result.archive}`);
  } catch (error) {
    console.error(`${PACKAGED_BROWSER_SECURITY_VALID}=FAIL`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
