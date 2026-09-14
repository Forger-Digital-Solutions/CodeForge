import { describe, expect, it } from "vitest";
import {
  assertTrustDomain,
  TrustDomainViolationError,
  validateCustomAutoProfile,
  type CustomAutoProfile,
} from "../src/profile.js";

describe("CustomAutoProfile Schema and Validation", () => {
  const validProfile: CustomAutoProfile = {
    id: "my-coding-team",
    name: "My Coding Team",
    roles: {
      coder: { providerId: "anthropic", modelId: "claude-3-5-sonnet", displayName: "Claude 3.5 Sonnet" },
      reviewer: { providerId: "openai", modelId: "gpt-4o", displayName: "GPT-4o" },
    },
    fallbackOrder: ["coder", "reviewer"],
    maxActiveSpecialists: 2,
    mode: "pinned",
    verificationStrictness: "STANDARD",
    trustDomain: "USER_CUSTOM_AUTO",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };

  it("validates a well-formed profile successfully", () => {
    const res = validateCustomAutoProfile(validProfile);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.id).toBe("my-coding-team");
      expect(res.profile.roles.coder.providerId).toBe("anthropic");
    }
  });

  it("supports automatic, pinned, and hybrid modes", () => {
    for (const mode of ["auto", "pinned", "hybrid"] as const) {
      const res = validateCustomAutoProfile({ ...validProfile, mode });
      expect(res.ok).toBe(true);
    }
  });

  it("rejects invalid characters in id", () => {
    const res = validateCustomAutoProfile({ ...validProfile, id: "bad/id with spaces" });
    expect(res.ok).toBe(false);
  });

  it("rejects missing coder seat in roles", () => {
    const noCoder = { ...validProfile, roles: { reviewer: validProfile.roles.reviewer } };
    const res = validateCustomAutoProfile(noCoder);
    expect(res.ok).toBe(false);
  });

  it("strictly prohibits CodeForge-managed free providers in Custom AUTO roles", () => {
    const managedInRole = {
      ...validProfile,
      roles: {
        coder: { providerId: "codeforge", modelId: "free-route" },
      },
    };
    const res = validateCustomAutoProfile(managedInRole);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("may not use CodeForge-managed free provider");
    }
  });

  it("assertTrustDomain throws TrustDomainViolationError on mismatch", () => {
    expect(() => {
      assertTrustDomain("FORGE_AUTO_FREE", "USER_CUSTOM_AUTO", "test execution");
    }).toThrow(TrustDomainViolationError);

    expect(() => {
      assertTrustDomain("USER_CUSTOM_AUTO", "USER_CUSTOM_AUTO", "valid execution");
    }).not.toThrow();
  });
});