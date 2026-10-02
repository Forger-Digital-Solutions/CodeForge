import { createHash } from "node:crypto";
import { hashQuotaScope, type FreeAdmissionReceipt, type QuotaScopeEvidence } from "@codeforge/forge-zero";

export type OpenRouterAccountClass = "FREE_VERIFIED" | "PAID" | "PROMOTIONAL" | "UNKNOWN" | "REVOKED";

export interface OpenRouterEntitlementReceipt {
  provider: "openrouter";
  ownerUserId: string;
  credentialFingerprint: string;
  accountClass: OpenRouterAccountClass;
  accountIdentityHash?: string;
  verifiedAt: string;
  recheckAt: string;
  expiresAt?: string;
  reason: string;
  freeRequests?: { limit: number; remaining: number; used: number };
  quotaScopeEvidence?: QuotaScopeEvidence;
  admissionEvidence?: Omit<FreeAdmissionReceipt, "qualificationAt">;
}

export function openRouterCredentialFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function classifyOpenRouterEntitlement(
  metadata: unknown,
  binding: { ownerUserId: string; key: string; now?: Date; status?: number },
): OpenRouterEntitlementReceipt {
  const now = binding.now ?? new Date();
  const verifiedAt = now.toISOString();
  const base: OpenRouterEntitlementReceipt = {
    provider: "openrouter", ownerUserId: binding.ownerUserId,
    credentialFingerprint: openRouterCredentialFingerprint(binding.key),
    accountClass: "UNKNOWN", verifiedAt, recheckAt: new Date(now.getTime() + 6 * 3_600_000).toISOString(),
    reason: "AUTHORITATIVE_ACCOUNT_METADATA_MISSING",
  };
  if (binding.status === 401 || binding.status === 403) return { ...base, accountClass: "REVOKED", reason: "CREDENTIAL_REJECTED" };
  if (binding.status !== undefined && binding.status !== 200) return base;
  if (!metadata || typeof metadata !== "object") return base;
  const raw = (metadata as { data?: unknown }).data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const data = raw as Record<string, unknown>;
  if (data.is_free_tier === false) return { ...base, accountClass: "PAID", reason: "PROVIDER_REPORTS_PAID_TIER" };
  if (data.is_free_tier !== true || data.is_management_key === true || data.is_provisioning_key === true) return base;
  if (typeof data.creator_user_id !== "string" || !data.creator_user_id.trim() || data.organization_id != null) {
    return { ...base, reason: "INDEPENDENT_PERSONAL_QUOTA_OWNER_UNVERIFIED" };
  }
  if (!binding.ownerUserId.trim()) return { ...base, reason: "LOCAL_ACCOUNT_OWNER_MISSING" };
  const expiry = data.expires_at;
  if (expiry !== undefined && expiry !== null && (typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)))) return base;
  if (typeof expiry === "string" && Date.parse(expiry) <= now.getTime()) return { ...base, accountClass: "REVOKED", reason: "KEY_EXPIRED", expiresAt: expiry };
  const quota = data.free_model_daily_requests as Record<string, unknown> | undefined;
  if (!quota || ![quota.limit, quota.remaining, quota.used].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    || (quota.limit as number) <= 0 || (quota.remaining as number) + (quota.used as number) !== quota.limit) {
    return { ...base, reason: "AUTHORITATIVE_FREE_QUOTA_MISSING" };
  }
  const accountIdentityHash = hashQuotaScope("openrouter", "USER_ACCOUNT", data.creator_user_id);
  const nextDailyReset = Math.floor(now.getTime() / 86_400_000) * 86_400_000 + 86_400_000;
  const recheckAt = new Date(Math.min(Date.parse(base.recheckAt), nextDailyReset, typeof expiry === "string" ? Date.parse(expiry) : Infinity)).toISOString();
  return {
    ...base, accountClass: "FREE_VERIFIED", reason: "PERSONAL_FREE_TIER_AND_RECURRING_QUOTA_VERIFIED", accountIdentityHash, recheckAt,
    ...(typeof expiry === "string" ? { expiresAt: expiry } : {}),
    freeRequests: { limit: quota.limit as number, remaining: quota.remaining as number, used: quota.used as number },
    quotaScopeEvidence: { scope: "USER_ACCOUNT", identityHash: accountIdentityHash, source: "https://openrouter.ai/api/v1/key", verifiedAt, recheckAt },
  };
}

export async function verifyOpenRouterEntitlement(options: {
  key: string; ownerUserId: string; now?: Date; fetchFn?: typeof fetch;
}): Promise<OpenRouterEntitlementReceipt> {
  try {
    const response = await (options.fetchFn ?? fetch)("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${options.key}` }, signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    const metadata: unknown = response.ok ? await response.json() : undefined;
    const receipt = classifyOpenRouterEntitlement(metadata, { ...options, status: response.status });
    if (receipt.accountClass !== "FREE_VERIFIED") return receipt;
    const policyUrls = ["https://openrouter.ai/terms", "https://openrouter.ai/privacy", "https://openrouter.ai/docs/api_reference/limits"];
    const policies = await Promise.all(policyUrls.map(async (url) => {
      const policy = await (options.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!policy.ok || new URL(policy.url || url).hostname !== "openrouter.ai") throw new Error("POLICY_UNAVAILABLE");
      const body = await policy.text();
      if (body.length < 500 || body.length > 2_000_000) throw new Error("POLICY_UNAVAILABLE");
      return { body, hash: createHash("sha256").update(body).digest("hex") };
    }));
    if (!/Terms of Service/i.test(policies[0]!.body) || !/August 31, 2026/i.test(policies[0]!.body)
      || !/Privacy Policy/i.test(policies[1]!.body) || !/August 31, 2026/i.test(policies[1]!.body)
      || !/free_model_daily_requests/.test(policies[2]!.body) || !/current UTC day/i.test(policies[2]!.body)) {
      return { ...receipt, reason: "FREE_POLICY_REVERIFICATION_REQUIRED" };
    }
    return { ...receipt, admissionEvidence: {
      sourceDocumentation: "https://openrouter.ai/docs/guides/overview/auth/oauth",
      termsEvidence: policyUrls[0]!, privacyEvidence: policyUrls[1]!, priceEvidence: `${policyUrls[2]}; /api/v1/key is_free_tier=true; exact-zero model catalog required`,
      verifiedAt: receipt.verifiedAt, recheckAt: receipt.recheckAt,
      termsVerifiedAt: receipt.verifiedAt, termsEvidenceHash: policies[0]!.hash, termsExpiresAt: receipt.recheckAt,
      privacyVerifiedAt: receipt.verifiedAt, privacyEvidenceHash: policies[1]!.hash, privacyExpiresAt: receipt.recheckAt,
      priceVerifiedAt: receipt.verifiedAt, priceEvidenceHash: policies[2]!.hash, priceExpiresAt: receipt.recheckAt,
    } };
  } catch {
    return classifyOpenRouterEntitlement(undefined, options);
  }
}

export function isOpenRouterEntitlementCurrent(receipt: OpenRouterEntitlementReceipt | undefined, ownerUserId: string, key: string, now = new Date()): boolean {
  return !!receipt && receipt.accountClass === "FREE_VERIFIED" && receipt.ownerUserId === ownerUserId
    && receipt.credentialFingerprint === openRouterCredentialFingerprint(key)
    && Date.parse(receipt.verifiedAt) <= now.getTime() && Date.parse(receipt.recheckAt) > now.getTime()
    && (!receipt.expiresAt || Date.parse(receipt.expiresAt) > now.getTime());
}
