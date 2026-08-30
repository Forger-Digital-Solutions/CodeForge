/**
 * WHERE THE DESKTOP SENDS PRIVILEGED CLOUD TRAFFIC.
 *
 * The Cloud base URL is not a secret, but it IS authoritative: it decides which server sees the
 * user's OAuth flow, holds their session, and reports their balance. If an untrusted surface could
 * change it, an attacker could point authentication and accounting at a server they control. So the
 * endpoint is resolved once, in the main process, from BUILD configuration — never from the
 * renderer, never from a document, never from a user-typed field.
 *
 * Three channels, with deliberately different rules:
 *
 *   production — endpoint comes from the build manifest and must be HTTPS. No override, ever.
 *   staging    — same, with its own HTTPS endpoint. No override in a packaged build.
 *   development— defaults to loopback and MAY be overridden by an environment variable, because a
 *                developer running from source needs to point at their own Cloud.
 *
 * The override is gated on the build channel AND on the app not being packaged, so it is impossible
 * for a release build to ship with the override path live: a packaged production app ignores the
 * environment entirely.
 */
export type CloudBuildChannel = "development" | "staging" | "production";

export interface CloudEndpointManifest {
  /** The channel this build was produced for. */
  channel: CloudBuildChannel;
  /** Public Cloud origin per channel. Staging/production must be HTTPS; development is loopback. */
  endpoints: Partial<Record<CloudBuildChannel, string>>;
}

export interface ResolveCloudEndpointInputs {
  manifest: CloudEndpointManifest;
  /** Process environment. Consulted only when an override is permitted. */
  env?: Record<string, string | undefined>;
  /** Electron's `app.isPackaged`. A packaged build never honors an override. */
  isPackaged: boolean;
}

export interface ResolvedCloudEndpoint {
  url: string;
  channel: CloudBuildChannel;
  /** True when the value came from the environment rather than the build manifest. */
  overridden: boolean;
  /** Why the override was or was not permitted — surfaced in startup logs for operators. */
  overrideReason: string;
}

export const CLOUD_ENDPOINT_OVERRIDE_VARS = ["CODEFORGE_CLOUD_URL", "CODEFORGE_CLOUD_API_URL"] as const;

export const DEFAULT_DEVELOPMENT_CLOUD_URL = "http://127.0.0.1:3220";

export class CloudEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudEndpointError";
  }
}

/**
 * Validate a Cloud origin for a given channel.
 *
 * Staging and production require HTTPS: these channels carry real sessions, and plaintext would
 * expose the bearer token on every request. Development additionally permits plain-http loopback,
 * which cannot leave the machine.
 */
export function assertValidCloudUrl(rawUrl: string, channel: CloudBuildChannel): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CloudEndpointError(`CodeForge Cloud URL is not a valid absolute URL: '${rawUrl}'`);
  }

  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";

  if (url.protocol === "https:") {
    // Always acceptable.
  } else if (url.protocol === "http:" && channel === "development" && isLoopback) {
    // Development against a local Cloud.
  } else {
    throw new CloudEndpointError(
      `CodeForge Cloud URL must use HTTPS on the '${channel}' channel (plain http is permitted only for loopback development): '${rawUrl}'`,
    );
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new CloudEndpointError("CodeForge Cloud URL must not contain credentials, a query string, or a fragment");
  }

  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Resolve the one Cloud endpoint this process will use. Called once, at startup, in the main process.
 *
 * @throws {CloudEndpointError} when a staging/production build has no endpoint configured. Failing
 *   closed is essential here: falling back to loopback would silently send a real user's
 *   authentication and accounting traffic to whatever happens to be listening on their machine.
 */
export function resolveCloudEndpoint(inputs: ResolveCloudEndpointInputs): ResolvedCloudEndpoint {
  const { manifest, isPackaged } = inputs;
  const env = inputs.env ?? {};
  const channel = manifest.channel;

  const overrideValue = CLOUD_ENDPOINT_OVERRIDE_VARS.map((name) => env[name]).find((v) => typeof v === "string" && v.trim().length > 0);

  const overrideAllowed = channel === "development" && !isPackaged;

  if (overrideValue && overrideAllowed) {
    return {
      url: assertValidCloudUrl(overrideValue.trim(), channel),
      channel,
      overridden: true,
      overrideReason: "development channel, unpackaged build — environment override honored",
    };
  }

  const configured = manifest.endpoints[channel];
  if (!configured) {
    if (channel === "development") {
      return {
        url: DEFAULT_DEVELOPMENT_CLOUD_URL,
        channel,
        overridden: false,
        overrideReason: overrideValue ? "override ignored (packaged build)" : "no override set",
      };
    }
    throw new CloudEndpointError(
      `No CodeForge Cloud endpoint is configured for the '${channel}' channel. A ${channel} build must ship an explicit HTTPS endpoint; refusing to fall back to a local address.`,
    );
  }

  return {
    url: assertValidCloudUrl(configured, channel),
    channel,
    overridden: false,
    overrideReason: overrideValue
      ? `override IGNORED — the '${channel}' channel${isPackaged ? " (packaged build)" : ""} does not permit an endpoint override`
      : "no override set",
  };
}

/**
 * Parse and validate a manifest loaded from disk. A malformed manifest must stop startup rather than
 * degrade to a guess about where the Cloud lives.
 */
export function parseCloudEndpointManifest(raw: unknown): CloudEndpointManifest {
  if (!raw || typeof raw !== "object") {
    throw new CloudEndpointError("Cloud endpoint manifest must be a JSON object");
  }
  const candidate = raw as { channel?: unknown; endpoints?: unknown };

  if (candidate.channel !== "development" && candidate.channel !== "staging" && candidate.channel !== "production") {
    throw new CloudEndpointError(`Cloud endpoint manifest has an invalid channel: ${JSON.stringify(candidate.channel)}`);
  }
  if (candidate.endpoints !== undefined && (typeof candidate.endpoints !== "object" || candidate.endpoints === null)) {
    throw new CloudEndpointError("Cloud endpoint manifest 'endpoints' must be an object");
  }

  const endpoints: Partial<Record<CloudBuildChannel, string>> = {};
  for (const [key, value] of Object.entries((candidate.endpoints ?? {}) as Record<string, unknown>)) {
    if (key !== "development" && key !== "staging" && key !== "production") continue;
    if (typeof value === "string" && value.trim().length > 0) endpoints[key] = value.trim();
  }

  return { channel: candidate.channel, endpoints };
}

/** Redacted, log-safe description of the resolved endpoint. */
export function describeCloudEndpoint(resolved: ResolvedCloudEndpoint): string {
  return `channel=${resolved.channel} cloud=${resolved.url} overridden=${resolved.overridden} (${resolved.overrideReason})`;
}
