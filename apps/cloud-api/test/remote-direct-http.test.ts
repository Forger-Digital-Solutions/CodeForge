import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { RemoteDirectHttpClient, RemoteDirectProviderAdapter, createAgentRuntime } from "@codeforge/server";
import { CodeForgeCloudServer } from "../src/server.js";
import { mintSessionAccessToken } from "./helpers/session-token.js";

const jwtSecret = "remote-direct-http-fixture-secret-32-chars";
const binding = { accountId: "alice", deviceId: "device-a", workspaceId: "workspace-a", runId: "runtime-a", routeId: "kilo-route-a", quotaDomainId: "kilo-egress-a" };
class TestRemoteProvider extends RemoteDirectProviderAdapter { readonly isTestProvider = true; }

describe("authenticated hosted remote direct HTTP", () => {
  it("serves socket delivery, MAC acknowledgement, result and feedback to the runtime's governed tool broker", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const server = new CodeForgeCloudServer({ db: new SQLiteCloudDatabase({ dbPath: ":memory:" }), jwtSecret,
      stripeConfig: null, logLevel: "silent", sessionPersistence: persistence,
      remoteDirectAdmission: (scope, request) => scope.accountId === binding.accountId && scope.workspaceId === binding.workspaceId
        && scope.quotaDomainId === binding.quotaDomainId && request.model === "kilo-auto/free" });
    const workspace = await mkdtemp(join(tmpdir(), "r63-remote-http-"));
    await writeFile(join(workspace, "fixture.txt"), "remote read evidence");
    const port = await server.start(0);
    const token = await mintSessionAccessToken(server.db, binding.accountId, jwtSecret);
    const url = `http://127.0.0.1:${port}`;
    let providerCalls = 0;
    const client = new RemoteDirectHttpClient({ cloudUrl: url, getAccessToken: () => token,
      deviceId: binding.deviceId, workspaceId: binding.workspaceId, routeAllowed: (assignment) => assignment.quotaDomainId === binding.quotaDomainId,
      providerFetch: (async (endpoint: string | URL | Request, init?: RequestInit) => {
        expect(String(endpoint)).toBe("https://api.kilo.ai/api/gateway/chat/completions");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        providerCalls++;
        const chunk = providerCalls === 1 ? { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read-a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) } }] }, finish_reason: "tool_calls" }] }
          : { choices: [{ index: 0, delta: { content: "Inspected fixture." }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify({ id: "fixture-response", model: "kilo-auto/free", ...chunk })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch });
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "kilo-free-direct", modelId: "kilo-auto/free" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new TestRemoteProvider(server.remoteDirectTransport, (context) => context.userId === binding.accountId ? binding : undefined));
    const eventStore = new EventStore();
    const runtime = createAgentRuntime({ sessionId: binding.runId, persistence, eventStore, firewall, providerCatalog: catalog,
      workspacePath: workspace, userId: binding.accountId, qualificationWaitHorizonMs: 10 });
    try {
      await server.hostedWorkflowAuthority.create({ ownerUserId: binding.accountId, workerId: binding.deviceId, workspaceId: binding.workspaceId, task: "Remote HTTP fixture" });
      await client.connect();
      await runtime.init();
      runtime.setModelSelection({ providerId: "kilo-free-direct", modelId: "kilo-auto/free" });
      const turnId = await runtime.startTurn("Read fixture.txt and report its contents. Do not modify it.");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && providerCalls < 2) {
        await client.tick();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(providerCalls).toBe(2);
      const executions = eventStore.getBySession(binding.runId).filter((event) => event.type === "tool.execution_completed" && event.payload.turnId === turnId);
      expect(executions).toHaveLength(1);
      expect(JSON.stringify(executions)).toContain("read_file");
      expect(JSON.stringify(executions)).toContain("remote read evidence");
      expect(await readFile(join(workspace, "fixture.txt"), "utf8")).toBe("remote read evidence");
      const jobs = await persistence.getWorkItemsByKind("remote_direct_job");
      expect(jobs.filter((job) => job.kind === "remote_direct_job" && job.state === "settled")).toHaveLength(2);
    } finally {
      await client.disconnect();
      await server.stop();
      await persistence.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated bootstrap, wide scope, revoked identity and foreign session polling", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const server = new CodeForgeCloudServer({ db: new SQLiteCloudDatabase({ dbPath: ":memory:" }), jwtSecret,
      stripeConfig: null, logLevel: "silent", sessionPersistence: persistence });
    const port = await server.start(0);
    const url = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${url}/v1/remote-direct/sessions`, { method: "POST", body: "{}" })).status).toBe(401);
      const alice = await mintSessionAccessToken(server.db, "alice", jwtSecret);
      const bob = await mintSessionAccessToken(server.db, "bob", jwtSecret);
      const post = (path: string, token: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post("/v1/remote-direct/sessions", alice, { deviceId: "d", workspaceId: "*" })).status).toBe(409);
      expect((await post("/v1/remote-direct/sessions", alice, { deviceId: "d", workspaceId: "foreign-workspace" })).status).toBe(409);
      await server.hostedWorkflowAuthority.create({ ownerUserId: "alice", workerId: "d", workspaceId: "workspace", task: "Authorized bootstrap fixture" });
      const bootstrap = await post("/v1/remote-direct/sessions", alice, { deviceId: "d", workspaceId: "workspace" });
      expect(bootstrap.status).toBe(201);
      const session = await bootstrap.json() as { identity: { sessionId: string } };
      expect((await post(`/v1/remote-direct/sessions/${session.identity.sessionId}/poll`, bob, {})).status).toBe(409);
      await server.db.revokeAllUserDeviceSessions("alice");
      expect((await post(`/v1/remote-direct/sessions/${session.identity.sessionId}/poll`, alice, {})).status).toBe(401);
      await expect(server.remoteDirectTransport.enqueue(binding, { model: "kilo-auto/free", messages: [{ role: "user", content: "denied" }] }, "unadmitted")).rejects.toThrow("ADMISSION_DENIED");
    } finally { await server.stop(); await persistence.close(); }
  });

  it("cancels a runtime dispatch and aborts device inference on the next authenticated heartbeat", async () => {
    const persistence = createSessionPersistence({ dbPath: ":memory:" });
    const server = new CodeForgeCloudServer({ db: new SQLiteCloudDatabase({ dbPath: ":memory:" }), jwtSecret,
      stripeConfig: null, logLevel: "silent", sessionPersistence: persistence, remoteDirectAdmission: () => true });
    const port = await server.start(0);
    const token = await mintSessionAccessToken(server.db, "alice", jwtSecret);
    let providerStarted = false;
    let providerAborted = false;
    const client = new RemoteDirectHttpClient({ cloudUrl: `http://127.0.0.1:${port}`, getAccessToken: () => token,
      deviceId: binding.deviceId, workspaceId: binding.workspaceId, routeAllowed: () => true,
      providerFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        providerStarted = true;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { providerAborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
        });
      }) as typeof fetch });
    try {
      await server.hostedWorkflowAuthority.create({ ownerUserId: binding.accountId, workerId: binding.deviceId, workspaceId: binding.workspaceId, task: "Cancellation fixture" });
      await client.connect();
      const adapter = new TestRemoteProvider(server.remoteDirectTransport, () => binding);
      const abort = new AbortController();
      const output = (async () => { for await (const _event of adapter.streamChatWithContext({ model: "kilo-auto/free", messages: [{ role: "user", content: "cancel fixture" }] }, { userId: "alice" }, abort.signal)) {} })();
      const deadline = Date.now() + 3_000;
      while ((await persistence.getWorkItemsByKind("remote_direct_job")).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      const tick = client.tick();
      while (!providerStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(providerStarted).toBe(true);
      abort.abort();
      await output;
      await client.heartbeat();
      await tick;
      expect(providerAborted).toBe(true);
      const jobs = await persistence.getWorkItemsByKind("remote_direct_job");
      expect(jobs).toEqual([expect.objectContaining({ state: "cancelled" })]);
      expect(jobs[0]?.kind === "remote_direct_job" && jobs[0].response).toBeUndefined();
    } finally { await client.disconnect(); await server.stop(); await persistence.close(); }
  });
});
