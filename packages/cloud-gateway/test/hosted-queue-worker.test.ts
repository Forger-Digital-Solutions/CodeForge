import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
