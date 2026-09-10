import { describe, expect, it } from "vitest";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { signAccessToken } from "@codeforge/cloud-auth";
import { createSessionPersistence } from "@codeforge/sessions";
import { HostedWorkflowAuthority } from "../src/hosted-workflow-authority.js";
import { CodeForgeCloudServer } from "../src/server.js";

const JWT_SECRET = "hosted-workflow-authority-test-jwt-secret-32chars";

describe("HostedWorkflowAuthority", () => {
  it("persists a worker-bound action and replays its result without duplicate execution", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const authority = new HostedWorkflowAuthority(persistence);
    await authority.init();
    const workflow = await authority.create({ ownerUserId: "user-a", workerId: "worker-a", workspaceId: "workspace-a", task: "Inspect fixture" });
    const request = { actionId: "22222222-2222-4222-8222-222222222222", workflowId: workflow.id, turnId: "turn-a", sessionId: workflow.sessionId, workerId: "worker-a", type: "READ_FILE" as const, arguments: { path: "src/a.ts" }, idempotencyKey: "read-a" };
    await authority.dispatch("user-a", request);
    expect(await authority.pending("user-a", "worker-a")).toEqual([request]);
    await expect(authority.pending("user-b", "worker-a")).resolves.toEqual([]);
    expect((await authority.result("user-a", { actionId: request.actionId, workerId: "worker-a", status: "succeeded", output: "contents", changedResources: [] })).duplicate).toBe(false);
    expect((await authority.result("user-a", { actionId: request.actionId, workerId: "worker-a", status: "succeeded", output: "ignored", changedResources: [] })).duplicate).toBe(true);
    await persistence.close();
  });

  it("exposes owner-scoped hosted workflow lifecycle routes without accepting arbitrary worker actions", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const server = new CodeForgeCloudServer({
      db: new SQLiteCloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: JWT_SECRET,
      stripeConfig: null,
      sessionPersistence: persistence,
    });
    const port = await server.start(0);
    const request = async (userId: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${signAccessToken({ sub: userId, sid: "desktop" }, JWT_SECRET)}`, "content-type": "application/json", ...init.headers },
    });

    try {
      const created = await request("user-a", "/v1/workflows", { method: "POST", body: JSON.stringify({ workerId: "worker-a", workspaceId: "workspace-a", task: "Inspect fixture" }) });
      expect(created.status).toBe(201);
      const workflow = await created.json() as { id: string; revision: number; status: string };
      expect(workflow.status).toBe("active");
      expect((await request("user-a", "/v1/workflows")).status).toBe(200);
      expect((await request("user-b", `/v1/workflows/${workflow.id}`)).status).toBe(404);
      const cancelled = await request("user-a", `/v1/workflows/${workflow.id}/cancel`, { method: "POST" });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ status: "cancelled", revision: workflow.revision + 1 });
      expect((await request("user-a", `/v1/workflows/${workflow.id}/actions`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      await server.stop();
      await persistence.close();
    }
  });

  it("rejects an unrecorded worker result after owner cancellation", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const authority = new HostedWorkflowAuthority(persistence);
    await authority.init();
    try {
      const workflow = await authority.create({ ownerUserId: "user-a", workerId: "worker-a", workspaceId: "workspace-a", task: "Inspect fixture" });
      const request = { actionId: "33333333-3333-4333-8333-333333333333", workflowId: workflow.id, turnId: "turn-a", sessionId: workflow.sessionId, workerId: "worker-a", type: "READ_FILE" as const, arguments: { path: "src/a.ts" }, idempotencyKey: "read-after-cancel" };
      await authority.dispatch("user-a", request);
      await authority.cancel("user-a", workflow.id);
      await expect(authority.result("user-a", { actionId: request.actionId, workerId: "worker-a", status: "succeeded", output: "contents", changedResources: [] })).rejects.toThrow("stale or unauthorized");
    } finally {
      await persistence.close();
    }
  });

  it("allows an authenticated desktop transport to consume only issued actions for its bound worker", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const server = new CodeForgeCloudServer({
      db: new SQLiteCloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: JWT_SECRET,
      stripeConfig: null,
      sessionPersistence: persistence,
    });
    const port = await server.start(0);
    const request = async (userId: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${signAccessToken({ sub: userId, sid: "desktop" }, JWT_SECRET)}`, "content-type": "application/json", ...init.headers },
    });

    try {
      const workflow = await server.hostedWorkflowAuthority.create({ ownerUserId: "user-a", workerId: "worker-a", workspaceId: "workspace-a", task: "Inspect fixture" });
      const action = { actionId: "44444444-4444-4444-8444-444444444444", workflowId: workflow.id, turnId: "turn-a", sessionId: workflow.sessionId, workerId: "worker-a", type: "READ_FILE" as const, arguments: { path: "src/a.ts" }, idempotencyKey: "worker-poll-a" };
      await server.hostedWorkflowAuthority.dispatch("user-a", action);
      expect(await (await request("user-a", "/v1/worker/actions?workerId=worker-a")).json()).toEqual([action]);
      expect(await (await request("user-b", "/v1/worker/actions?workerId=worker-a")).json()).toEqual([]);
      const wrongWorker = await request("user-a", "/v1/worker/actions/result", { method: "POST", body: JSON.stringify({ actionId: action.actionId, workerId: "worker-b", status: "succeeded", output: "no", changedResources: [] }) });
      expect(wrongWorker.status).toBe(400);
      const accepted = await request("user-a", "/v1/worker/actions/result", { method: "POST", body: JSON.stringify({ actionId: action.actionId, workerId: "worker-a", status: "succeeded", output: "contents", changedResources: [] }) });
      expect(await accepted.json()).toEqual({ duplicate: false });
      const replayed = await request("user-a", "/v1/worker/actions/result", { method: "POST", body: JSON.stringify({ actionId: action.actionId, workerId: "worker-a", status: "succeeded", output: "ignored", changedResources: [] }) });
      expect(await replayed.json()).toEqual({ duplicate: true });
    } finally {
      await server.stop();
      await persistence.close();
    }
  });
});
