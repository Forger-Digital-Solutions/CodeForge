import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type CodeForgeServer } from "../src/index.js";
import { ForgeZero } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { NormalizedModelRegistry, createFreeCloudService } from "@codeforge/model-registry";

/**
 * R35 Mission AQ — the release-status endpoint must never claim readiness the
 * supply cannot back: no routes → not ready, and the blocker must name the
 * class (external supply vs internal defect vs operator action).
 */
describe("GET /api/free-cloud/release-status (R35-AQ)", () => {
  let server: CodeForgeServer;
  let base: string;

  afterEach(async () => {
    await server?.stop();
  });

  it("reports internal-unavailable honestly when Free Cloud is not configured", async () => {
    server = createServer({ port: 0, dbPath: ":memory:" });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/release-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; blockers: Array<{ code: string; class: string }> };
    expect(body.ready).toBe(false);
    expect(body.supplyReady).toBe(false);
    expect(body.blockers[0]?.code).toBe("FREE_CLOUD_UNAVAILABLE");
    expect(body.blockers[0]?.class).toBe("internal");
  });

  it("reports no-supply as an external blocker, never as a defect", async () => {
    const freeCloud = createFreeCloudService({
      firewall: new ForgeZero(),
      providerCatalog: new InMemoryProviderCatalog(),
      registry: new NormalizedModelRegistry(),
    });
    server = createServer({ port: 0, dbPath: ":memory:", freeCloud });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/release-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      supply: { admittedRoutes: number; healthyRoutes: number };
      blockers: Array<{ code: string; class: string }>;
    };
    expect(body.ready).toBe(false);
    expect(body.supply.healthyRoutes).toBe(0);
    const blocker = body.blockers.find((b) => b.code === "NO_ADMITTED_FREE_ROUTE" || b.code === "NO_HEALTHY_FREE_ROUTE");
    expect(blocker?.class).toBe("external_supply");
  });

  it("requires the control-plane bearer when one is configured", async () => {
    server = createServer({ port: 0, dbPath: ":memory:", controlPlaneToken: "test-token-123" });
    await server.start();
    const denied = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/release-status`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/free-cloud/release-status`, {
      headers: { "x-codeforge-control-token": "test-token-123" },
    });
    expect(ok.status).toBe(200);
  });

  it("fails closed: a routable bind without a control-plane token refuses to start", async () => {
    const unauthenticated = createServer({ port: 0, dbPath: ":memory:", host: "0.0.0.0" });
    await expect(unauthenticated.start()).rejects.toThrow(/controlPlaneToken/);
    // With the bearer configured the same bind is a deliberate operator choice.
    server = createServer({ port: 0, dbPath: ":memory:", host: "127.0.0.1" });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });
});
