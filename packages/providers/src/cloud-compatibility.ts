/**
 * Contract the desktop requires from a CodeForge Cloud endpoint. Package versions may evolve
 * independently; the API major version and advertised capabilities are the compatibility boundary.
 */
export const REQUIRED_CLOUD_API_MAJOR = 1;
export const REQUIRED_CLOUD_FEATURES = ["HOSTED_FREE", "DYNAMIC_MODELS", "HOSTED_TOOLS"] as const;

export interface CloudApiMetadata {
  apiVersion?: unknown;
  serverVersion?: unknown;
  features?: unknown;
}

export interface CloudCompatibilityResult {
  compatible: boolean;
  message: string;
  apiVersion?: string;
  serverVersion?: string;
  features: string[];
}

function majorVersion(value: string): number | undefined {
  const match = /^(\d+)\./.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

export function evaluateCloudCompatibility(metadata: CloudApiMetadata): CloudCompatibilityResult {
  const apiVersion = typeof metadata.apiVersion === "string" ? metadata.apiVersion : undefined;
  const serverVersion = typeof metadata.serverVersion === "string" ? metadata.serverVersion : undefined;
  const features = Array.isArray(metadata.features)
    ? metadata.features.filter((feature): feature is string => typeof feature === "string")
    : [];

  if (!apiVersion || majorVersion(apiVersion) !== REQUIRED_CLOUD_API_MAJOR) {
    return {
      compatible: false,
      message: `Cloud API compatibility requires apiVersion ${REQUIRED_CLOUD_API_MAJOR}.x; received ${apiVersion ?? "missing"}.`,
      apiVersion,
      serverVersion,
      features,
    };
  }

  const missing = REQUIRED_CLOUD_FEATURES.filter((feature) => !features.includes(feature));
  if (missing.length > 0) {
    return {
      compatible: false,
      message: `Cloud API is missing required feature${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      apiVersion,
      serverVersion,
      features,
    };
  }

  return {
    compatible: true,
    message: `Cloud API ${apiVersion}${serverVersion ? ` (server ${serverVersion})` : ""} is compatible.`,
    apiVersion,
    serverVersion,
    features,
  };
}

export async function checkCloudCompatibility(
  cloudApiUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<CloudCompatibilityResult> {
  let response: Response;
  try {
    response = await fetchFn(`${cloudApiUrl.replace(/\/$/, "")}/v1/meta`);
  } catch (error) {
    return {
      compatible: false,
      message: `Cloud compatibility metadata could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      features: [],
    };
  }

  if (!response.ok) {
    return { compatible: false, message: `Cloud compatibility metadata returned HTTP ${response.status}.`, features: [] };
  }

  try {
    return evaluateCloudCompatibility((await response.json()) as CloudApiMetadata);
  } catch {
    return { compatible: false, message: "Cloud compatibility metadata was not valid JSON.", features: [] };
  }
}

export class CloudCompatibilityError extends Error {
  constructor(result: CloudCompatibilityResult) {
    super(`CodeForge Cloud needs an update before this desktop release can connect. ${result.message}`);
    this.name = "CloudCompatibilityError";
  }
}
