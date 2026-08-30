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

  it("evaluates free user task permissions with fail-closed bounds", () => {
    const user = db.createUser({ displayName: "Free Dev", primaryIdentity: "github:100" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    db.upsertSubscription({
      userId: user.id,
      planId: "free",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    db.appendLedgerEvent({
      userId: user.id,
      amount: 50_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
    });

    // Allowed free task
    const allowed = service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 0,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.availableCredits).toBe(50_000);

    // Blocked on concurrency cap (free limit is 1)
    const concurrencyBlocked = service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 1,
    });
    expect(concurrencyBlocked.allowed).toBe(false);
    expect(concurrencyBlocked.reason).toContain("Concurrent task limit reached");

    // Blocked on premium model (free user cannot run paid/gems tier)
    const premiumBlocked = service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "paid",
      requestedEstimatedCredits: 5_000,
      activeConcurrency: 0,
    });
    expect(premiumBlocked.allowed).toBe(false);
    expect(premiumBlocked.reason).toContain("requires a CodeForge Pro subscription");
  });

  it("blocks requests when credit balance reaches zero", () => {
    const user = db.createUser({ displayName: "Exhausted Dev", primaryIdentity: "github:200" });
    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    db.upsertSubscription({
      userId: user.id,
      planId: "free",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    // Balance is 0
    const check = service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "free",
      requestedEstimatedCredits: 1_000,
      activeConcurrency: 0,
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("used your included CodeForge hosted usage");
  });

  it("allows premium models and higher concurrency for Pro subscribers", () => {
    const user = db.createUser({ displayName: "Pro Dev", primaryIdentity: "github:300" });
    service.syncSubscriptionEntitlements(user.id, "pro");
    db.upsertSubscription({
      userId: user.id,
      planId: "pro",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    db.appendLedgerEvent({
      userId: user.id,
      amount: 5_000_000,
      eventType: "SUBSCRIPTION_ALLOWANCE_GRANTED",
    });

    const proTask = service.evaluateTaskExecution({
      userId: user.id,
      modelTier: "paid",
      requestedEstimatedCredits: 50_000,
      activeConcurrency: 2, // Allowed up to 4
    });
    expect(proTask.allowed).toBe(true);
    expect(proTask.planId).toBe("pro");
  });
});
