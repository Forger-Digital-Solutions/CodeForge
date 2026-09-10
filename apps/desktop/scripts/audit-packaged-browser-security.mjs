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
];

export function validatePackagedBrowserSecuritySource(source) {
  if (typeof source !== "string" || source.length === 0) throw new Error("packaged main bundle is empty");
  for (const [name, pattern] of REQUIRED_SETTINGS) {
    if (!pattern.test(source)) throw new Error(`packaged BrowserWindow is missing required ${name} setting`);
  }
  for (const [name, pattern] of FORBIDDEN_BYPASSES) {
    if (pattern.test(source)) throw new Error(`packaged main bundle contains forbidden browser security bypass ${name}`);
  }
  return {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
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

function readPackagedMain(archive) {
  const candidates = ["apps/desktop/dist/main.js", "apps\\desktop\\dist\\main.js", "dist/main.js"];
  for (const filename of candidates) {
    try {
      return extractFile(archive, filename).toString("utf8");
    } catch {
      // Try the other known electron-builder layout.
    }
  }
  throw new Error("packaged main bundle is missing from app.asar");
}

export function auditPackagedBrowserSecurity(input) {
  const archive = resolveArchive(input);
  return { ...validatePackagedBrowserSecuritySource(readPackagedMain(archive)), archive };
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
    console.log(`archive=${result.archive}`);
  } catch (error) {
    console.error(`${PACKAGED_BROWSER_SECURITY_VALID}=FAIL`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
