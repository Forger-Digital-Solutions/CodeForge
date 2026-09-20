import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { HostedAdmissionAuthority } from "../src/hosted-admission.js";

const route = { providerId: "synthetic", modelId: "verified-free" };

describe("HostedAdmissionAuthority", () => {
  let db: SQLiteCloudDatabase;
  let users: string[];
  let workers: HostedAdmissionAuthority[];

  beforeEach(async () => {
    db = new SQLiteCloudDatabase();
    users = await Promise.all(Array.from({ length: 10 }, async (_, index) => (await db.createUser({ displayName: `User ${index}`, primaryIdentity: `test:${randomUUID()}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 3 });
    workers = Array.from({ length: 3 }, (_, index) => new HostedAdmissionAuthority({ db, workerId: `worker-${index}`, leaseMs: 100, maxUserConcurrent: 1 }));
  });

  afterEach(async () => {
    await db.close();
  });

  it("coordinates three workers through one durable authority", async () => {
    for (let index = 0; index < 10; index++) await workers[0]!.enqueue({ executionId: `execution-${index}`, idempotencyKey: `key-${index}`, userId: users[index]!, taskId: `task-${index}`, ...route });
    const claims = await Promise.all(workers.map((worker) => worker.claim()));
    expect(claims.filter(Boolean)).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim?.execution.id))).toHaveLength(3);
    expect((await workers[0]!.metrics()).activeReservations).toBe(3);
    expect(await workers[0]!.claim()).toBeUndefined();
  });

  it("supports idempotent replay after a lost enqueue response", async () => {
    const params = { executionId: "execution-replay", idempotencyKey: "key-replay", userId: users[0]!, taskId: "task-replay", ...route };
    const original = await workers[0]!.enqueue(params);
    const replay = await workers[1]!.enqueue({ ...params, executionId: "different-client-retry-id" });
    expect(original.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.execution.id).toBe(original.execution.id);
  });

  it("does not reclaim ambiguous dispatched work after worker death", async () => {
    await workers[0]!.enqueue({ executionId: "execution-ambiguous", idempotencyKey: "key-ambiguous", userId: users[0]!, taskId: "task-ambiguous", ...route });
    const start = new Date();
    const claim = await workers[0]!.claim(start);
    await workers[0]!.beginDispatch(claim!.execution.id);
    expect((await workers[1]!.reconcile(new Date(start.getTime() + 101))).recovered).toBe(1);
    expect((await db.getHostedExecution(claim!.execution.id, users[0]!))?.status).toBe("recovery_pending");
    expect(await workers[2]!.claim(new Date(start.getTime() + 102))).toBeUndefined();
  });
});
