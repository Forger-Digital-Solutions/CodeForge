#!/usr/bin/env node
/**
 * Stamp the desktop build channel and Cloud endpoint into `cloud-endpoints.json` before packaging.
 *
 *   npm run build:channel --workspace=codeforge-desktop -- --channel staging --url https://staging.example.com
 *
 * The manifest is the ONLY place a packaged build learns where the Cloud is. A packaged
 * staging/production build ignores CODEFORGE_CLOUD_URL entirely, so this script is how a release is
 * pointed at a deployment — deliberately an explicit build step, not an environment variable that
 * could differ between the machine that built the installer and the machine that runs it.
 *
 * The committed default is the development channel, so a normal developer checkout keeps working.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "..", "cloud-endpoints.json");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const channel = argValue("--channel") ?? process.env.CODEFORGE_BUILD_CHANNEL;
const url = argValue("--url") ?? process.env.CODEFORGE_BUILD_CLOUD_URL;

if (!channel || !["development", "staging", "production"].includes(channel)) {
  console.error("usage: set-build-channel.mjs --channel <development|staging|production> [--url https://...]");
  process.exit(2);
}

if (channel !== "development") {
  if (!url) {
    console.error(`A '${channel}' build requires --url (the public HTTPS Cloud origin).`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`--url is not a valid absolute URL: ${url}`);
    process.exit(2);
  }
  if (parsed.protocol !== "https:") {
    console.error(`A '${channel}' build requires an HTTPS Cloud URL (got ${parsed.protocol}).`);
    process.exit(2);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    console.error("--url must not contain credentials, a query string, or a fragment.");
    process.exit(2);
  }
}

const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
const endpoints = { ...(existing.endpoints ?? {}) };
if (url) {
  const normalized = new URL(url);
  endpoints[channel] = `${normalized.protocol}//${normalized.host}${normalized.pathname.replace(/\/+$/, "")}`;
}

const next = { ...existing, channel, endpoints };
writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

console.log(`build channel set to '${channel}'${endpoints[channel] ? ` -> ${endpoints[channel]}` : ""}`);
console.log(`manifest: ${manifestPath}`);
