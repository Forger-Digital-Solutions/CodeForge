#!/usr/bin/env node
/**
 * Produce a distribution artifact with an explicit non-development Cloud authority.
 *
 * The committed manifest deliberately remains on development so source checkouts can use the
 * local runtime. This wrapper is the release boundary: it stamps an isolated production/staging
 * manifest for electron-builder, verifies the archive it produced, then restores the checkout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(here, "..");
const manifestPath = resolve(desktopDirectory, "cloud-endpoints.json");
const channels = new Set(["staging", "production"]);

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isLoopback(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
}

export function normalizeReleaseCloudUrl(rawUrl, channel) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`The ${channel} Cloud URL must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || isLoopback(parsed.hostname)) {
    throw new Error(`The ${channel} Cloud URL must be HTTPS and must not be loopback.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`The ${channel} Cloud URL must not include credentials, a query string, or a fragment.`);
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function createReleaseManifest(source, channel, urlOverride) {
  if (!channels.has(channel)) throw new Error("Release packaging supports only the staging or production channel.");
  if (!source || typeof source !== "object" || !source.endpoints || typeof source.endpoints !== "object") {
    throw new Error("cloud-endpoints.json is not a valid endpoint manifest.");
  }
  const configured = urlOverride ?? source.endpoints[channel];
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error(`No ${channel} Cloud URL is configured. Supply --url with the approved public HTTPS origin.`);
  }
  const endpoint = normalizeReleaseCloudUrl(configured.trim(), channel);
  return {
    ...source,
    channel,
    endpoints: { ...source.endpoints, [channel]: endpoint },
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopDirectory,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function runNpm(args) {
  if (process.platform === "win32") {
    // `call` is required when one Windows batch shim starts another: without it, cmd can return
    // before npm's nested electron-builder process has completed, racing the archive audit.
    run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `call npm.cmd ${args.join(" ")}`]);
    return;
  }
  run("npm", args);
}

function main() {
  const channel = argumentValue("--channel") ?? "production";
  const urlOverride = argumentValue("--url");
  const dryRun = process.argv.includes("--dry-run");
  const originalText = readFileSync(manifestPath, "utf8");
  const source = JSON.parse(originalText);
  const stamped = createReleaseManifest(source, channel, urlOverride);

  if (dryRun) {
    console.log(JSON.stringify({ channel: stamped.channel, endpoint: stamped.endpoints[stamped.channel] }));
    return;
  }

  writeFileSync(manifestPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  try {
    runNpm(["run", "dist:builder"]);
    run(process.execPath, ["scripts/audit-packaged-auth-endpoint.mjs", "release", "--channel", channel, "--expected-url", stamped.endpoints[channel]]);
  } finally {
    writeFileSync(manifestPath, originalText, "utf8");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
