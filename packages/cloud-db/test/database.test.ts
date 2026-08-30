import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudDatabase, createCloudDatabase } from "../src/index.js";

describe("CloudDatabase", () => {
  let db: CloudDatabase;

  beforeEach(() => {
    db = new CloudDatabase({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  it("creates and retrieves a user and identity", () => {
    const user = db.createUser({
      displayName: "Octocat",
      avatarUrl: "https://github.com/images/octocat.png",
      primaryIdentity: "github:12345",
    });
    expect(user.id).toBeDefined();
    expect(user.displayName).toBe("Octocat");

    const fetched = db.getUserById(user.id);
    expect(fetched?.primaryIdentity).toBe("github:12345");

    const byIdentity = db.getUserByPrimaryIdentity("github:12345");
    expect(byIdentity?.id).toBe(user.id);

    const identity = db.createIdentity({
      userId: user.id,
      provider: "github",
      providerUserId: "12345",
      providerEmail: "octocat@github.com",
    });
    expect(identity.userId).toBe(user.id);

    const fetchedIdentity = db.getIdentityByProvider("github", "12345");
    expect(fetchedIdentity?.providerEmail).toBe("octocat@github.com");
  });

  it("manages device sessions and rotation", () => {
    const user = db.createUser({ displayName: "Tester", primaryIdentity: "github:999" });
    const session = db.createDeviceSession({
      userId: user.id,
      deviceName: "Workstation",
      refreshTokenHash: "hash_abc_123",
    });
    expect(session.revokedAt).toBeNull();

    const fetched = db.getDeviceSessionByTokenHash("hash_abc_123");
    expect(fetched?.id).toBe(session.id);

    // Rotate session
    const rotated = db.rotateDeviceSession({
      oldTokenHash: "hash_abc_123",
      newRefreshTokenHash: "hash_def_456",
    });
    expect(rotated.session.refreshTokenHash).toBe("hash_def_456");

    // Old session is revoked
    const oldSession = db.getDeviceSessionByTokenHash("hash_abc_123");
    expect(oldSession?.revokedAt).not.toBeNull();

    // Replay of old token fails and detects breach
    expect(() => {
      db.rotateDeviceSession({
        oldTokenHash: "hash_abc_123",
        newRefreshTokenHash: "hash_ghi_789",
      });
    }).toThrow(/replay detected/);
  });

  it("seeds default plans and manages subscriptions", () => {
    const plans = db.listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans.some((p) => p.id === "free")).toBe(true);
    expect(plans.some((p) => p.id === "pro")).toBe(true);

    const user = db.createUser({ displayName: "Pro User", primaryIdentity: "github:777" });
    const sub = db.upsertSubscription({
      userId: user.id,
      planId: "pro",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    expect(sub.planId).toBe("pro");

    const fetched = db.getSubscriptionByUserId(user.id);
    expect(fetched?.stripeSubscriptionId).toBe("sub_123");
    expect(fetched?.id).toBe(sub.id);
  });

  it("manages entitlements with fail-closed expiry", () => {
    const user = db.createUser({ displayName: "Entitled User", primaryIdentity: "github:555" });
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);

    db.setEntitlement(user.id, "HOSTED_FREE", "true");
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(true);

    // Expired entitlement returns false
    const past = new Date(Date.now() - 1000).toISOString();
    db.setEntitlement(user.id, "COMMUNITY_MODELS", "true", past);
    expect(db.hasEntitlement(user.id, "COMMUNITY_MODELS")).toBe(false);

    db.removeEntitlement(user.id, "HOSTED_FREE");
    expect(db.hasEntitlement(user.id, "HOSTED_FREE")).toBe(false);
  });

  it("manages append-only credit ledger and computes balance accurately", () => {
    const user = db.createUser({ displayName: "Wallet User", primaryIdentity: "github:111" });
    expect(db.getCreditBalance(user.id)).toBe(0);

    // Initial grant
    const grant = db.appendLedgerEvent({
      userId: user.id,
      amount: 500_000,
      eventType: "FREE_ALLOWANCE_GRANTED",
      description: "Initial CodeForge Free Tier allowance",
    });
    expect(grant.balanceAfter).toBe(500_000);
    expect(db.getCreditBalance(user.id)).toBe(500_000);

    // Usage deduction
    const usage = db.appendLedgerEvent({
      userId: user.id,
      amount: -12_500,
      eventType: "CREDIT_USED",
      requestId: "req-1",
      description: "Hosted inference turn 1",
    });
    expect(usage.balanceAfter).toBe(487_500);
    expect(db.getCreditBalance(user.id)).toBe(487_500);

    // Cannot spend more than balance
    expect(() => {
      db.appendLedgerEvent({
        userId: user.id,
        amount: -500_000,
        eventType: "CREDIT_USED",
      });
    }).toThrow(/Insufficient credit balance/);

    const history = db.listLedgerEvents(user.id);
    expect(history).toHaveLength(2);
  });

  it("manages server-owned OAuth transactions with single-use and expiration", () => {
    const tx = db.createOAuthTransaction({
      state: "state_123",
      codeChallenge: "challenge_abc",
      redirectUri: "http://127.0.0.1:8765/auth/callback",
      deviceName: "Test Machine",
      expiresInSeconds: 60,
    });
    expect(tx.state).toBe("state_123");
    expect(tx.usedAt).toBeNull();

    const consumed = db.consumeOAuthTransaction("state_123");
    expect(consumed.usedAt).not.toBeNull();

    // Replay of consumed transaction is rejected
    expect(() => db.consumeOAuthTransaction("state_123")).toThrow(/already consumed/);

    // Unknown transaction is rejected
    expect(() => db.consumeOAuthTransaction("non_existent_state")).toThrow(/not found/);
  });

  it("manages first-class reservations with strict state machine and idempotency", () => {
    const user = db.createUser({ displayName: "Res User", primaryIdentity: "github:333" });
    const res = db.createReservation({
      requestId: "req-res-1",
      userId: user.id,
      providerId: "openrouter",
      modelId: "qwen/qwen3.6-27b",
      reservedCredits: 5000,
    });
    expect(res.status).toBe("reserved");
    expect(res.reservedCredits).toBe(5000);

    // Duplicate create returns existing (idempotent)
    const dup = db.createReservation({
      requestId: "req-res-1",
      userId: user.id,
      providerId: "openrouter",
      modelId: "qwen/qwen3.6-27b",
      reservedCredits: 5000,
    });
    expect(dup.id).toBe(res.id);

    // Different user cannot reuse same requestId
    const user2 = db.createUser({ displayName: "Attacker", primaryIdentity: "github:444" });
    expect(() => {
      db.createReservation({
        requestId: "req-res-1",
        userId: user2.id,
        providerId: "openrouter",
        modelId: "qwen/qwen3.6-27b",
        reservedCredits: 5000,
      });
    }).toThrow(/already associated with another user/);

    // Commit reservation
    const committed = db.commitReservation("req-res-1", user.id, 4200);
    expect(committed.status).toBe("committed");
    expect(committed.actualCredits).toBe(4200);

    // Duplicate commit is idempotent no-op
    const dupCommit = db.commitReservation("req-res-1", user.id, 4200);
    expect(dupCommit.status).toBe("committed");

    // Cannot release already committed reservation
    expect(() => db.releaseReservation("req-res-1", user.id)).toThrow(/already been committed/);
  });

  it("manages recurring monthly usage periods idempotently", () => {
    const user = db.createUser({ displayName: "Usage User", primaryIdentity: "github:555" });

    // Initial period creation grants allowance
    const period1 = db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-01-01T00:00:00Z"));
    expect(period1.grantedNewAllowance).toBe(true);
    expect(db.getCreditBalance(user.id)).toBe(500_000);

    // Second call in same period does not grant extra allowance
    const period1Same = db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-01-15T00:00:00Z"));
    expect(period1Same.grantedNewAllowance).toBe(false);
    expect(db.getCreditBalance(user.id)).toBe(500_000);

    // Call in new period (e.g. 35 days later) grants new monthly allowance
    const period2 = db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-02-05T00:00:00Z"));
    expect(period2.grantedNewAllowance).toBe(true);
    expect(db.getCreditBalance(user.id)).toBe(1_000_000);
  });

  it("validates database driver configuration and rejects inconsistent settings", () => {
    // Rejects postgres URL as sqlite filename
    expect(() => {
      createCloudDatabase({
        driver: "sqlite",
        databaseUrl: "postgresql://postgres:secret@localhost:5432/codeforge",
      });
    }).toThrow(/Refusing to use Postgres URL as SQLite file path/);

    // Rejects postgres driver with missing DATABASE_URL
    expect(() => {
      createCloudDatabase({
        driver: "postgres",
        databaseUrl: "",
      });
    }).toThrow(/DATABASE_URL is missing/);
  });
});
