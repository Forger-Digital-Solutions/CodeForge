import { describe, expect, it } from "vitest";
import { defaultPersonalProviderRoutingPolicy, parsePersonalProviderRoutingPolicy, readPersonalProviderRoutingPolicy, writePersonalProviderRoutingPolicy } from "../src/provider-account-routing.js";

describe("personal routing policy", () => {
  it("defaults to Free Only with all spending permissions off", () => {
    expect(defaultPersonalProviderRoutingPolicy()).toEqual({ mode: "FREE_ONLY", paidEnabled: false, explicitConsent: false, limitationsAcknowledged: false, automaticTopUp: false });
    expect(readPersonalProviderRoutingPolicy({}, "alice")).toEqual(defaultPersonalProviderRoutingPolicy());
  });
  it("requires spending consent and an acknowledgement of upstream budget limitations", () => {
    expect(() => parsePersonalProviderRoutingPolicy({ mode: "PAID_PREFERRED", paidEnabled: true })).toThrow("PERSONAL_PAID_CONSENT_REQUIRED");
    expect(() => parsePersonalProviderRoutingPolicy({ mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true })).toThrow("PERSONAL_PAID_CONSENT_REQUIRED");
    expect(parsePersonalProviderRoutingPolicy({ mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true }).paidEnabled).toBe(true);
  });
  it("switching to Free Only removes prior paid permission", () => {
    expect(parsePersonalProviderRoutingPolicy({ mode: "FREE_ONLY", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true })).toEqual(defaultPersonalProviderRoutingPolicy());
  });
  it("isolates users and fails closed on corrupt persistence", () => {
    const settings = writePersonalProviderRoutingPolicy({}, "alice", { mode: "PAID_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true });
    expect(readPersonalProviderRoutingPolicy(settings, "alice").paidEnabled).toBe(true);
    expect(readPersonalProviderRoutingPolicy(settings, "bob").paidEnabled).toBe(false);
    expect(readPersonalProviderRoutingPolicy({ "codeforge:personal-provider-routing:v1": "bad" }, "alice").paidEnabled).toBe(false);
  });
  it("validates exact account selection and refuses automatic top-ups", () => {
    expect(() => parsePersonalProviderRoutingPolicy({ mode: "SPECIFIC_ACCOUNT" })).toThrow("PERSONAL_ROUTING_ACCOUNT_REQUIRED");
    expect(() => parsePersonalProviderRoutingPolicy({ mode: "AUTO_BEST", automaticTopUp: true })).toThrow("PERSONAL_AUTOMATIC_TOP_UP_UNSUPPORTED");
    expect(parsePersonalProviderRoutingPolicy({ mode: "SPECIFIC_ACCOUNT", specificAccountConnectionId: "connection-1" }).specificAccountConnectionId).toBe("connection-1");
  });
});
