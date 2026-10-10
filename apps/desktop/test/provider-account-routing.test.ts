import { describe, expect, it } from "vitest";
import { defaultPersonalProviderRoutingPolicy, parsePersonalProviderRoutingPolicy, personalPaidQualificationAdmission, readPersonalProviderRoutingPolicy, writePersonalProviderRoutingPolicy } from "../src/provider-account-routing.js";

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

  it("permits unqualified evaluation only with current global and exact account consent", () => {
    const policy = parsePersonalProviderRoutingPolicy({ mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true });
    const account = { connectionId: "account-a", enabled: true, authState: "ok", accountClass: "PAID", paidSpendingEnabled: true, monthlyBudgetCents: 100, preference: "AUTO" };
    expect(personalPaidQualificationAdmission(policy, account)).toEqual({ eligible: true });
    for (const patch of [{ mode: "FREE_ONLY" as const }, { paidEnabled: false }, { explicitConsent: false }, { limitationsAcknowledged: false }]) expect(personalPaidQualificationAdmission({ ...policy, ...patch }, account).eligible).toBe(false);
    for (const patch of [{ enabled: false }, { authState: "unknown" }, { accountClass: "UNKNOWN" }, { paidSpendingEnabled: false }, { monthlyBudgetCents: 0 }, { monthlyBudgetCents: NaN }, { monthlyBudgetCents: Number.MAX_SAFE_INTEGER }, { preference: "MANUAL" }]) expect(personalPaidQualificationAdmission(policy, { ...account, ...patch }).eligible).toBe(false);
    const selected = { ...policy, mode: "SPECIFIC_ACCOUNT" as const, specificAccountConnectionId: "account-a" };
    expect(personalPaidQualificationAdmission(selected, { ...account, preference: "MANUAL" }).eligible).toBe(true);
    expect(personalPaidQualificationAdmission({ ...selected, specificAccountConnectionId: "account-b" }, account).eligible).toBe(false);
  });
});
