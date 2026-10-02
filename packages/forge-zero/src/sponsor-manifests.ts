import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const date = z.string().datetime({ offset: true });
const quota = z.object({
  unit: z.enum(["requests", "input_tokens", "output_tokens", "provider_units"]),
  limit: z.number().int().positive(),
  period: z.enum(["MINUTE_RESET", "HOURLY_RESET", "DAILY_RESET", "WEEKLY_RESET", "MONTHLY_RESET"]),
}).strict();

const signedFields = z.object({
  manifestVersion: z.literal(1),
  sponsorId: z.string().min(1).max(128),
  providerId: z.string().min(1).max(128),
  offerId: z.string().min(1).max(128),
  logicalRouteId: z.string().min(1).max(256),
  physicalModel: z.string().min(1).max(256),
  supplyClass: z.literal("PACKAGED_FREE_SPONSORED"),
  quotaDomainType: z.literal("SPONSOR_POOL"),
  egressMode: z.literal("SERVER_SPONSORED"),
  authMode: z.enum(["SPONSOR_TOKEN", "PROVIDER_GRANT"]),
  issuedAt: date,
  startsAt: date,
  expiresAt: date,
  sequence: z.number().int().nonnegative(),
  revoked: z.boolean(),
  quota: z.array(quota).min(1),
  concurrency: z.number().int().positive(),
  zeroUserCost: z.literal(true),
  zeroCodeForgeMarginalCost: z.literal(true),
  commercialUse: z.literal(true),
  privacyClass: z.enum(["PRIVATE_SAFE", "PROVIDER_RETENTION", "DATA_COLLECTION_ALLOWED", "PUBLIC_CODE_ONLY"]),
  trainingUse: z.enum(["YES", "NO"]),
  retentionPolicy: z.string().min(1).max(2048),
  termsUrl: z.string().url().startsWith("https://"),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/),
  privacyUrl: z.string().url().startsWith("https://"),
  privacyHash: z.string().regex(/^[a-f0-9]{64}$/),
  providerEvidence: z.array(z.string().url().startsWith("https://")).min(1),
  keyId: z.string().min(1).max(128),
}).strict();

const manifestSchema = signedFields.extend({ signature: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict();
export type SignedSponsorManifest = z.infer<typeof manifestSchema>;

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MANIFEST_BODY_MISSING");
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("MANIFEST_SIZE_INVALID");
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface SponsorTrustedKey {
  sponsorId: string;
  keyId: string;
  publicKeyPem: string;
  validFrom: string;
  validUntil: string;
}

export type SponsorManifestVerdict =
  | { status: "SIGNATURE_VALID"; manifest: SignedSponsorManifest }
  | { status: "QUARANTINED"; reason: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sponsorManifestSigningBytes(fields: z.infer<typeof signedFields>): Buffer {
  return Buffer.from(`CodeForge sponsor manifest v1\n${canonical(fields)}`, "utf8");
}

export function verifySponsorManifest(input: unknown, keys: readonly SponsorTrustedKey[], now = Date.now()): SponsorManifestVerdict {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) return { status: "QUARANTINED", reason: "SCHEMA_INVALID" };
  const manifest = parsed.data;
  const start = Date.parse(manifest.startsAt);
  const end = Date.parse(manifest.expiresAt);
  const issued = Date.parse(manifest.issuedAt);
  if (issued > now + 300_000 || start >= end || end <= now || end - issued > 366 * 86_400_000) {
    return { status: "QUARANTINED", reason: "TIME_INVALID" };
  }
  if (manifest.privacyClass === "PRIVATE_SAFE" && manifest.trainingUse !== "NO") {
    return { status: "QUARANTINED", reason: "PRIVACY_INCONSISTENT" };
  }
  const key = keys.find((item) => item.sponsorId === manifest.sponsorId && item.keyId === manifest.keyId);
  if (!key) return { status: "QUARANTINED", reason: "UNKNOWN_SIGNER" };
  if (Date.parse(key.validFrom) > issued || Date.parse(key.validUntil) <= issued || Date.parse(key.validUntil) <= now) {
    return { status: "QUARANTINED", reason: "SIGNER_EXPIRED" };
  }
  const { signature, ...fields } = manifest;
  try {
    const bytes = Buffer.from(signature, "base64url");
    if (bytes.length !== 64 || !verify(null, sponsorManifestSigningBytes(fields), createPublicKey(key.publicKeyPem), bytes)) {
      return { status: "QUARANTINED", reason: "SIGNATURE_INVALID" };
    }
  } catch {
    return { status: "QUARANTINED", reason: "SIGNATURE_INVALID" };
  }
  return { status: "SIGNATURE_VALID", manifest };
}

export interface SponsorRefreshReceipt {
  checkedAt: string;
  status: "UPDATED" | "NOT_MODIFIED" | "FETCH_FAILED" | "QUARANTINED" | "REVOKED" | "EXPIRED";
  reason?: string;
  offerId?: string;
  sequence?: number;
}

/** A verified remote offer is a proposal. Its signature never substitutes for CodeForge terms, qualification, or canary review. */
export class SponsorManifestFeed {
  private etag?: string;
  private accepted?: SignedSponsorManifest;
  private lastSequence = -1;
  private lastIdentity?: string;
  private nextFetchAt = 0;
  private failures = 0;

  constructor(
    private readonly url: string,
    private readonly keys: readonly SponsorTrustedKey[],
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!url.startsWith("https://")) throw new Error("SPONSOR_HTTPS_REQUIRED");
  }

  current(now = Date.now()): SignedSponsorManifest | undefined {
    if (!this.accepted || this.accepted.revoked || Date.parse(this.accepted.startsAt) > now
      || Date.parse(this.accepted.expiresAt) <= now) return undefined;
    return this.accepted;
  }

  async refresh(now = Date.now()): Promise<SponsorRefreshReceipt> {
    const checkedAt = new Date(now).toISOString();
    if (now < this.nextFetchAt) return { checkedAt, status: "NOT_MODIFIED", reason: "REFRESH_INTERVAL" };
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: this.etag ? { "If-None-Match": this.etag } : {},
      });
    } catch {
      this.backoff(now);
      return { checkedAt, status: this.current(now) ? "FETCH_FAILED" : "EXPIRED", reason: "NETWORK_UNAVAILABLE" };
    }
    if (response.url !== this.url) return this.quarantine(checkedAt, "ENDPOINT_CHANGED");
    if (response.status === 304) {
      this.nextFetchAt = now + 60 * 60_000;
      return { checkedAt, status: this.current(now) ? "NOT_MODIFIED" : "EXPIRED" };
    }
    if (!response.ok || Number(response.headers.get("content-length")) > 100_000) {
      this.backoff(now);
      return { checkedAt, status: this.current(now) ? "FETCH_FAILED" : "EXPIRED", reason: "HTTP_OR_SIZE_INVALID" };
    }
    let body: unknown;
    try {
      const raw = await readBoundedText(response, 100_000);
      body = JSON.parse(raw);
    } catch (error) {
      return this.quarantine(checkedAt, error instanceof Error && error.message === "MANIFEST_SIZE_INVALID" ? "SIZE_INVALID" : "JSON_INVALID");
    }
    const verdict = verifySponsorManifest(body, this.keys, now);
    if (verdict.status !== "SIGNATURE_VALID") return this.quarantine(checkedAt, verdict.reason);
    const next = verdict.manifest;
    const identity = `${next.sponsorId}:${next.offerId}`;
    if ((this.lastIdentity && identity !== this.lastIdentity) || next.sequence <= this.lastSequence) {
      return this.quarantine(checkedAt, "REPLAY_OR_IDENTITY_CHANGED");
    }
    this.accepted = next;
    this.lastSequence = next.sequence;
    this.lastIdentity = identity;
    this.etag = response.headers.get("etag") ?? undefined;
    this.failures = 0;
    this.nextFetchAt = now + 60 * 60_000;
    return { checkedAt, status: next.revoked ? "REVOKED" : "UPDATED", offerId: next.offerId, sequence: next.sequence };
  }

  private quarantine(checkedAt: string, reason: string): SponsorRefreshReceipt {
    this.accepted = undefined;
    this.etag = undefined;
    return { checkedAt, status: "QUARANTINED", reason };
  }

  private backoff(now: number): void {
    this.failures++;
    this.nextFetchAt = now + Math.min(60 * 60_000, 2 ** Math.min(this.failures, 10) * 30_000);
  }
}
