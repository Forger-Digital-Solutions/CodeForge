import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import type { ChatRequest } from "@codeforge/providers";
import { PersonalAccountBudgetGuard, type PersonalAccountAuthority, type PersonalAccountBinding, type PersonalAccountEstimate } from "../src/personal-account-policy.js";

const NOW = Date.now();
const price = { modelId: "fixture-model", inputCostPerMillion: 1, outputCostPerMillion: 2,
  currency: "USD" as const, confidence: "AUTHORITATIVE" as const, source: "https://openrouter.ai/api/v1/models",
  verifiedAt: new Date(NOW - 1000).toISOString(), recheckAt: new Date(NOW + 60_000).toISOString(), tokenOnly: true };
const binding: PersonalAccountBinding = { ownerUserId: "alice", connectionId: "fixture-connection", canonicalProviderId: "openrouter", credentialRef: "fixture-reference", modelId: price.modelId, pricing: price };
const request: ChatRequest = { model: price.modelId, messages: [{ role: "user", content: "public fixture" }], maxTokens: 32,
  metadata: { personalAccountOwnerUserId: "alice", personalAccountConnectionId: binding.connectionId,
    personalAccountRequestId: "fixture-request", personalAccountSessionId: "fixture-session", personalAccountRunId: "fixture-run" } };

describe("paid estimate precedes physical dispatch", () => {
  let persistence: ISessionPersistence;
  let account: PersonalAccountAuthority;
  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" }); await persistence.init();
    account = { ownerUserId: "alice", connectionId: binding.connectionId, providerId: "openrouter", credentialRef: binding.credentialRef,
      accountClass: "PAID", quotaDomainId: "openrouter:USER_ACCOUNT:fixture", quotaScopeVerified: true, enabled: true,
      paidSpendingEnabled: true, monthlyBudgetCents: 100, authState: "ok", verifiedAt: price.verifiedAt, recheckAt: price.recheckAt, modelPricing: [price] };
  });
  afterEach(async () => { await persistence.close(); });
  const guard = (onEstimate: (estimate: PersonalAccountEstimate) => Promise<void>) => new PersonalAccountBudgetGuard(persistence, {
    personalAccountAuthority: () => account, personalRoutingPolicy: () => ({ mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true }),
    now: () => NOW, onEstimate,
  });

  it("holds a durable reservation while presentation is pending and records presentation before dispatch", async () => {
    let release!: () => void; let estimated!: PersonalAccountEstimate; let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const hold = await guard(async estimate => { estimated = estimate; entered(); await pending; }).reserve(binding, request, "fixture-key");
    const dispatch = hold.dispatch(); await enteredPromise;
    expect(estimated).toMatchObject({ connectionId: binding.connectionId, modelId: price.modelId, sessionId: "fixture-session", runId: "fixture-run", currency: "USD", purpose: "INFERENCE" });
    expect(estimated.estimatedCostUsd).toBeGreaterThan(0);
    expect(estimated.remainingBudgetUsd + estimated.estimatedCostUsd).toBeCloseTo(1, 6);
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_attempt"))).toContain('"status":"RESERVED"');
    await expect(hold.dispatch()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_ALREADY_DISPATCHED" });
    release(); await dispatch;
    const attempts = JSON.stringify(await persistence.getWorkItemsByKind("personal_account_attempt"));
    expect(attempts).toContain('"status":"DISPATCHED"'); expect(attempts).toContain("estimatePresentedAt");
    expect(attempts).not.toContain("public fixture"); expect(attempts).not.toContain("fixture-key");
    await hold.settle({ inputTokens: 2, outputTokens: 2 });
  });

  it("fails before dispatch when presentation fails and releases the uncharged reservation", async () => {
    const hold = await guard(async () => { throw new Error("unsafe callback content"); }).reserve(binding, request, "fixture-key");
    await expect(hold.dispatch()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_ESTIMATE_UNAVAILABLE", message: "PERSONAL_ACCOUNT_ESTIMATE_UNAVAILABLE" });
    await hold.fail();
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_attempt"))).toContain('"status":"RELEASED"');
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_budget"))).toContain('"consumedMicros":0');
  });

  it("rechecks permission after the estimate is shown", async () => {
    const hold = await guard(async () => { account.paidSpendingEnabled = false; }).reserve(binding, request, "fixture-key");
    await expect(hold.dispatch()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_PAID_DISABLED" }); await hold.fail();
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_attempt"))).not.toContain('"status":"DISPATCHED"');
  });
});
