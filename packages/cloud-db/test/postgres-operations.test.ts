import { describe, it, expect } from "vitest";
import { PostgresCloudDatabase } from "../src/postgres.js";

function createMockPgPool(handler: (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number }) {
  const queryLog: Array<{ sql: string; params: unknown[] }> = [];

  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      queryLog.push({ sql, params });
      return handler(sql, params);
    },
    release: () => {},
  };

  const mockPool = {
    connect: async () => mockClient,
    query: async (sql: string, params: unknown[] = []) => {
      queryLog.push({ sql, params });
      return handler(sql, params);
    },
    end: async () => {},
  };

  return { pool: mockPool as unknown as import("pg").Pool, queryLog };
}

describe("PostgresCloudDatabase — Parameterized Queries and Mappers", () => {
  it("creates user and identities with parameterized queries", async () => {
    const { pool, queryLog } = createMockPgPool((sql, params) => {
      if (sql.includes("INSERT INTO users")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM users WHERE id =")) {
        return {
          rows: [
            {
              id: params[0],
              display_name: "Mock PG User",
              avatar_url: "https://pg.test/avatar.png",
              primary_identity: "github:12345",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresCloudDatabase({ pool });
    const user = await db.createUser({
      displayName: "Mock PG User",
      avatarUrl: "https://pg.test/avatar.png",
      primaryIdentity: "github:12345",
    });

    expect(user.displayName).toBe("Mock PG User");
    expect(user.primaryIdentity).toBe("github:12345");

    const fetched = await db.getUserById(user.id);
    expect(fetched?.displayName).toBe("Mock PG User");

    expect(queryLog.some((q) => q.sql.includes("INSERT INTO users"))).toBe(true);
    expect(queryLog.some((q) => q.sql.includes("SELECT * FROM users WHERE id = $1"))).toBe(true);
  });

  it("handles stringified BIGINT in balance and ledger queries without truncation", async () => {
    const { pool } = createMockPgPool((sql) => {
      if (sql.includes("SELECT balance_after FROM credit_ledger")) {
        // node-postgres returns BIGINT as string "5000000"
        return { rows: [{ balance_after: "5000000" }] };
      }
      if (sql.includes("INSERT INTO credit_ledger")) {
        return {
          rows: [
            {
              id: "led-1",
              user_id: "u-1",
              seq: "42",
              amount: "5000000",
              balance_after: "5000000",
              event_type: "FREE_ALLOWANCE_GRANTED",
              request_id: null,
              description: "Allowance",
              metadata: null,
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresCloudDatabase({ pool });
    const balance = await db.getCreditBalance("u-1");
    expect(balance).toBe(5_000_000);
    expect(typeof balance).toBe("number");
  });

  it("uses row-level locking (SELECT ... FOR UPDATE) in transactions", async () => {
    const { pool, queryLog } = createMockPgPool((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "u-1" }] };
      }
      if (sql.includes("SELECT * FROM reservations WHERE request_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT balance_after FROM credit_ledger")) {
        return { rows: [{ balance_after: "100000" }] };
      }
      if (sql.includes("INSERT INTO reservations")) {
        return {
          rows: [
            {
              id: "res-1",
              request_id: "req-1",
              user_id: "u-1",
              provider_id: "openrouter",
              model_id: "m",
              reserved_credits: "5000",
              actual_credits: "0",
              status: "reserved",
              created_at: new Date().toISOString(),
              committed_at: null,
              released_at: null,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO credit_ledger")) {
        return {
          rows: [
            {
              id: "led-1",
              user_id: "u-1",
              seq: "1",
              amount: "-5000",
              balance_after: "95000",
              event_type: "CREDIT_RESERVED",
              request_id: "req-1",
              description: "Reserved",
              metadata: null,
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresCloudDatabase({ pool });
    const res = await db.reserveCredits({
      requestId: "req-1",
      userId: "u-1",
      providerId: "openrouter",
      modelId: "m",
      reservedCredits: 5000,
    });

    expect(res.reservation.status).toBe("reserved");
    expect(res.balanceAfter).toBe(95000);

    // Verify transaction lifecycle and lock
    expect(queryLog.some((q) => q.sql === "BEGIN")).toBe(true);
    expect(queryLog.some((q) => q.sql.includes("SELECT id FROM users WHERE id = $1 FOR UPDATE"))).toBe(true);
    expect(queryLog.some((q) => q.sql === "COMMIT")).toBe(true);
  });

  it("rolls back transaction on error without leaking client", async () => {
    let clientReleased = false;
    const mockClient = {
      query: async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("SELECT id FROM users")) {
          throw new Error("Simulated deadlock / connection error");
        }
        return { rows: [] };
      },
      release: () => {
        clientReleased = true;
      },
    };

    const mockPool = {
      connect: async () => mockClient,
      query: async () => ({ rows: [] }),
      end: async () => {},
    };

    const db = new PostgresCloudDatabase({ pool: mockPool as unknown as import("pg").Pool });

    await expect(
      db.reserveCredits({
        requestId: "req-err-1",
        userId: "u-1",
        providerId: "openrouter",
        modelId: "m",
        reservedCredits: 5000,
      }),
    ).rejects.toThrow(/Simulated deadlock/);

    expect(clientReleased).toBe(true);
  });
});
