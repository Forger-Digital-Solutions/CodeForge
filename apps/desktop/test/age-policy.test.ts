import { describe, expect, it } from "vitest";
import {
  AGE_POLICY_VERSION,
  APPROVED_MINIMUM_AGE,
  createAgePolicyAcknowledgement,
  isAgePolicyAcknowledgement,
} from "../src/age-policy.js";

describe("Desktop BYOK Beta age policy", () => {
  it("uses the explicitly approved minimum age", () => {
    expect(APPROVED_MINIMUM_AGE).toBe(18);
    expect(AGE_POLICY_VERSION).toBe("desktop-byok-beta-r1");
  });

  it("creates an acknowledgement only for the active policy", () => {
    expect(createAgePolicyAcknowledgement(18, AGE_POLICY_VERSION)).toEqual({
      minimumAge: 18,
      policyVersion: AGE_POLICY_VERSION,
      acknowledged: true,
    });
    expect(createAgePolicyAcknowledgement(17, AGE_POLICY_VERSION)).toBeNull();
    expect(createAgePolicyAcknowledgement(18, "draft")).toBeNull();
  });

  it("rejects client-shaped or stale acknowledgements", () => {
    expect(isAgePolicyAcknowledgement(createAgePolicyAcknowledgement(18, AGE_POLICY_VERSION))).toBe(true);
    expect(isAgePolicyAcknowledgement({ minimumAge: 21, policyVersion: AGE_POLICY_VERSION, acknowledged: true })).toBe(false);
    expect(isAgePolicyAcknowledgement({ minimumAge: 18, policyVersion: "draft", acknowledged: true })).toBe(false);
    expect(isAgePolicyAcknowledgement({ minimumAge: 18, policyVersion: AGE_POLICY_VERSION, acknowledged: false })).toBe(false);
  });
});
