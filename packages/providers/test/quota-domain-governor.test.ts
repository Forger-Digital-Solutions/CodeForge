import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProviderCapacityGovernor } from "../src/capacity-governor.js";

const identity = (account: string) => `openrouter:USER_ACCOUNT:${createHash("sha256").update(account).digest("hex")}`;

describe("admitted quota-domain pacing", () => {
  it("isolates 2,000 account reservations, cooldowns and observed quotas without an account ceiling", async () => {
    const governor = new ProviderCapacityGovernor({ now: () => 1_000_000 });
    const domains = Array.from({ length: 2_000 }, (_, index) => governor.forQuotaDomain("openrouter", identity(`account-${index}`)));
    const reservations = await Promise.all(domains.map(domain => domain.acquire("openrouter", 1_000)));
    domains[0]!.recordResponse("openrouter", 200, { "x-ratelimit-remaining-tokens": "100" });
    domains[0]!.recordRateLimit("openrouter", 1_060_000);
    expect(domains[0]!.isCoolingDown("openrouter")).toBe(true);
    for (const domain of domains.slice(1)) {
      expect(domain.isCoolingDown("openrouter")).toBe(false);
      expect(domain.getCapacityReport("openrouter").activeConcurrent).toBe(1);
      expect(domain.getCapacityReport("openrouter").observedQuota).toBeUndefined();
    }
    reservations.forEach(reservation => reservation.release(100));
    expect(domains.every(domain => domain.getCapacityReport("openrouter").activeConcurrent === 0)).toBe(true);
    expect(governor.getCapacityReport("openrouter").rpmUsed).toBe(0);
  });

  it("shares one physical account across aliases, runtimes and sessions", () => {
    const governor = new ProviderCapacityGovernor({ now: () => 1_000_000 });
    const a = governor.forQuotaDomain("openrouter", identity("same-account"));
    const b = governor.forQuotaDomain("openrouter", identity("same-account"));
    expect(a).toBe(b);
    a.recordRateLimit("openrouter", 1_060_000, { scope: "model", modelId: "free-coder" });
    expect(b.isCoolingDown("openrouter", "free-coder")).toBe(true);
    expect(b.isCoolingDown("openrouter", "other-model")).toBe(false);
  });

  it("keeps unknown scopes shared and preserves provider fallback limits", () => {
    const governor = new ProviderCapacityGovernor({ now: () => 1_000_000, limits: { openrouter: { maxConcurrent: 3 } } });
    const a = governor.forQuotaDomain("openrouter", "openrouter:UNKNOWN:shared-unverified");
    const b = governor.forQuotaDomain("openrouter", "openrouter:UNKNOWN:shared-unverified");
    a.recordRateLimit("openrouter", 1_060_000);
    expect(b.isCoolingDown("openrouter")).toBe(true);
    expect(a.getEffectiveLimits("openrouter").maxConcurrent).toBe(3);
    expect(() => governor.forQuotaDomain("openrouter", "groq:USER_ACCOUNT:owner")).toThrow("CAPACITY_DOMAIN_AUTHORITY_INVALID");
  });
});
