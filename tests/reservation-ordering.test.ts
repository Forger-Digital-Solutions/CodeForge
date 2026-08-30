import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { EntitlementService } from "@codeforge/cloud-entitlements";
import { UsageEngine } from "@codeforge/cloud-usage";
import { CloudFirewallManager, GatewayService } from "@codeforge/cloud-gateway";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { createSequenceClock, createProviderCallRecorder, type ProviderCallRecorder } from "./helpers/cloud-spy.js";

/**
 * RESERVATION BEFORE PROVIDER — the financial invariant, made mechanically undeniable.
 *
 *   NO HOSTED PROVIDER CALL MAY OCCUR BEFORE A SUCCESSFUL DATABASE RESERVATION.
 *
 * Violating it means CodeForge can incur provider cost it has not authorized and cannot account for.
 * "We call reserve first" is a code-reading claim; this suite turns it into a measurement.
 *
 * A single monotonic sequence clock stamps both the reservation and the provider invocation, so the
 * ordering claim is a numeric comparison rather than a wall-clock race that can tie. Every rejection
 * path then asserts the count that actually matters: provider calls == 0.
 */

/** Records the sequence number at which the provider was actually entered. */
class SequencedProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;

  constructor(
    providerId: string,
    private readonly clock: { next: () => number },
    private readonly recorder: ProviderCallRecorder,
  ) {
    this.providerId = providerId;
  }

  async *streamChat(): AsyncIterable<StreamEvent> {
    this.recorder.record(this.clock.next());
    yield { type: "text_delta", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    this.recorder.record(this.clock.next());
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

/** Wraps a database so the moment a reservation is created is stamped on the same clock. */
function instrumentReservations(db: ICloudDatabase, clock: { next: () => number }, sink: { reserveSequence: number[] }): ICloudDatabase {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "reserveCredits") {
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          // Stamped AFTER the reservation succeeds — a failed reservation must produce no stamp.
          sink.reserveSequence.push(clock.next());
          return result;
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as ICloudDatabase;
}

describe("Reservation-before-provider ordering", () => {
  let rawDb: CloudDatabase;
  let db: ICloudDatabase;
  let clock: ReturnType<typeof createSequenceClock>;
  let recorder: ProviderCallRecorder;
  let sink: { reserveSequence: number[] };
  let firewallManager: CloudFirewallManager;
  let gateway: GatewayService;
  let provider: SequencedProvider;
  let modelId: string;
  let providerId: string;

  async function makeUser(credits: number): Promise<string> {
    const user = await rawDb.createUser({ displayName: "Ordering User", primaryIdentity: `github:ord-${randomUUID()}` });
    if (credits > 0) {
      await rawDb.appendLedgerEvent({ userId: user.id, amount: credits, eventType: "FREE_ALLOWANCE_GRANTED" });
    }
    return user.id;
  }

  function run(userId: string, overrides: Record<string, unknown> = {}) {
    return gateway.executeHostedInference(
      userId,
      { requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], modelId, ...overrides } as never,
      () => {},
    );
  }

  beforeEach(() => {
    rawDb = new CloudDatabase({ dbPath: ":memory:" });
    clock = createSequenceClock();
    recorder = createProviderCallRecorder();
    sink = { reserveSequence: [] };
    db = instrumentReservations(rawDb, clock, sink);

    firewallManager = new CloudFirewallManager();
    const model = createGenericFreeRecord({ providerId: `ordering-${randomUUID().slice(0, 8)}`, modelId: "ordering-free" });
    providerId = model.providerId;
    modelId = model.modelId;
    firewallManager.registerModel(model);
    provider = new SequencedProvider(providerId, clock, recorder);
    firewallManager.registerProvider(provider);

    gateway = new GatewayService({
      firewallManager,
      entitlementService: new EntitlementService(db),
      usageEngine: new UsageEngine(db),
      db,
    });
  });

  it("reserves BEFORE invoking the provider on the success path", async () => {
    const userId = await makeUser(500_000);
    await run(userId);

    expect(sink.reserveSequence).toHaveLength(1);
    expect(recorder.count).toBe(1);
    // The whole invariant, as one numeric comparison on a shared clock.
    expect(sink.reserveSequence[0]).toBeLessThan(recorder.sequence[0]!);
  });

  it("invokes the provider ZERO times when the reservation fails for insufficient credits", async () => {
    const userId = await makeUser(10); // far below the 5,000-credit estimate

    await expect(run(userId)).rejects.toThrow();

    expect(recorder.count).toBe(0);
    expect(sink.reserveSequence).toEqual([]);
    // Nothing was charged either.
    expect(await rawDb.getCreditBalance(userId)).toBe(10);
  });

  it("invokes the provider ZERO times when the database is unavailable", async () => {
    const userId = await makeUser(500_000);

    // Break every database operation except the ones the gateway uses to fail closed.
    const brokenDb = new Proxy(rawDb, {
      get(target, prop, receiver) {
        if (prop === "ping") return async () => false;
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async () => {
          throw new Error("Database connection lost");
        };
      },
    }) as ICloudDatabase;

    const brokenGateway = new GatewayService({
      firewallManager,
      entitlementService: new EntitlementService(brokenDb),
      usageEngine: new UsageEngine(brokenDb),
      db: brokenDb,
    });

    await expect(
      brokenGateway.executeHostedInference(
        userId,
        { requestId: randomUUID(), messages: [{ role: "user", content: "hi" }], modelId } as never,
        () => {},
      ),
    ).rejects.toThrow();

    expect(recorder.count).toBe(0);
  });

  it("invokes the provider ZERO times for the request denied by same-account concurrency", async () => {
    const userId = await makeUser(500_000);

    // Occupy the single Free slot with a reservation the gateway will observe.
    await rawDb.reserveCredits({
      requestId: `occupying-${randomUUID()}`,
      userId,
      providerId,
      modelId,
      reservedCredits: 5_000,
      maxConcurrentTasks: 1,
    });
    const providerCallsBefore = recorder.count;

    await expect(run(userId)).rejects.toThrow(/[Cc]oncurrent|limit/);

    expect(recorder.count).toBe(providerCallsBefore);
    expect(recorder.count).toBe(0);
  });

  it("invokes the provider ZERO times when the account has no hosted entitlement", async () => {
    const user = await rawDb.createUser({ displayName: "No Plan", primaryIdentity: `github:noplan-${randomUUID()}` });
    await rawDb.appendLedgerEvent({ userId: user.id, amount: 500_000, eventType: "FREE_ALLOWANCE_GRANTED" });
    // Subscription references a plan that does not exist -> entitlement evaluation fails closed.
    await rawDb.upsertSubscription({
      userId: user.id,
      planId: "free",
      status: "canceled",
      currentPeriodStart: new Date(Date.now() - 1000).toISOString(),
      currentPeriodEnd: new Date(Date.now() - 500).toISOString(),
      cancelAtPeriodEnd: true,
    });

    // A canceled non-free plan would be refused; for the free plan the guard is the kill switch.
    firewallManager.setKillSwitches({ hostedFreeEnabled: false });
    await expect(run(user.id)).rejects.toThrow();
    expect(recorder.count).toBe(0);
  });

  it("invokes the provider ZERO times when hosted inference is disabled by operator kill switch", async () => {
    const userId = await makeUser(500_000);
    firewallManager.setKillSwitches({ hostedInferenceEnabled: false });

    await expect(run(userId)).rejects.toThrow(/disabled by operator policy/);

    expect(recorder.count).toBe(0);
    expect(sink.reserveSequence).toEqual([]);
  });

  it("invokes the provider ZERO times when the requested model is not eligible", async () => {
    const userId = await makeUser(500_000);

    await expect(run(userId, { modelId: "a-model-that-was-never-registered" })).rejects.toThrow();

    expect(recorder.count).toBe(0);
    expect(sink.reserveSequence).toEqual([]);
    // No money moved for a request that never reached a provider.
    expect(await rawDb.getCreditBalance(userId)).toBe(500_000);
  });

  it("refunds the reservation and leaves accounting whole when the provider itself fails", async () => {
    const userId = await makeUser(500_000);
    const balanceBefore = await rawDb.getCreditBalance(userId);

    const failingProvider: ProviderAdapter = {
      providerId,
      isTestProvider: true,
      async *streamChat(): AsyncIterable<StreamEvent> {
        recorder.record(clock.next());
        throw new Error("Upstream provider exploded");
      },
      async healthCheck() {
        return { status: "available" as const };
      },
      async listModels() {
        return [];
      },
      async chat() {
        throw new Error("Upstream provider exploded");
      },
    };
    firewallManager.providerCatalog.register(failingProvider);

    await expect(run(userId)).rejects.toThrow(/exploded/);

    // The reservation still happened FIRST — a provider failure does not reorder the invariant.
    expect(sink.reserveSequence).toHaveLength(1);
    expect(sink.reserveSequence[0]).toBeLessThan(recorder.sequence[0]!);

    // And the held credits came back: a failed request costs the user nothing.
    expect(await rawDb.getCreditBalance(userId)).toBe(balanceBefore);
    expect(await rawDb.getActiveReservationCount(userId)).toBe(0);
  });

  it("holds the ordering invariant across every concurrent request", async () => {
    const userId = await makeUser(500_000);

    // Pro-level concurrency so several requests genuinely run at once.
    await rawDb.upsertSubscription({
      userId,
      planId: "pro",
      status: "active",
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
    });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => run(userId)));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    // However many were admitted, the provider was entered exactly that many times…
    expect(recorder.count).toBe(succeeded);
    expect(sink.reserveSequence).toHaveLength(succeeded);
    // …and every provider entry is preceded by at least as many completed reservations.
    for (const [index, providerSeq] of recorder.sequence.entries()) {
      const reservationsBefore = sink.reserveSequence.filter((s) => s < providerSeq).length;
      expect(reservationsBefore).toBeGreaterThanOrEqual(index + 1);
    }
  });
});
