#!/usr/bin/env node
/**
 * Inspect the structured endpoint manifest embedded in an Electron app.asar.
 *
 * A release endpoint is build authority, not runtime user input. This gate reads the same
 * cloud-endpoints.json that the main process resolves and proves that the archive contains the
 * expected channel, a defined origin, and no loopback release endpoint.
 *
 * Examples:
 *   node audit-packaged-auth-endpoint.mjs release-r8-staging --channel staging --expected-url https://...
 *   node audit-packaged-auth-endpoint.mjs release-r8-smoke --channel development --mode smoke --expected-url http://127.0.0.1:3220
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

export const PACKAGED_AUTH_ENDPOINT_VALID = "PACKAGED_AUTH_ENDPOINT_VALID";

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("endpoint is not an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("endpoint must not contain credentials, query, or fragment");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function validatePackagedEndpointManifest(manifest, options) {
  const { channel, expectedUrl, mode = "production" } = options;
  if (!manifest || typeof manifest !== "object") throw new Error("embedded endpoint manifest is not an object");
  if (manifest.channel !== channel) throw new Error(`embedded channel '${manifest.channel}' does not match expected '${channel}'`);
  const rawEndpoint = manifest.endpoints?.[channel];
  if (typeof rawEndpoint !== "string" || rawEndpoint.trim() === "") throw new Error(`embedded ${channel} endpoint is missing`);

  const endpoint = normalizeUrl(rawEndpoint.trim());
  const expected = normalizeUrl(expectedUrl);
  const loopback = isLoopbackHostname(new URL(endpoint).hostname);
  const loopbackAllowed = mode === "development" || mode === "smoke";
  if (loopback && !loopbackAllowed) throw new Error(`${channel} endpoint must not be loopback`);
  if (channel !== "development" && new URL(endpoint).protocol !== "https:") throw new Error(`${channel} endpoint must use HTTPS`);
  if (endpoint !== expected) throw new Error(`embedded endpoint '${endpoint}' does not match expected build authority '${expected}'`);
  return { channel, endpoint, mode, loopbackAllowed };
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

function readEmbeddedManifest(archive) {
  const candidates = ["apps/desktop/cloud-endpoints.json", "apps\\desktop\\cloud-endpoints.json", "cloud-endpoints.json"];
  for (const filename of candidates) {
    try {
      return JSON.parse(extractFile(archive, filename).toString("utf8"));
    } catch {
      // Try the other known electron-builder layout.
    }
  }
  throw new Error("cloud-endpoints.json is missing from app.asar");
}

export function auditPackagedAuthEndpoint(input, options) {
  const archive = resolveArchive(input);
  const manifest = readEmbeddedManifest(archive);
  const result = validatePackagedEndpointManifest(manifest, options);
  const mainCandidates = ["apps/desktop/dist/main.js", "apps\\desktop\\dist\\main.js", "dist/main.js"];
  const mainBundle = mainCandidates.map((filename) => {
    try { return extractFile(archive, filename).toString("utf8"); } catch { return ""; }
  }).find((source) => source.includes("resolveCloudEndpoint"));
  if (!mainBundle) throw new Error("packaged main bundle does not contain the endpoint resolver");
  if (!mainBundle.includes("cloud-endpoints.json")) throw new Error("packaged main bundle does not resolve the stamped manifest");
  return { ...result, archive };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv) {
  const input = argv[0];
  const channel = argValue(argv, "--channel");
  const expectedUrl = argValue(argv, "--expected-url");
  const mode = argValue(argv, "--mode") ?? "production";
  if (!input || !channel || !expectedUrl || !["development", "staging", "production"].includes(channel) || !["production", "development", "smoke"].includes(mode)) {
    console.error("usage: audit-packaged-auth-endpoint.mjs <artifact-dir|app.asar> --channel <development|staging|production> --expected-url <origin> [--mode production|development|smoke]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = auditPackagedAuthEndpoint(input, { channel, expectedUrl, mode });
    console.log(`${PACKAGED_AUTH_ENDPOINT_VALID}=PASS`);
    console.log(`channel=${result.channel}`);
    console.log(`endpoint=${result.endpoint}`);
    console.log(`archive=${result.archive}`);
  } catch (error) {
    console.error(`${PACKAGED_AUTH_ENDPOINT_VALID}=FAIL`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
