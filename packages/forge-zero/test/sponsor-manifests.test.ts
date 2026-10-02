import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SponsorManifestFeed,
  materializeSponsoredRoute,
  sponsorManifestProposal,
  sponsorManifestSigningBytes,
  verifySponsorManifest,
  type SignedSponsorManifest,
  type SponsorTrustedKey,
} from "../src/index.js";

const now = Date.parse("2026-10-01T20:00:00Z");
const url = "https://sponsor.example/manifest.json";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys: SponsorTrustedKey[] = [{
  sponsorId: "lab", keyId: "key-1", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z",
}];

function manifest(sequence = 1, revoked = false): SignedSponsorManifest {
  const fields = {
    manifestVersion: 1 as const, sponsorId: "lab", providerId: "lab-api", offerId: "grant-1",
    logicalRouteId: "lab-coder", physicalModel: "lab/coder", supplyClass: "PACKAGED_FREE_SPONSORED" as const,
    quotaDomainType: "SPONSOR_POOL" as const, egressMode: "SERVER_SPONSORED" as const, authMode: "SPONSOR_TOKEN" as const,
    issuedAt: "2026-10-01T19:00:00Z", startsAt: "2026-10-01T19:00:00Z", expiresAt: "2026-10-02T19:00:00Z",
    sequence, revoked, quota: [{ unit: "requests" as const, limit: 100, period: "DAILY_RESET" as const }], concurrency: 2,
    zeroUserCost: true as const, zeroCodeForgeMarginalCost: true as const, commercialUse: true as const,
    privacyClass: "PUBLIC_CODE_ONLY" as const, trainingUse: "YES" as const, retentionPolicy: "Prompts retained 30 days",
    termsUrl: "https://lab.example/terms", termsHash: "a".repeat(64),
    privacyUrl: "https://lab.example/privacy", privacyHash: "b".repeat(64),
    providerEvidence: ["https://lab.example/offer"], keyId: "key-1",
  };
  return { ...fields, signature: sign(null, sponsorManifestSigningBytes(fields), privateKey).toString("base64url") };
}

function response(body: SignedSponsorManifest | undefined, status = 200): Response {
  const result = new Response(body ? JSON.stringify(body) : null, { status, headers: { etag: '"v1"' } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

describe("authenticated sponsor manifest intake", () => {
  it("accepts only a trusted signed, current, zero-cost proposal", () => {
    const verdict = verifySponsorManifest(manifest(), keys, now);
    expect(verdict.status).toBe("SIGNATURE_VALID");
    if (verdict.status === "SIGNATURE_VALID") {
      const proposal = sponsorManifestProposal(verdict.manifest);
      expect(proposal.status).toBe("PROPOSAL");
      expect(materializeSponsoredRoute(proposal, now)).toBeUndefined();
    }
    expect(verifySponsorManifest({ ...manifest(), concurrency: 100 }, keys, now)).toMatchObject({ status: "QUARANTINED", reason: "SIGNATURE_INVALID" });
    expect(verifySponsorManifest(manifest(), [], now)).toMatchObject({ status: "QUARANTINED", reason: "UNKNOWN_SIGNER" });
    expect(verifySponsorManifest({ ...manifest(), zeroCodeForgeMarginalCost: false }, keys, now)).toMatchObject({ status: "QUARANTINED", reason: "SCHEMA_INVALID" });
    expect(verifySponsorManifest(manifest(), keys, now + 3 * 86_400_000)).toMatchObject({ status: "QUARANTINED", reason: "TIME_INVALID" });
  });

  it("revokes a live offer and rejects an older replay", async () => {
    const bodies = [manifest(1), manifest(2, true), manifest(1)];
    const feed = new SponsorManifestFeed(url, keys, async () => response(bodies.shift()) as Response);
    expect((await feed.refresh(now)).status).toBe("UPDATED");
    expect(feed.current(now)?.offerId).toBe("grant-1");
    expect((await feed.refresh(now + 60 * 60_000)).status).toBe("REVOKED");
    expect(feed.current(now + 60 * 60_000)).toBeUndefined();
    expect(await feed.refresh(now + 2 * 60 * 60_000)).toMatchObject({ status: "QUARANTINED", reason: "REPLAY_OR_IDENTITY_CHANGED" });
  });

  it("uses last known good only while the signature, signer and refresh evidence remain current", async () => {
    let calls = 0;
    const feed = new SponsorManifestFeed(url, keys, async () => {
      if (calls++ === 0) return response(manifest());
      throw new Error("offline");
    });
    await feed.refresh(now);
    expect((await feed.refresh(now + 60 * 60_000)).status).toBe("FETCH_FAILED");
    expect(feed.current(now + 60 * 60_000)).toBeDefined();
    expect(feed.current(now + 6 * 60 * 60_000)).toBeUndefined();
    expect(feed.current(now + 3 * 86_400_000)).toBeUndefined();
  });

  it("drops a cached offer when the trusted signing key expires", async () => {
    const shortKeys = [{ ...keys[0]!, validUntil: new Date(now + 60 * 60_000).toISOString() }];
    const feed = new SponsorManifestFeed(url, shortKeys, async () => response(manifest()));
    expect((await feed.refresh(now)).status).toBe("UPDATED");
    expect(feed.current(now + 60 * 60_000)).toBeUndefined();
  });

  it("quarantines an oversized untrusted remote body", async () => {
    const feed = new SponsorManifestFeed(url, keys, async () => {
      const oversized = new Response("x".repeat(100_001), { status: 200 });
      Object.defineProperty(oversized, "url", { value: url });
      return oversized;
    });
    expect(await feed.refresh(now)).toMatchObject({ status: "QUARANTINED", reason: "SIZE_INVALID" });
  });
});
