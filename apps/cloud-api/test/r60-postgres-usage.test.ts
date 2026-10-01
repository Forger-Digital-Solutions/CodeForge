import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { CodeForgeCloudServer } from "../src/index.js";
import { createMockGitHubFetch, loginToCloud } from "../../../tests/helpers/cloud-login.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL;
const suite = TEST_PG?.includes("/codeforge_r60_test_") ? describe : describe.skip;

suite.each(["sqlite", "postgres"] as const)("R60 authenticated usage — %s", (backend) => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new CodeForgeCloudServer({
      driver: backend,
      ...(backend === "postgres" ? { databaseUrl: TEST_PG } : { dbPath: ":memory:" }),
      jwtSecret: "r60-test-jwt-secret-at-least-32-characters",
      stripeConfig: null,
      discoverOnStart: false,
      fetchFn: createMockGitHubFetch({ id: randomInt(100_000_000, 2_000_000_000), login: `r60_${backend}`, email: "r60@example.test" }),
    });
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("reports reserved and settled Free credits for the authenticated account", async () => {
    const auth = await loginToCloud(baseUrl);
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    const usage = async (suffix = "") => {
      const response = await fetch(`${baseUrl}/v1/usage${suffix}`, { headers });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ freeAllowanceCredits: number; freeReservedCredits: number; freeUsedCredits: number; freeRemainingCredits: number; freePerTaskCreditLimit: number; freeConcurrentTaskLimit: number }>;
    };

    expect((await fetch(`${baseUrl}/v1/usage`)).status).toBe(401);
    const initial = await usage();
    expect(initial.freeAllowanceCredits).toBe(500_000);
    expect(initial.freeUsedCredits).toBe(0);
    expect(initial.freeRemainingCredits).toBe(500_000);
    expect(initial.freePerTaskCreditLimit).toBe(50_000);
    expect(initial.freeConcurrentTaskLimit).toBe(1);

    const period = await server.db.getOrCreateCurrentUsagePeriod(auth.user.id);
    const requestId = randomUUID();
    await server.db.reserveCredits({ requestId, userId: auth.user.id, providerId: "codeforge-owned", modelId: "codeforge/forgeauto-free", reservedCredits: 8_000, usagePeriodId: period.period.id, maxConcurrentTasks: 1, maxTaskSpendCredits: 50_000 });
    const reserved = await usage("?userId=another-account");
    expect(reserved.freeReservedCredits).toBe(8_000);
    expect(reserved.freeRemainingCredits).toBe(492_000);

    await server.db.settleReservation({ requestId, userId: auth.user.id, actualCredits: 3_000 });
    const settled = await usage();
    expect(settled.freeReservedCredits).toBe(0);
    expect(settled.freeUsedCredits).toBe(3_000);
    expect(settled.freeRemainingCredits).toBe(497_000);
  });
});
