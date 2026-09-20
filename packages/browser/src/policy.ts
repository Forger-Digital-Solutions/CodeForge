import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Browser URL policy. Web pages are untrusted input and untrusted network targets: a model must
 * never steer the runtime into cloud metadata services, arbitrary local files, or dangerous
 * schemes. Localhost development is legitimate, so loopback is allowed by default while
 * link-local/metadata ranges are always denied.
 */

export type UrlNetworkClass = "loopback" | "private" | "public" | "metadata" | "multicast" | "unspecified";

export interface BrowserPolicy {
  /** http:// on loopback is required for local development verification. */
  allowLoopbackHttp: boolean;
  /** http:// on public/private hosts is downgraded-able plaintext; default deny. */
  allowPlainHttp: boolean;
  /** RFC-1918 / ULA targets (LAN). Default deny — a browser is not a LAN scanner. */
  allowPrivateNetwork: boolean;
  /** Extra exact hostnames explicitly permitted (lowercased, no port). */
  allowedHosts?: ReadonlySet<string>;
  /** Extra hostnames always denied (lowercased, no port). */
  deniedHosts?: ReadonlySet<string>;
}

export const DEFAULT_BROWSER_POLICY: BrowserPolicy = {
  allowLoopbackHttp: true,
  allowPlainHttp: false,
  allowPrivateNetwork: false,
};

export type UrlDecision =
  | { allowed: true; url: URL; networkClass: UrlNetworkClass }
  | { allowed: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.2.136",
]);

function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return nums;
}

/** Classify a literal IP address. IPv6 addresses may arrive bracketed. */
export function classifyIp(rawIp: string): UrlNetworkClass {
  const ip = rawIp.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip === "0.0.0.0" || ip === "::") return "unspecified";
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "metadata";
    if (a === 100 && b! >= 64 && b! <= 127) return "metadata"; // CGNAT block carries cloud metadata endpoints
    if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private";
    if (a! >= 224) return "multicast";
    return "public";
  }
  if (ip === "::1") return "loopback";
  if (ip.startsWith("fe80:") || ip.startsWith("fe80::")) return "metadata"; // link-local v6
  if (ip === "fd00:ec2::254" || ip.startsWith("fd00:ec2:")) return "metadata"; // AWS Nitro metadata
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private"; // ULA
  if (ip.startsWith("ff")) return "multicast";
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (mapped) return classifyIp(mapped);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return classifyIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  return "public";
}

export function classifyHostname(hostname: string): UrlNetworkClass | undefined {
  // URL.hostname keeps IPv6 brackets ("[::1]"); strip them before classification.
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (isIP(host)) return classifyIp(host);
  return undefined;
}

function deny(reason: string): UrlDecision {
  return { allowed: false, reason };
}

function decideClass(url: URL, networkClass: UrlNetworkClass, policy: BrowserPolicy): UrlDecision {
  switch (networkClass) {
    case "metadata":
      return deny("cloud metadata / link-local endpoints are never navigable");
    case "unspecified":
      return deny("unspecified-address targets are never navigable");
    case "multicast":
      return deny("multicast/broadcast targets are never navigable");
    case "private":
      if (!policy.allowPrivateNetwork) return deny("private-network targets require allowPrivateNetwork");
      break;
    case "loopback":
      break;
    case "public":
      break;
  }
  if (url.protocol === "http:") {
    const plaintextOk =
      (networkClass === "loopback" && policy.allowLoopbackHttp) ||
      (networkClass === "private" && policy.allowPrivateNetwork) ||
      policy.allowPlainHttp;
    if (!plaintextOk) return deny("plaintext http: is allowed only for loopback development targets");
  }
  return { allowed: true, url, networkClass };
}

/** Synchronous scheme/hostname policy check. `assertUrlAllowed` adds DNS resolution. */
export function checkUrl(rawUrl: string, policy: BrowserPolicy = DEFAULT_BROWSER_POLICY): UrlDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny("unparseable URL");
  }
  if (url.username || url.password) return deny("URLs with embedded credentials are never navigable");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return deny(`scheme ${url.protocol} is not navigable`);
  }
  const host = url.hostname.toLowerCase();
  if (policy.deniedHosts?.has(host)) return deny("host is explicitly denied");
  if (policy.allowedHosts?.has(host)) return { allowed: true, url, networkClass: "public" };
  if (BLOCKED_HOSTNAMES.has(host)) return deny("cloud metadata endpoints are never navigable");

  const literal = classifyHostname(host);
  if (literal) return decideClass(url, literal, policy);
  // Unresolvable-by-policy hostnames are decided after DNS resolution in assertUrlAllowed.
  return decideClass(url, "public", policy);
}

/**
 * Full navigation check: static policy plus DNS resolution. A hostname that resolves to a
 * metadata, private, or otherwise denied address is rejected — rebinding cannot smuggle a
 * denied target past the scheme check.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  policy: BrowserPolicy = DEFAULT_BROWSER_POLICY,
  resolveHost: (host: string) => Promise<string[]> = defaultResolve,
): Promise<UrlDecision> {
  const initial = checkUrl(rawUrl, policy);
  if (!initial.allowed) return initial;
  const host = initial.url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) || policy.allowedHosts?.has(host)) return initial;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return deny(`hostname did not resolve: ${host}`);
  }
  if (addresses.length === 0) return deny(`hostname did not resolve: ${host}`);
  for (const address of addresses) {
    const cls = classifyIp(address);
    if (cls === "metadata" || cls === "unspecified" || cls === "multicast") {
      return deny(`hostname resolves to a denied ${cls} address`);
    }
    if (cls === "private" && !policy.allowPrivateNetwork) {
      return deny("hostname resolves to a private-network address (set allowPrivateNetwork to permit)");
    }
    if (cls === "loopback" && host !== "localhost" && !host.endsWith(".localhost")) {
      // A public-looking name that resolves to loopback is a rebinding smell; treat as loopback.
      return decideClass(initial.url, "loopback", policy);
    }
  }
  return initial;
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}
