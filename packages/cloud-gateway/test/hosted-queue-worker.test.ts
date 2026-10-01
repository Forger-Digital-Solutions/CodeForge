import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { HostedAdmissionAuthority } from "../src/hosted-admission.js";
import { HostedQueueWorker } from "../src/hosted-queue-worker.js";

const route = { providerId: "synthetic-worker", modelId: "verified-free" };

describe("HostedQueueWorker", () => {
  let db: SQLiteCloudDatabase;
  let userId: string;
  let authority: HostedAdmissionAuthority;

  beforeEach(async () => {
    db = new SQLiteCloudDatabase();
    userId = (await db.createUser({ displayName: "Worker User", primaryIdentity: `worker:${randomUUID()}` })).id;
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 1 });
    authority = new HostedAdmissionAuthority({ db, workerId: "worker-a", leaseMs: 1_000, maxUserConcurrent: 1 });
  });

  afterEach(async () => {
    await db.close();
  });

  const enqueue = async (suffix: string) => authority.enqueue({ executionId: `execution-${suffix}`, idempotencyKey: `key-${suffix}`, userId, taskId: `task-${suffix}`, ...route });

  it("claims, dispatches, executes and terminalizes through durable authority", async () => {
    const queued = await enqueue("complete");
    let providerCalls = 0;
    const worker = new HostedQueueWorker({ authority, execute: async () => { providerCalls++; return { status: "completed" }; } });
    expect(await worker.runOnce()).toBe("executed");
    expect(providerCalls).toBe(1);
    expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("completed");
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("does not call a provider for a task cancelled while queued", async () => {
    const queued = await enqueue("queued-cancel");
    await authority.cancel(queued.execution.id, userId);
    let providerCalls = 0;
    const worker = new HostedQueueWorker({ authority, execute: async () => { providerCalls++; return { status: "completed" }; } });
    expect(await worker.runOnce()).toBe("idle");
    expect(providerCalls).toBe(0);
  });

  it("propagates running cancellation and preserves the cancelled terminal state", async () => {
    const queued = await enqueue("running-cancel");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = new HostedQueueWorker({
      authority,
      heartbeatMs: 5,
      execute: async (_execution, signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "failed" };
      },
    });
    const running = worker.runOnce();
    await didStart;
    const cancelled = await authority.cancel(queued.execution.id, userId);
    expect(cancelled.dispatchMayHaveStarted).toBe(true);
    expect(worker.cancelLocal(queued.execution.id)).toBe(true);
    await running;
    expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("cancelled");
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("records provider failure once and releases capacity", async () => {
    const queued = await enqueue("failure");
    const errors: unknown[] = [];
    const worker = new HostedQueueWorker({ authority, execute: async () => { throw new Error("provider offline"); }, onError: (error) => errors.push(error) });
    await worker.runOnce();
    expect(errors).toHaveLength(1);
    expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("failed");
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("executes distinct accounts concurrently up to the configured durable pool capacity", async () => {
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 2 });
    const otherUser = (await db.createUser({ displayName: "Second Worker User", primaryIdentity: `worker:${randomUUID()}` })).id;
    await authority.enqueue({ executionId: "execution-concurrent-a", idempotencyKey: "key-concurrent-a", userId, taskId: "task-concurrent-a", ...route });
    await authority.enqueue({ executionId: "execution-concurrent-b", idempotencyKey: "key-concurrent-b", userId: otherUser, taskId: "task-concurrent-b", ...route });
    let active = 0;
    let peak = 0;
    let startedCount = 0;
    let release!: () => void;
    const releaseExecutions = new Promise<void>((resolve) => { release = resolve; });
    const worker = new HostedQueueWorker({
      authority,
      maxConcurrentDispatches: 2,
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        startedCount++;
        await releaseExecutions;
        active--;
        return { status: "completed" };
      },
    });
    const running = worker.run();
    try {
      await vi.waitFor(() => expect(startedCount).toBe(2), { timeout: 5_000, interval: 10 });
      expect(worker.activeCount()).toBe(2);
      expect(peak).toBe(2);
      release();
      await vi.waitFor(async () => {
        expect(await db.getHostedExecution("execution-concurrent-a", userId)).toMatchObject({ status: "completed" });
        expect(await db.getHostedExecution("execution-concurrent-b", otherUser)).toMatchObject({ status: "completed" });
      }, { timeout: 5_000, interval: 10 });
    } finally {
      release();
      worker.stop();
      await running;
    }
  });

  it("aborts an in-flight execution after observeCancellations verifies durable terminal state", async () => {
    const queued = await enqueue("observed-cancel");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let abortedReason: unknown;
    const worker = new HostedQueueWorker({
      authority,
      execute: async (_execution, signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { abortedReason = signal.reason; resolve(); }, { once: true }));
        return { status: "failed" };
      },
    });
    const running = worker.runOnce();
    await didStart;
    // A remote cancellation commits on a different authority — no local cancelLocal, no event.
    await authority.cancel(queued.execution.id, userId);
    await worker.observeCancellations([queued.execution.id]);
    await running;
    expect(abortedReason).toBeDefined();
    expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("cancelled");
    // The cancelled row's capacity was released by the cancel transaction, not by the worker.
    expect((await db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("delivers cross-process cancellation through the event subscription path", async () => {
    const queued = await enqueue("event-cancel");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = new HostedQueueWorker({
      authority,
      execute: async (_execution, signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "failed" };
      },
    });
    const sub = await db.subscribeHostedExecutionEvents((event) => {
      void worker.observeCancellations(event.executionIds === "*" ? "*" : event.executionIds);
    });
    try {
      const running = worker.runOnce();
      await didStart;
      // The sqlite emitter fires the wake-up after the durable commit — same shape the
      // Postgres LISTEN/NOTIFY channel delivers across processes.
      await authority.cancel(queued.execution.id, userId);
      await running;
      expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("cancelled");
    } finally {
      await sub.close();
    }
  });

  it("recovers a missed notification through the bounded durable poll", async () => {
    const queued = await enqueue("poll-cancel");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = new HostedQueueWorker({
      authority,
      cancelObserveMs: 25,
      execute: async (_execution, signal) => {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "failed" };
      },
    });
    // No subscription at all: the only delivery path is the worker's own poll.
    const running = worker.run();
    try {
      await didStart;
      await authority.cancel(queued.execution.id, userId);
      await vi.waitFor(() => {
        expect(worker.activeCount()).toBe(0);
      }, { timeout: 5_000, interval: 10 });
      expect((await db.getHostedExecution(queued.execution.id, userId))?.status).toBe("cancelled");
    } finally {
      worker.stop();
      await running;
    }
  });
});
