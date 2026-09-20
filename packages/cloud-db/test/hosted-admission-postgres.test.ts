import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresCloudDatabase } from "../src/postgres.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;
const suite = TEST_PG ? describe : describe.skip;

suite("durable hosted admission — real PostgreSQL", () => {
  const databases: PostgresCloudDatabase[] = [];
  let users: string[];
  const suffix = randomUUID();
  let route: { providerId: string; modelId: string };

  const connection = async () => {
    const db = new PostgresCloudDatabase({ connectionString: TEST_PG! });
    await db.init();
    databases.push(db);
    return db;
  };

  beforeEach(async () => {
    route = { providerId: `r20-pg-${randomUUID()}`, modelId: "verified-free" };
    const db = await connection();
    users = await Promise.all(Array.from({ length: 20 }, async (_, index) => (await db.createUser({ displayName: `PG User ${index}`, primaryIdentity: `r20-pg:${suffix}:${randomUUID()}` })).id));
    await db.setHostedProviderCapacity({ ...route, maxConcurrent: 4 });
  });

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it("coordinates independent connections without oversubscribing capacity four", async () => {
    const writer = databases[0]!;
    for (let index = 0; index < 100; index++) {
      await writer.enqueueHostedExecution({ id: `pg-cap-${suffix}-${index}`, idempotencyKey: `pg-cap-key-${suffix}-${index}`, userId: users[index % users.length]!, taskId: `task-${index}`, ...route });
    }
    const workers = await Promise.all(Array.from({ length: 3 }, () => connection()));
    const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => workers[index % workers.length]!.claimNextHostedExecution({ workerId: `pg-worker-${suffix}-${index}`, leaseMs: 60_000, maxUserConcurrent: 4 })));
    const routeClaims = claims.filter((claim) => claim?.execution.providerId === route.providerId && claim.execution.modelId === route.modelId);
    expect(routeClaims).toHaveLength(4);
    expect(new Set(routeClaims.map((claim) => claim!.execution.id))).toHaveLength(4);
  }, 30_000);

  it("preserves fair user rotation across three independent connections", async () => {
    const writer = databases[0]!;
    for (let index = 0; index < 50; index++) await writer.enqueueHostedExecution({ id: `pg-heavy-${suffix}-${index}`, idempotencyKey: `pg-heavy-key-${suffix}-${index}`, userId: users[0]!, taskId: `heavy-${index}`, ...route });
    for (let index = 1; index < users.length; index++) await writer.enqueueHostedExecution({ id: `pg-normal-${suffix}-${index}`, idempotencyKey: `pg-normal-key-${suffix}-${index}`, userId: users[index]!, taskId: `normal-${index}`, ...route });
    const workers = await Promise.all(Array.from({ length: 3 }, () => connection()));
    const served: string[] = [];
    for (let index = 0; index < 20; index++) {
      const worker = workers[index % workers.length]!;
      const claim = await worker.claimNextHostedExecution({ workerId: `fair-worker-${index % 3}`, leaseMs: 60_000, maxUserConcurrent: 1 });
      expect(claim).toBeDefined();
      served.push(claim!.execution.userId);
      await worker.completeHostedExecution({ executionId: claim!.execution.id, userId: claim!.execution.userId, status: "completed" });
    }
    expect(new Set(served)).toHaveLength(20);
  }, 30_000);

  it("enforces idempotency and stale-lease ambiguity across reconnects", async () => {
    const first = databases[0]!;
    const replay = await connection();
    const params = { id: `pg-replay-${suffix}`, idempotencyKey: `pg-replay-key-${suffix}`, userId: users[0]!, taskId: "replay", ...route };
    expect((await first.enqueueHostedExecution(params)).created).toBe(true);
    expect((await replay.enqueueHostedExecution({ ...params, id: `${params.id}-retry` })).created).toBe(false);
    const start = new Date(Date.now() + 1_000);
    const claim = await first.claimNextHostedExecution({ workerId: "crashed-worker", leaseMs: 10, maxUserConcurrent: 1, now: start });
    await first.markHostedExecutionDispatching({ executionId: claim!.execution.id, workerId: "crashed-worker" });
    await first.close();
    databases.splice(databases.indexOf(first), 1);
    const restarted = await connection();
    const recovered = await restarted.recoverExpiredHostedLeases(new Date(start.getTime() + 11));
    expect(recovered.executionIds).toContain(claim!.execution.id);
    expect((await restarted.getHostedExecution(claim!.execution.id, users[0]!))?.status).toBe("recovery_pending");
  });
});
