import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "../src/index.js";

describe("Cloud Entitlement Service", () => {
  let db: CloudDatabase;
  let service: EntitlementService;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
    service = new EntitlementService(db);
  });

  afterEach(() => {
    db.close();
  });

  it("evaluates free user task permissions with fail-closed bounds", async () => {
    const user = await db.createUser({ displayName: "Free Dev", primaryIdentity: "github:100" });
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");
    await db.upsertSubscription({
      userId: user.id,
      planId: "free",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    // Allowed free task
    const allowed = await service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 0,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.availableCredits).toBe(500_000);

    // Blocked on concurrency cap (free limit is 1)
    const concurrencyBlocked = await service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 1,
    });
    expect(concurrencyBlocked.allowed).toBe(false);
    expect(concurrencyBlocked.reason).toContain("Concurrent task limit reached");

    // Blocked on premium model (free user cannot run paid/gems tier)
    const premiumBlocked = await service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "paid",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 0,
    });
    expect(premiumBlocked.allowed).toBe(false);
    expect(premiumBlocked.reason).toContain("requires a CodeForge Pro subscription");
  });

  it("blocks requests when credit balance reaches zero", async () => {
    const user = await db.createUser({ displayName: "Exhausted Dev", primaryIdentity: "github:200" });
    await db.setEntitlement(user.id, "HOSTED_FREE", "true");
    await db.upsertSubscription({
      userId: user.id,
      planId: "free",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    const period = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000)).period;
    for (let index = 0; index < 10; index++) {
      const requestId = `exhaust-free-${index}`;
      await db.reserveCredits({ requestId, userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_000, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
      await db.settleReservation({ requestId, userId: user.id, actualCredits: 50_000 });
    }

    const check = await service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 1_000,
      activeConcurrency: 0,
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("monthly CodeForge Free allowance is exhausted");
  });

  it("allows premium models and higher concurrency for Pro subscribers", async () => {
    const user = await db.createUser({ displayName: "Pro Dev", primaryIdentity: "github:300" });
    await service.syncSubscriptionEntitlements(user.id, "pro");
    await db.upsertSubscription({
      userId: user.id,
      planId: "pro",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    await db.appendLedgerEvent({
      userId: user.id,
      amount: 5_000_000,
      eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
    });

    const proTask = await service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "paid",
      requestedEstimatedCredits: 50_000,
      activeConcurrency: 2, // Allowed up to 4
    });
    expect(proTask.allowed).toBe(true);
    expect(proTask.planId).toBe("pro");
  });
  it("keeps Free allowance and concurrency independent of a Pro subscription and wallet", async () => {
    const user = await db.createUser({ displayName: "Pro Free", primaryIdentity: "github:pro-free" });
    await service.syncSubscriptionEntitlements(user.id, "pro");
    await db.upsertSubscription({ userId: user.id, planId: "pro", status: "active", currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(), cancelAtPeriodEnd: false });
    await db.appendLedgerEvent({ userId: user.id, amount: 5_000_000, eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED" });
    const allowed = await service.evaluateTaskExecution({ userId: user.id, product: "FREE", requestedEstimatedCredits: 5_000 });
    expect(allowed.allowed).toBe(true);
    expect(allowed.availableCredits).toBe(500_000);
    expect(allowed.maxEstimatedCredits).toBe(50_000);
    expect((await service.evaluateTaskExecution({ userId: user.id, product: "FREE", activeConcurrency: 1 })).allowed).toBe(false);
    const period = (await db.getOrCreateCurrentUsagePeriod(user.id, 500_000)).period;
    for (let index = 0; index < 10; index++) {
      const requestId = `pro-free-exhaust-${index}`;
      await db.reserveCredits({ requestId, userId: user.id, providerId: "codeforge", modelId: "codeforge/forgeauto-free", reservedCredits: 50_000, usagePeriodId: period.id, maxTaskSpendCredits: 50_000 });
      await db.settleReservation({ requestId, userId: user.id, actualCredits: 50_000 });
    }
    const exhausted = await service.evaluateTaskExecution({ userId: user.id, product: "FREE" });
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.availableCredits).toBe(0);
    expect(exhausted.reason).toContain("monthly CodeForge Free allowance is exhausted");
    expect((await service.evaluateTaskExecution({ userId: user.id, product: "PAID", requestedEstimatedCredits: 5_000 })).allowed).toBe(true);
    expect(await db.getCreditBalance(user.id)).toBe(5_000_000);
    expect((await service.evaluateTaskExecution({ userId: user.id, product: "FREE", modelTier: "paid" })).allowed).toBe(false);
  });
  it("preserves Free access when a paid subscription becomes inactive", async () => {
    const user = await db.createUser({ displayName: "Expired Pro", primaryIdentity: "github:expired-pro" });
    await db.upsertSubscription({ userId: user.id, planId: "pro", status: "canceled", currentPeriodStart: new Date().toISOString(), currentPeriodEnd: new Date().toISOString(), cancelAtPeriodEnd: false });
    expect((await service.evaluateTaskExecution({ userId: user.id, product: "FREE" })).allowed).toBe(true);
    expect((await service.evaluateTaskExecution({ userId: user.id, product: "PAID" })).allowed).toBe(false);
    expect(await db.getCreditBalance(user.id)).toBe(0);
  });
});

