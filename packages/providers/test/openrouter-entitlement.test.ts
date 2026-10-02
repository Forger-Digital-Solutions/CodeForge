import { describe, expect, it } from "vitest";
import { classifyOpenRouterEntitlement, verifyOpenRouterEntitlement, isOpenRouterEntitlementCurrent } from "../src/openrouter-entitlement.js";

const now = new Date("2026-10-02T12:00:00Z");
const binding = { key: "test-delegated-secret", ownerUserId: "alice", now };
const data = { is_free_tier: true, creator_user_id: "provider-alice", organization_id: null,
  free_model_daily_requests: { limit: 50, remaining: 49, used: 1 }, expires_at: null };

describe("OpenRouter delegated Free entitlement", () => {
  it("binds recurring quota to the provider account and requesting user without retaining secrets", () => {
    const receipt = classifyOpenRouterEntitlement({ data }, binding);
    expect(receipt.accountClass).toBe("FREE_VERIFIED");
    expect(receipt.accountIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(binding.key);
    expect(JSON.stringify(receipt)).not.toContain(data.creator_user_id);
    expect(isOpenRouterEntitlementCurrent(receipt, "alice", binding.key, now)).toBe(true);
    expect(isOpenRouterEntitlementCurrent(receipt, "bob", binding.key, now)).toBe(false);
    expect(isOpenRouterEntitlementCurrent(receipt, "alice", "replacement-key", now)).toBe(false);
    expect(isOpenRouterEntitlementCurrent(receipt, "alice", binding.key, new Date(receipt.recheckAt))).toBe(false);
    expect(receipt.admissionEvidence).toBeUndefined();
  });

  it.each([
    [{ ...data, is_free_tier: false }, "PAID"],
    [{ ...data, is_free_tier: undefined }, "UNKNOWN"],
    [{ ...data, creator_user_id: undefined }, "UNKNOWN"],
    [{ ...data, organization_id: "shared-org" }, "UNKNOWN"],
    [{ ...data, is_management_key: true }, "UNKNOWN"],
    [{ ...data, expires_at: "2026-10-02T11:59:59Z" }, "REVOKED"],
    [{ ...data, expires_at: "invalid" }, "UNKNOWN"],
    [{ ...data, free_model_daily_requests: { limit: 50, remaining: 50, used: 1 } }, "UNKNOWN"],
    [{ ...data, free_model_daily_requests: undefined }, "UNKNOWN"],
  ])("fails closed on paid, ambiguous, expired or unmeasured entitlement %#", (metadata, accountClass) => {
    expect(classifyOpenRouterEntitlement({ data: metadata }, binding).accountClass).toBe(accountClass);
  });

  it("different keys belonging to the same account never manufacture independent domains", () => {
    const a = classifyOpenRouterEntitlement({ data }, binding);
    const b = classifyOpenRouterEntitlement({ data }, { ...binding, key: "other-key", ownerUserId: "bob" });
    expect(a.accountIdentityHash).toBe(b.accountIdentityHash);
    expect(a.credentialFingerprint).not.toBe(b.credentialFingerprint);
  });

  it("requires independent public policy reads before issuing an admission receipt", async () => {
    const calls: Array<{ url: string; credential: boolean }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, credential: new Headers(init?.headers).has("authorization") });
      if (url.endsWith("/api/v1/key")) return Response.json({ data });
      return new Response(`${url.includes("/terms") ? "Terms of Service August 31, 2026" : url.includes("/privacy") ? "Privacy Policy August 31, 2026" : "free_model_daily_requests current UTC day"} ${"policy ".repeat(90)}`);
    };
    const receipt = await verifyOpenRouterEntitlement({ ...binding, fetchFn });
    expect(receipt.admissionEvidence?.termsEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.credential).map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  it("rejects revoked credentials and keeps transport failures secret-free", async () => {
    const rejected = await verifyOpenRouterEntitlement({ ...binding, fetchFn: async () => new Response("secret", { status: 401 }) });
    expect(rejected.accountClass).toBe("REVOKED");
    const unknown = await verifyOpenRouterEntitlement({ ...binding, fetchFn: async () => { throw new Error(binding.key); } });
    expect(unknown.accountClass).toBe("UNKNOWN");
    expect(JSON.stringify(unknown)).not.toContain(binding.key);
  });

  it("requires policy review after material policy version drift", async () => {
    const receipt = await verifyOpenRouterEntitlement({ ...binding, fetchFn: async (input) => String(input).endsWith("/api/v1/key")
      ? Response.json({ data }) : new Response(`Terms of Service Privacy Policy September 30, 2026 free_model_daily_requests current UTC day ${"policy ".repeat(90)}`) });
    expect(receipt.admissionEvidence).toBeUndefined();
    expect(receipt.reason).toBe("FREE_POLICY_REVERIFICATION_REQUIRED");
  });

  it("rechecks recurring quota before the UTC daily boundary", () => {
    const receipt = classifyOpenRouterEntitlement({ data }, { ...binding, now: new Date("2026-10-02T23:59:00Z") });
    expect(receipt.recheckAt).toBe("2026-10-03T00:00:00.000Z");
  });
});
