import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import type { WorkItem } from "@codeforge/sessions";

async function request(port: number, route: string, method = "GET", body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://localhost:${port}${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) as unknown }; } catch { return { status: response.status, body: text }; }
}

describe("CF-10 delivery HTTP surface", () => {
  let server: ReturnType<typeof createServer>; let port: number;
  beforeEach(async () => { server = createServer({ port: 0, dbPath: ":memory:" }); await server.start(); port = (server as unknown as { httpPort: number }).httpPort; });
  afterEach(async () => { await server.stop(); });

  it("exposes local delivery inspection routes and rejects uncertified sources", async () => {
    expect((await request(port, "/api/deliveries")).body).toEqual([]);
    expect((await request(port, "/api/deliveries", "POST", {})).status).toBe(400);
    expect(await request(port, "/api/deliveries", "POST", { missionId: "unknown" })).toMatchObject({ status: 409, body: { error: "DELIVERY_SOURCE_NOT_CERTIFIED" } });
    expect((await request(port, "/api/deliveries/missing")).status).toBe(404);
    expect((await request(port, "/api/deliveries/missing/review-package")).status).toBe(404);
    expect((await request(port, "/api/deliveries/missing/manifest")).status).toBe(404);
    expect((await request(port, "/api/deliveries/missing/publication")).status).toBe(404);
    expect(await request(port, "/api/deliveries/missing/publication", "POST", { remoteBranch: "main" })).toMatchObject({ status: 400, body: { error: "PUBLICATION_SERVER_OWNED_FIELDS" } });
    expect((await request(port, "/api/deliveries/missing/publication", "POST", {})).status).toBe(409);
    expect((await request(port, "/api/deliveries/missing/cancel", "POST")).status).toBe(409);
    expect((await request(port, "/api/deliveries/missing/resume", "POST")).status).toBe(404);
    expect([403, 404]).toContain((await request(port, "/api/deliveries/missing", "POST", { status: "ready" })).status);
    expect(await request(port, "/api/deliveries", "POST", { missionId: "unknown", status: "ready", certified: true, approved: true, verificationPassed: true })).toMatchObject({ status: 409, body: { error: "DELIVERY_SOURCE_NOT_CERTIFIED" } });
  });

  it("does not let delivery API actions resurrect terminal state or make duplicate terminal transitions", async () => {
    const internal = server as unknown as { persistence: { upsertSession: (item: { id: string; title: string; status: "running"; createdAt: string; updatedAt: string }) => void; upsertWorkItem: (item: WorkItem) => void } };
    const now = new Date().toISOString();
    internal.persistence.upsertSession({ id: "api-session", title: "delivery API", status: "running", createdAt: now, updatedAt: now });
    internal.persistence.upsertWorkItem({
      kind: "change_delivery", id: "cancelled-delivery", sessionId: "api-session", missionId: "mission", workspaceId: "workspace",
      status: "cancelled", sourceRevision: "source", targetRevision: "target", commits: [], verification: [],
      deliveryJson: JSON.stringify({ commits: [], verification: [] }), error: "DELIVERY_CANCELLED", createdAt: now, updatedAt: now,
    } as unknown as WorkItem);
    const first = await request(port, "/api/deliveries/cancelled-delivery/resume", "POST");
    const second = await request(port, "/api/deliveries/cancelled-delivery/resume", "POST");
    expect(first).toMatchObject({ status: 409, body: { ok: false } });
    expect(second).toMatchObject({ status: 409, body: { ok: false } });
    expect(await request(port, "/api/deliveries/cancelled-delivery")).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect((await request(port, "/api/deliveries/cancelled-delivery/cancel", "POST")).status).toBe(409);
    internal.persistence.upsertWorkItem({
      kind: "change_delivery", id: "active-delivery", sessionId: "api-session", missionId: "mission", workspaceId: "workspace",
      status: "packaging", sourceRevision: "source", targetRevision: "target", commits: [], verification: [],
      deliveryJson: JSON.stringify({ commits: [], verification: [] }), createdAt: now, updatedAt: now,
    } as unknown as WorkItem);
    expect(await request(port, "/api/deliveries/active-delivery/cancel", "POST")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await request(port, "/api/deliveries/active-delivery")).toMatchObject({ status: 200, body: { status: "cancelled", error: "DELIVERY_CANCELLED" } });
  });
});
