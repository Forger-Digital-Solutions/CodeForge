import { afterEach, describe, expect, it } from "vitest";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { createSessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider, type ChatRequest, type ChatResponse, type StreamEvent } from "@codeforge/providers";
import { createEightBitRouteHealthAuthority, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { FreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";
import { RemoteDirectCloudProviderAdapter, RemoteDirectDevice, type RemoteDirectSessionIdentity, type SignedRemoteDirectAssignment } from "@codeforge/server";
import { createRemoteDirectHost } from "../src/remote-direct-host.js";
import { mintSessionAccessToken } from "./helpers/session-token.js";

const jwtSecret = "r65-dispatch-fixture-jwt-secret-32-chars";
const request: ChatRequest = { model: "kilo-auto/free", messages: [{ role: "user", content: "Inspect a public fixture" }], maxTokens: 64, dispatchId: "fixture-dispatch" };
const response: ChatResponse = { id: "fixture-response", model: "kilo-auto/free", choices: [{ index: 0, message: { role: "assistant", content: "Fixture inspected" }, finishReason: "stop" }], usage: { inputTokens: 4, outputTokens: 2, costUsd: 0 } };
type Delivery = { jobId: string; signed: SignedRemoteDirectAssignment; request: ChatRequest };
type Bootstrap = { identity: RemoteDirectSessionIdentity; secret: string };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const now = new Date().toISOString();
  const firewall = new ForgeZero();
  firewall.setPrivacyMode("MAXIMUM_FREE");
  firewall.register({ ...createGenericFreeRecord({ providerId: "kilo-free-direct", modelId: request.model }), accessClass: "FREE_ROUTED", privacyClass: "permissive" });
  const catalog = new InMemoryProviderCatalog();
  const adapter = createMockProvider({ providerId: "kilo-free-direct" });
  expect(adapter.isTestProvider).toBe(true);
  catalog.register(adapter);
  const health = createEightBitRouteHealthAuthority();
  const source = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
  source.setConnection({ providerId: adapter.providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
  const qualified: ModelQualificationReceipt = {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3", providerId: adapter.providerId, modelId: request.model, modelDisplayName: request.model,
    accessClass: "FREE_ROUTED", freeStatus: "verified_free", startedAt: now, completedAt: now, totalLatencyMs: 1,
    qualificationState: "QUALIFIED", hardFailureRoles: [],
    roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], overallScore: 1, startedAt: now, completedAt: now } },
  };
  await source.recordReceipt(qualified);
  source.setKiloPolicyReceipt({ sourceDocumentation: "https://kilo.ai/docs/gateway/models-and-providers", termsEvidence: "https://kilo.ai/terms",
    priceEvidence: "https://kilo.ai/docs/gateway/usage-and-billing", privacyEvidence: "https://kilo.ai/docs/getting-started/using-kilo-for-free",
    verifiedAt: now, qualificationAt: now, recheckAt: new Date(Date.now() + 86_400_000).toISOString() });
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  const host = createRemoteDirectHost({ cloud: { db: new SQLiteCloudDatabase({ dbPath: ":memory:" }), jwtSecret, stripeConfig: null, logLevel: "silent", sessionPersistence: persistence },
    freeCloud: source, health, privacyForWorkspace: () => ({ dataClass: "PRIVATE_CODE" }) });
  const port = await host.cloud.start(0);
  cleanup.push(async () => { await host.cloud.stop(); await persistence.close(); });
  const tokens = { alice: await mintSessionAccessToken(host.cloud.db, "alice", jwtSecret), bob: await mintSessionAccessToken(host.cloud.db, "bob", jwtSecret) };
  const send = (path: string, body?: unknown, user: keyof typeof tokens = "alice") => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = async (publicCodeConsent?: boolean, workspaceId = "workspace-a") => {
    const created = await send("/v1/workflows", { task: "Public dispatch fixture", workerId: "device-a", workspaceId, ...(publicCodeConsent === undefined ? {} : { publicCodeConsent }) });
    expect(created.status).toBe(201);
    return await created.json() as { id: string; status: string; revision: number };
  };
  const submit = (workflowId: string, input: ChatRequest = request, role = "CODER", user: keyof typeof tokens = "alice") => send(`/v1/workflows/${workflowId}/remote-direct`, { request: input, role }, user);
  const session = async (workspaceId = "workspace-a") => {
    const result = await send("/v1/remote-direct/sessions", { deviceId: "device-a", workspaceId });
    expect(result.status).toBe(201);
    const bootstrap = await result.json() as Bootstrap;
    const device = new RemoteDirectDevice(bootstrap.identity, Buffer.from(bootstrap.secret, "base64url"), () => true);
    return { bootstrap, device, sessionPath: `/v1/remote-direct/sessions/${bootstrap.identity.sessionId}` };
  };
  const deliver = async (workflowId: string) => {
    const submitted = await submit(workflowId);
    expect(submitted.status).toBe(201);
    const { jobId } = await submitted.json() as { jobId: string };
    const worker = await session();
    const polled = await send(`${worker.sessionPath}/poll`, {});
    expect(polled.status).toBe(200);
    const [delivery] = await polled.json() as Delivery[];
    expect(delivery?.jobId).toBe(jobId);
    worker.device.accept(delivery!.signed, delivery!.request);
    return { ...worker, delivery: delivery!, jobId, jobPath: `${worker.sessionPath}/jobs/${jobId}` };
  };
  const cloudAdapter = (workflowId: string) => new RemoteDirectCloudProviderAdapter({ cloudUrl: `http://127.0.0.1:${port}`,
    getAccessToken: () => tokens.alice, workflowId, ownerUserId: "alice" });
  return { host, source, firewall, persistence, send, create, submit, session, deliver, qualified, cloudAdapter };
}

describe("production remote direct dispatch composition", () => {
  it("streams governed tool proposals and usage through the cloud consumer only after authenticated result and feedback settle", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const adapter = f.cloudAdapter(workflow.id);
    await expect(adapter.streamChatWithContext(request, { userId: "bob", role: "CODER" }).next()).rejects.toThrow("REMOTE_RUNTIME_OWNER_REQUIRED");
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
    const events: StreamEvent[] = [];
    const consumed = (async () => {
      for await (const event of adapter.streamChatWithContext(request, { userId: "alice", role: "CODER" })) events.push(event);
    })();
    const outcome = consumed.then(() => undefined, (error: unknown) => error);
    await expect.poll(async () => (await f.persistence.getWorkItemsByKind("remote_direct_job")).length).toBe(1);
    const worker = await f.deliver(workflow.id);
    const assignment = worker.delivery.signed.assignment;
    expect((await f.send(`${worker.jobPath}/ack`, worker.device.acknowledge(assignment.requestId))).status).toBe(200);
    const tool = { id: "fixture-read", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.ts" }) } };
    const proposal: ChatResponse = { ...response, choices: [{ index: 0, message: { role: "assistant", content: "Inspecting fixture", toolCalls: [tool] }, finishReason: "tool_calls" }] };
    expect((await f.send(`${worker.jobPath}/result`, worker.device.signResult({ requestId: assignment.requestId, nonce: assignment.nonce,
      response: proposal, toolExecutionState: "PROPOSED_ONLY" }))).status).toBe(200);
    expect(events).toEqual([]);
    const feedback = worker.device.signFeedback({ ...worker.bootstrap.identity, requestId: assignment.requestId, nonce: assignment.nonce,
      runId: workflow.id, routeId: assignment.routeId, quotaDomainId: assignment.quotaDomainId, provider: "kilo-free-direct", physicalModel: proposal.model,
      status: "success", latencyMs: 1, httpClass: 2, inputTokens: 4, outputTokens: 2, toolCallCount: 1, terminationReason: "completed", timestamp: new Date().toISOString() });
    expect((await f.send(`${worker.jobPath}/feedback`, feedback)).status).toBe(200);
    expect(await outcome).toBeUndefined();
    expect(events).toEqual([
      { type: "text_delta", delta: "Inspecting fixture" },
      { type: "tool_call_started", toolCallId: tool.id, toolName: "read_file" },
      { type: "tool_call_completed", toolCallId: tool.id, toolName: "read_file", arguments: tool.function.arguments },
      { type: "usage", usage: proposal.usage },
      { type: "finish", finishReason: "tool_calls", model: proposal.model },
    ]);
    expect(await f.host.cloud.remoteDirectTransport.status("alice", worker.jobId)).toMatchObject({ state: "settled" });
  });

  it("cancels the cloud consumer's queued assignment on abort without emitting a result", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const adapter = f.cloudAdapter(workflow.id);
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    const consumed = (async () => {
      for await (const event of adapter.streamChatWithContext(request, { userId: "alice", role: "CODER" }, abort.signal)) events.push(event);
    })();
    const outcome = consumed.then(() => undefined, (error: unknown) => error);
    await expect.poll(async () => (await f.persistence.getWorkItemsByKind("remote_direct_job")).length).toBe(1);
    const [job] = await f.persistence.getWorkItemsByKind("remote_direct_job");
    abort.abort();
    const interrupted = await outcome;
    expect(interrupted === undefined || (interrupted instanceof DOMException && interrupted.name === "AbortError")).toBe(true);
    expect(events).toEqual([]);
    expect(await f.host.cloud.remoteDirectTransport.status("alice", job!.id)).toEqual({ state: "cancelled" });
  });

  it("creates an owner-bound task and delivers, acknowledges, records and settles its authenticated assignment", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const worker = await f.deliver(workflow.id);
    expect(worker.delivery.signed.assignment).toMatchObject({ accountId: "alice", deviceId: "device-a", workspaceId: "workspace-a", runId: workflow.id });
    const assignment = worker.delivery.signed.assignment;
    expect((await f.send(`${worker.jobPath}/ack`, worker.device.acknowledge(assignment.requestId))).status).toBe(200);
    expect((await f.send(`${worker.sessionPath}/heartbeat`, {})).status).toBe(200);
    expect((await f.send(`${worker.jobPath}/result`, worker.device.signResult({ requestId: assignment.requestId, nonce: assignment.nonce, response, toolExecutionState: "PROPOSED_ONLY" }))).status).toBe(200);
    const statusPath = `/v1/workflows/${workflow.id}/remote-direct/${worker.jobId}`;
    expect(await (await f.send(statusPath)).json()).toEqual({ state: "result" });
    const feedback = worker.device.signFeedback({ ...worker.bootstrap.identity, requestId: assignment.requestId, nonce: assignment.nonce,
      runId: workflow.id, routeId: assignment.routeId, quotaDomainId: assignment.quotaDomainId, provider: "kilo-free-direct", physicalModel: response.model,
      status: "success", latencyMs: 1, httpClass: 2, inputTokens: 4, outputTokens: 2, toolCallCount: 0, terminationReason: "completed", timestamp: new Date().toISOString() });
    expect((await f.send(`${worker.jobPath}/feedback`, feedback)).status).toBe(200);
    expect(await (await f.send(statusPath)).json()).toMatchObject({ state: "settled", response, feedback: { status: "success" } });
    expect(await f.host.cloud.hostedWorkflowAuthority.get(workflow.id, "alice")).toMatchObject({ status: "active" });
  });

  it("denies a foreign owner, workspace and task without exposing or mutating the issued assignment", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const worker = await f.deliver(workflow.id);
    expect((await f.submit(workflow.id, request, "CODER", "bob")).status).toBe(409);
    expect((await f.submit("missing-task")).status).toBe(409);
    expect((await f.send("/v1/remote-direct/sessions", { deviceId: "device-a", workspaceId: "foreign-workspace" })).status).toBe(409);
    expect((await f.send(`${worker.sessionPath}/poll`, {}, "bob")).status).toBe(409);
    const other = await f.create(true, "workspace-b");
    const wrongWorkspace = await f.session("workspace-b");
    expect(await (await f.send(`${wrongWorkspace.sessionPath}/poll`, {})).json()).toEqual([]);
    const ack = worker.device.acknowledge(worker.delivery.signed.assignment.requestId);
    expect((await f.send(`${wrongWorkspace.sessionPath}/jobs/${worker.jobId}/ack`, ack)).status).toBe(409);
    expect((await f.send(`/v1/workflows/${other.id}/remote-direct/${worker.jobId}`)).status).toBe(404);
    expect((await f.send(`/v1/workflows/${workflow.id}/remote-direct/${worker.jobId}`, undefined, "bob")).status).toBe(404);
    expect(await f.host.cloud.remoteDirectTransport.status("alice", worker.jobId)).toEqual({ state: "delivered" });
  });

  it.each([undefined, false])("denies public inference when public-code consent is %s", async (consent) => {
    const f = await fixture();
    const workflow = await f.create(consent);
    expect((await f.submit(workflow.id)).status).toBe(409);
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
  });

  it("denies unqualified roles and paid models before persisting work", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    expect((await f.submit(workflow.id, request, "REVIEWER")).status).toBe(409);
    expect((await f.submit(workflow.id, { ...request, model: "paid-model" })).status).toBe(409);
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
  });

  it("rejects a route whose free evidence becomes paid and does not leak an assignment", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const record = f.firewall.getModel("kilo-free-direct", request.model)!;
    f.firewall.register({ ...record, freeStatus: "paid", tier: "paid", costProfile: { ...record.costProfile, isFree: false, inputCostPerMillion: 1 } });
    expect((await f.submit(workflow.id)).status).toBe(409);
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
  });

  it("denies stale role qualification despite its recorded QUALIFIED verdict", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const staleAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await f.source.recordReceipt({ ...f.qualified, startedAt: staleAt, completedAt: staleAt });
    expect((await f.submit(workflow.id)).status).toBe(409);
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
  });

  it("denies an expired provider policy before submission", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    f.source.setKiloPolicyReceipt({ sourceDocumentation: "fixture-policy", termsEvidence: "fixture-terms", priceEvidence: "fixture-price", privacyEvidence: "fixture-privacy",
      verifiedAt: new Date().toISOString(), qualificationAt: f.qualified.completedAt, recheckAt: new Date(Date.now() - 1000).toISOString() });
    expect((await f.submit(workflow.id)).status).toBe(409);
    expect(await f.persistence.getWorkItemsByKind("remote_direct_job")).toEqual([]);
  });

  it("rechecks policy admission at delivery and blocks queued work after policy revocation", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const submitted = await f.submit(workflow.id);
    expect(submitted.status).toBe(201);
    const { jobId } = await submitted.json() as { jobId: string };
    const worker = await f.session();
    f.source.setKiloPolicyReceipt(undefined);
    expect(await (await f.send(`${worker.sessionPath}/poll`, {})).json()).toEqual([]);
    expect(await f.host.cloud.remoteDirectTransport.status("alice", jobId)).toEqual({ state: "blocked" });
  });

  it("cancels through the owner endpoint and rejects stale ACK, result, feedback and resubmission monotonically", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const worker = await f.deliver(workflow.id);
    const assignment = worker.delivery.signed.assignment;
    const ack = worker.device.acknowledge(assignment.requestId);
    expect((await f.send(`${worker.jobPath}/ack`, ack)).status).toBe(200);
    const result = worker.device.signResult({ requestId: assignment.requestId, nonce: assignment.nonce, response, toolExecutionState: "PROPOSED_ONLY" });
    const feedback = worker.device.signFeedback({ ...worker.bootstrap.identity, requestId: assignment.requestId, nonce: assignment.nonce,
      runId: workflow.id, routeId: assignment.routeId, quotaDomainId: assignment.quotaDomainId, provider: "kilo-free-direct", physicalModel: response.model,
      status: "success", latencyMs: 1, httpClass: 2, inputTokens: 4, outputTokens: 2, toolCallCount: 0, terminationReason: "completed", timestamp: new Date().toISOString() });
    expect((await f.send(`/v1/workflows/${workflow.id}/cancel`, {}, "bob")).status).toBe(404);
    const cancelled = await f.send(`/v1/workflows/${workflow.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled", revision: workflow.revision + 1 });
    expect((await f.send(`${worker.jobPath}/ack`, ack)).status).toBe(409);
    expect((await f.send(`${worker.jobPath}/result`, result)).status).toBe(409);
    expect((await f.send(`${worker.jobPath}/feedback`, feedback)).status).toBe(409);
    expect((await f.submit(workflow.id, { ...request, dispatchId: "after-cancel" })).status).toBe(409);
    expect(await (await f.send(`/v1/workflows/${workflow.id}/cancel`, {})).json()).toMatchObject({ status: "cancelled", revision: workflow.revision + 1 });
    expect(await f.host.cloud.remoteDirectTransport.status("alice", worker.jobId)).toEqual({ state: "cancelled" });
    const stored = await f.persistence.getWorkItem(worker.jobId);
    expect(stored?.kind).toBe("remote_direct_job");
    if (stored?.kind !== "remote_direct_job") throw new Error("Missing cancelled assignment");
    expect(stored.response).toBeUndefined();
    expect(await (await f.send(`${worker.sessionPath}/poll`, {})).json()).toEqual([]);
  });

  it("does not revive owner-cancelled scope when an already-recorded worker action result is replayed", async () => {
    const f = await fixture();
    const workflow = await f.create(true);
    const action = { actionId: "55555555-5555-4555-8555-555555555555", workflowId: workflow.id, turnId: "turn-fixture", sessionId: workflow.id,
      workerId: "device-a", type: "READ_FILE" as const, arguments: { path: "fixture.ts" }, idempotencyKey: "fixture-worker-read" };
    await f.host.cloud.hostedWorkflowAuthority.dispatch("alice", action);
    const result = { actionId: action.actionId, workerId: "device-a", status: "succeeded", output: "public fixture", changedResources: [] };
    expect((await f.send("/v1/worker/actions/result", result)).status).toBe(200);
    expect((await f.send(`/v1/workflows/${workflow.id}/cancel`, {})).status).toBe(200);
    await f.send("/v1/worker/actions/result", result);
    expect(await (await f.send(`/v1/workflows/${workflow.id}`)).json()).toMatchObject({ status: "cancelled" });
    expect((await f.submit(workflow.id)).status).toBe(409);
    expect((await f.send("/v1/remote-direct/sessions", { deviceId: "device-a", workspaceId: "workspace-a" })).status).toBe(409);
  });
});
