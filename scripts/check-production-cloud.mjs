#!/usr/bin/env node
/**
 * Release gate for the public Cloud authority embedded in a production desktop artifact.
 * It checks the actual service contract instead of inferring compatibility from a source branch.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..");
const endpointManifestPath = resolve(repositoryRoot, "apps", "desktop", "cloud-endpoints.json");
export const REQUIRED_FEATURES = ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS"];
export const DEFAULT_MINIMUM_SERVER_VERSION = "0.4.0";

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function isAtLeastVersion(actual, minimum) {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

export function assertProductionCloudUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Production Cloud gate requires an absolute HTTPS endpoint.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  if (url.protocol !== "https:" || loopback) {
    throw new Error("Production Cloud gate refuses a non-HTTPS or loopback endpoint.");
  }
  if (hostname.includes("staging") || hostname.includes("dev")) {
    throw new Error("Production Cloud gate refuses a staging or development endpoint.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Production Cloud gate endpoint must not contain credentials, a query string, or a fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function failuresFor(result, requiredFeatures, minimumServerVersion) {
  const failures = [];
  const live = result.live.body;
  const ready = result.ready.body;
  const meta = result.meta.body;
  const models = result.models.body;

  if (!result.live.ok || live?.status !== "ok") failures.push("/health/live did not report status=ok.");
  if (!result.ready.ok || ready?.status !== "ready" || ready?.database !== "connected") failures.push("/health/ready did not confirm a connected database.");
  if (ready?.hostedInferenceReady !== true) failures.push("/health/ready did not confirm hosted inference readiness.");
  if (!Number.isInteger(ready?.availableFreeCount) || ready.availableFreeCount < 1) failures.push("/health/ready reported no eligible free models.");
  if (ready?.killSwitches?.hostedInferenceEnabled !== true) failures.push("Hosted inference kill switch is not enabled.");

  if (!result.meta.ok) failures.push("/v1/meta was not available.");
  if (typeof meta?.apiVersion !== "string" || !meta.apiVersion.startsWith("1.")) failures.push("/v1/meta did not report API major 1.");
  if (!isAtLeastVersion(meta?.serverVersion, minimumServerVersion)) {
    failures.push(`/v1/meta serverVersion must be at least ${minimumServerVersion}; received ${typeof meta?.serverVersion === "string" ? meta.serverVersion : "missing"}.`);
  }
  const advertisedFeatures = Array.isArray(meta?.features) ? meta.features.filter((feature) => typeof feature === "string") : [];
  const missingFeatures = requiredFeatures.filter((feature) => !advertisedFeatures.includes(feature));
  if (missingFeatures.length > 0) failures.push(`/v1/meta is missing required feature${missingFeatures.length === 1 ? "" : "s"}: ${missingFeatures.join(", ")}.`);

  if (!result.models.ok || !Array.isArray(models)) {
    failures.push("/v1/hosted/models was not available.");
  } else if (!models.some((model) => model?.isEligibleFree === true && model?.accessClass === "free")) {
    failures.push("/v1/hosted/models reported no verified-free model.");
  }

  return failures;
}

export function evaluateProductionCloud(result, options = {}) {
  const requiredFeatures = options.requiredFeatures ?? REQUIRED_FEATURES;
  const minimumServerVersion = options.minimumServerVersion ?? DEFAULT_MINIMUM_SERVER_VERSION;
  const failures = failuresFor(result, requiredFeatures, minimumServerVersion);
  return { ...result, passed: failures.length === 0, failures };
}

async function requestJson(url, path, fetchFn) {
  let response;
  try {
    response = await fetchFn(`${url}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { ok: false, status: 0, body: undefined, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: response.ok, status: response.status, body: await response.json() };
  } catch {
    return { ok: response.ok, status: response.status, body: undefined, error: "response was not valid JSON" };
  }
}

export async function probeProductionCloud(rawUrl, options = {}) {
  const url = assertProductionCloudUrl(rawUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const [live, ready, meta, models] = await Promise.all([
    requestJson(url, "/health/live", fetchFn),
    requestJson(url, "/health/ready", fetchFn),
    requestJson(url, "/v1/meta", fetchFn),
    requestJson(url, "/v1/hosted/models", fetchFn),
  ]);
  return evaluateProductionCloud({ url, live, ready, meta, models }, options);
}

function configuredProductionUrl() {
  const manifest = JSON.parse(readFileSync(endpointManifestPath, "utf8"));
  if (typeof manifest?.endpoints?.production !== "string") throw new Error("cloud-endpoints.json has no production Cloud endpoint.");
  return manifest.endpoints.production;
}

async function main() {
  const rawUrl = argumentValue("--url") ?? configuredProductionUrl();
  const minimumServerVersion = argumentValue("--minimum-server-version") ?? DEFAULT_MINIMUM_SERVER_VERSION;
  const result = await probeProductionCloud(rawUrl, { minimumServerVersion });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
