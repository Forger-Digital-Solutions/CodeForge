import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import { SQLiteCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import type { ProviderAdapter, StreamEvent, ChatRequest } from "@codeforge/providers";
import { CodeForgeCloudServer } from "../src/index.js";
import { loginToCloud } from "../../../tests/helpers/cloud-login.js";

const FREE_MODEL = createGenericFreeRecord();

/** Durable store with per-operation failure switches — proves the queue fails closed, never fabricates. */
class InjectableDb extends SQLiteCloudDatabase {
  failEnqueue = false;
  failComplete = false;
  failRenew = false;
  override async enqueueHostedExecution(params: Parameters<ICloudDatabase["enqueueHostedExecution"]>[0]) {
    if (this.failEnqueue) throw new Error("injected enqueue failure");
    return super.enqueueHostedExecution(params);
  }
  override async completeHostedExecution(params: Parameters<ICloudDatabase["completeHostedExecution"]>[0]) {
    if (this.failComplete) throw new Error("injected completion write failure");
    return super.completeHostedExecution(params);
  }
  override async renewHostedExecutionLease(params: Parameters<ICloudDatabase["renewHostedExecutionLease"]>[0]) {
    if (this.failRenew) throw new Error("injected heartbeat failure");
    return super.renewHostedExecutionLease(params);
  }
}

class MockHostedProvider implements ProviderAdapter {
  readonly providerId = FREE_MODEL.providerId;
  readonly isTestProvider = true;
  calls = 0;
  peakConcurrent = 0;
  private inFlight = 0;
  constructor(private readonly holdUntilAbort = false) {}
  async *streamChat(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.calls++;
    this.inFlight++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.inFlight);
    try {
      if (this.holdUntilAbort) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return;
      }
      yield { type: "text_delta", delta: "DURABLE_HOSTED_OK" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", finishReason: "stop" };
    } finally {
      this.inFlight--;
    }
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const mockGitHubFetch = (): typeof fetch => {
  let counter = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const s = url.toString();
    if (s.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: `gho_mock_${++counter}`, token_type: "bearer" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (s.includes("api.github.com/user")) {
      const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      const id = 777 + (Number(token.match(/gho_mock_(\d+)/)?.[1]) || 0);
      return new Response(JSON.stringify({ id, login: `exec_user_${id}`, email: `e${id}@example.com` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
};

/** Fixed GitHub identity — the same user must resolve across a server restart. */
const fixedGitHubFetch = (id: number): typeof fetch =>
  (async (url: string | URL | Request) => {
    const s = url.toString();
    if (s.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_fixed", token_type: "bearer" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (s.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ id, login: `exec_user_${id}`, email: `e${id}@example.com` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

const inferenceBody = (requestId: string) => JSON.stringify({ requestId, messages: [{ role: "user", content: "hi" }], modelId: "auto", taskType: "coding" });
const post = (baseUrl: string, token: string, body: string, accept = "application/json") =>
  fetch(`${baseUrl}/v1/hosted/inference`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: accept }, body });

async function waitForStatus(baseUrl: string, token: string, executionId: string, statuses: string[], timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/v1/hosted/executions/${executionId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 200) {
      const body = await res.json();
      if (statuses.includes(body.status)) return body;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`execution ${executionId} did not reach ${statuses.join("|")}`);
}

describe("Durable hosted executions over HTTP", () => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;
  let provider: MockHostedProvider;

  const boot = async (holdUntilAbort = false, db?: InjectableDb) => {
    provider = new MockHostedProvider(holdUntilAbort);
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn: mockGitHubFetch(),
      stripeConfig: { secretKey: "sk_test_1", webhookSecret: "whsec_1", proPriceId: "price_pro", creditPackPriceId: "price_credits" },
      hostedRuntime: { heartbeatMs: 20, idleWaitMs: 10, reconcileMs: 1_000 },
      ...(db ? { db } : {}),
    });
    server.firewallManager.registerModel(FREE_MODEL);
    server.firewallManager.providerCatalog.register(provider);
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  };

  afterEach(async () => {
    await server.stop();
  });

  it("persists, executes via the worker, and returns an owner-scoped result", async () => {
    await boot();
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const enqueued = await post(baseUrl, accessToken, inferenceBody(randomUUID()));
    expect(enqueued.status).toBe(202);
    const { executionId, status, created } = await enqueued.json();
    expect(created).toBe(true);
    expect(["queued", "claimed", "dispatching", "completed"]).toContain(status);

    const terminal = await waitForStatus(baseUrl, accessToken, executionId, ["completed"]);
    expect(terminal.status).toBe("completed");
    expect(terminal.terminalAt).toBeTruthy();
    expect(terminal.leaseToken).toBeUndefined();

    const resultRes = await fetch(`${baseUrl}/v1/hosted/executions/${executionId}/result`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(resultRes.status).toBe(200);
    const result = await resultRes.json();
    expect(result.result.outcome.fullText).toBe("DURABLE_HOSTED_OK");
    expect(result.result.events.map((e: { type: string }) => e.type)).toContain("turn.completed");
    expect(provider.calls).toBe(1);
  });

  it("returns the same durable execution for an idempotent replay", async () => {
    await boot();
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const requestId = randomUUID();
    const first = await (await post(baseUrl, accessToken, inferenceBody(requestId))).json();
    const replay = await post(baseUrl, accessToken, inferenceBody(requestId));
    expect(replay.status).toBe(200);
    const second = await replay.json();
    expect(second.created).toBe(false);
    expect(second.executionId).toBe(first.executionId);
    await waitForStatus(baseUrl, accessToken, first.executionId, ["completed"]);
    const list = await (await fetch(`${baseUrl}/v1/hosted/executions`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
    expect(list).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it("isolates status, result, and cancellation across users", async () => {
    await boot();
    const alice = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const bob = await loginToCloud(baseUrl, { loopbackPort: 8766 });
    const enqueued = await (await post(baseUrl, alice.accessToken, inferenceBody(randomUUID()))).json();
    for (const route of [`${baseUrl}/v1/hosted/executions/${enqueued.executionId}`, `${baseUrl}/v1/hosted/executions/${enqueued.executionId}/result`]) {
      const res = await fetch(route, { headers: { Authorization: `Bearer ${bob.accessToken}` } });
      expect(res.status).toBe(404);
    }
    const cancelRes = await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${bob.accessToken}` } });
    expect(cancelRes.status).toBe(404);
    const bobList = await (await fetch(`${baseUrl}/v1/hosted/executions`, { headers: { Authorization: `Bearer ${bob.accessToken}` } })).json();
    expect(bobList).toHaveLength(0);
  });

  it("cancels a queued execution without ever calling the provider", async () => {
    await boot();
    // Zero ceiling: the execution persists but no worker may claim it.
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 0 });
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const enqueued = await (await post(baseUrl, accessToken, inferenceBody(randomUUID()))).json();
    expect(enqueued.status).toBe("queued");
    const cancel = await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).status).toBe("cancelled");
    // Give the worker loop time to prove it never dispatches a cancelled record.
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.calls).toBe(0);
    const result = await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}/result`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe("cancelled");
  });

  it("cancels a dispatching execution and aborts the in-flight provider call", async () => {
    await boot(true);
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const enqueued = await (await post(baseUrl, accessToken, inferenceBody(randomUUID()))).json();
    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["dispatching"]);
    const cancel = await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
    expect((await cancel.json()).status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 300));
    const status = await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["cancelled"]);
    expect(status.status).toBe("cancelled");
    expect((await server.db.getHostedAdmissionMetrics()).activeReservations).toBe(0);
  });

  it("holds the route capacity ceiling under a concurrent HTTP burst", async () => {
    await boot();
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const burst = await Promise.all(Array.from({ length: 6 }, () => post(baseUrl, accessToken, inferenceBody(randomUUID())).then((r) => r.json())));
    const ids = burst.map((b) => b.executionId);
    expect(new Set(ids).size).toBe(6);
    await Promise.all(ids.map((id) => waitForStatus(baseUrl, accessToken, id, ["completed", "failed"], 15_000)));
    // Route ceiling defaults to 1 — the burst must serialize, never overlap provider calls.
    expect(provider.peakConcurrent).toBe(1);
    expect(provider.calls).toBe(6);
  });

  it("fails closed when the durable enqueue write throws — no execution, no provider call", async () => {
    const db = new InjectableDb();
    await boot(false, db);
    db.failEnqueue = true;
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const headers = { Authorization: `Bearer ${accessToken}` };

    const json = await post(baseUrl, accessToken, inferenceBody(randomUUID()));
    expect(json.status).toBe(500);
    const sse = await post(baseUrl, accessToken, inferenceBody(randomUUID()), "text/event-stream");
    expect((await sse.text())).toContain("turn.failed");

    const list = await (await fetch(`${baseUrl}/v1/hosted/executions`, { headers })).json();
    expect(list).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.calls).toBe(0);
  });

  it("quarantines worker-completed work when the completion write fails — recovered once, never re-executed", async () => {
    const db = new InjectableDb();
    await boot(false, db);
    // Fail the terminalizing write BEFORE the request: the provider runs, the record stays live.
    db.failComplete = true;
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const headers = { Authorization: `Bearer ${accessToken}` };
    const enqueued = await (await post(baseUrl, accessToken, inferenceBody(randomUUID()))).json();

    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["dispatching"]);
    await new Promise((r) => setTimeout(r, 300));
    const mid = await (await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}`, { headers })).json();
    expect(mid.status).toBe("dispatching");
    expect(provider.calls).toBe(1);

    db.failComplete = false;
    await server.hostedRuntime.reconcile(new Date(Date.now() + 120_000));
    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["recovery_pending"]);
    const resolved = await server.hostedRuntime.authority.resolveRecoveryPending(enqueued.executionId);
    expect(resolved.transitioned).toBe(true);
    const terminal = await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["failed"]);
    expect(terminal.resultError).toContain("dispatch outcome ambiguous");
    // Exactly-once: the ambiguous dispatch is never re-run against the provider.
    expect(provider.calls).toBe(1);
  });

  it("aborts in-flight dispatch when the heartbeat write fails — dead lease is fenced, recovery terminalizes once", async () => {
    const db = new InjectableDb();
    await boot(true, db);
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const enqueued = await (await post(baseUrl, accessToken, inferenceBody(randomUUID()))).json();
    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["dispatching"]);

    db.failRenew = true;
    await new Promise((r) => setTimeout(r, 200));
    // The abort is in-process only — the durable record stays dispatching until recovery.
    const mid = await (await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}`, { headers: { Authorization: `Bearer ${accessToken}` } })).json();
    expect(mid.status).toBe("dispatching");
    expect(provider.calls).toBe(1);

    await server.hostedRuntime.reconcile(new Date(Date.now() + 120_000));
    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["recovery_pending"]);
    const resolved = await server.hostedRuntime.authority.resolveRecoveryPending(enqueued.executionId);
    expect(resolved.transitioned).toBe(true);
    await waitForStatus(baseUrl, accessToken, enqueued.executionId, ["failed"]);
    expect(provider.calls).toBe(1);
  });

  it("recovers queued work after a full server restart — the execution outlives the process", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbPath = join(mkdtempSync(join(tmpdir(), "cf-hosted-restart-")), "cloud.db");
    const fetchFn = fixedGitHubFetch(901);

    // Boot 1: capacity ceiling zero — the row persists but no worker may claim it.
    provider = new MockHostedProvider();
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn,
      dbPath,
      stripeConfig: null,
      hostedRuntime: { idleWaitMs: 10 },
    });
    server.firewallManager.registerModel(FREE_MODEL);
    server.firewallManager.providerCatalog.register(provider);
    const port1 = await server.start(0);
    const url1 = `http://127.0.0.1:${port1}`;
    const session1 = await loginToCloud(url1, { loopbackPort: 8765 });
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 0 });
    const enqueued = await (await post(url1, session1.accessToken, inferenceBody(randomUUID()))).json();
    expect(enqueued.status).toBe("queued");
    await server.stop();
    expect(provider.calls).toBe(0);

    // Boot 2: a fresh process over the same durable store — the worker picks the row up.
    provider = new MockHostedProvider();
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn,
      dbPath,
      stripeConfig: null,
      hostedRuntime: { heartbeatMs: 20, idleWaitMs: 10 },
    });
    server.firewallManager.registerModel(FREE_MODEL);
    server.firewallManager.providerCatalog.register(provider);
    const port2 = await server.start(0);
    baseUrl = `http://127.0.0.1:${port2}`;
    // The zero ceiling is durable state — lift it so the restarted worker may claim the row.
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 1 });
    const session2 = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    expect(session2.user.id).toBe(session1.user.id);

    const terminal = await waitForStatus(baseUrl, session2.accessToken, enqueued.executionId, ["completed"]);
    expect(terminal.status).toBe("completed");
    const result = await (await fetch(`${baseUrl}/v1/hosted/executions/${enqueued.executionId}/result`, { headers: { Authorization: `Bearer ${session2.accessToken}` } })).json();
    expect(result.result.outcome.fullText).toBe("DURABLE_HOSTED_OK");
    expect(provider.calls).toBe(1);
  });

  it("quarantines mid-dispatch work after a hard stop — restart recovers once, never re-executes", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dbPath = join(mkdtempSync(join(tmpdir(), "cf-hosted-crash-")), "cloud.db");
    const fetchFn = fixedGitHubFetch(902);

    provider = new MockHostedProvider(true);
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn,
      dbPath,
      stripeConfig: null,
      hostedRuntime: { leaseMs: 200, heartbeatMs: 20, idleWaitMs: 10 },
    });
    server.firewallManager.registerModel(FREE_MODEL);
    server.firewallManager.providerCatalog.register(provider);
    const port1 = await server.start(0);
    const url1 = `http://127.0.0.1:${port1}`;
    const session1 = await loginToCloud(url1, { loopbackPort: 8765 });
    const enqueued = await (await post(url1, session1.accessToken, inferenceBody(randomUUID()))).json();
    await waitForStatus(url1, session1.accessToken, enqueued.executionId, ["dispatching"]);
    expect(provider.calls).toBe(1);
    // stop() aborts the in-flight provider call — the durable record stays dispatching.
    await server.stop();

    provider = new MockHostedProvider();
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn,
      dbPath,
      stripeConfig: null,
      hostedRuntime: { heartbeatMs: 20, idleWaitMs: 10 },
    });
    server.firewallManager.registerModel(FREE_MODEL);
    server.firewallManager.providerCatalog.register(provider);
    const port2 = await server.start(0);
    baseUrl = `http://127.0.0.1:${port2}`;
    const session2 = await loginToCloud(baseUrl, { loopbackPort: 8765 });

    // Lease already expired during the down window — startup reconcile quarantines the ambiguity.
    await server.hostedRuntime.reconcile(new Date(Date.now() + 120_000));
    await waitForStatus(baseUrl, session2.accessToken, enqueued.executionId, ["recovery_pending"]);
    const resolved = await server.hostedRuntime.authority.resolveRecoveryPending(enqueued.executionId);
    expect(resolved.transitioned).toBe(true);
    const terminal = await waitForStatus(baseUrl, session2.accessToken, enqueued.executionId, ["failed"]);
    expect(terminal.resultError).toContain("dispatch outcome ambiguous");
    expect(provider.calls).toBe(0);
  });

  it("executes durable parent/child fan-out — idempotent child, root inheritance, cross-user fence", async () => {
    await boot();
    // Zero ceiling while the tree is built — a completed parent rejects new children (fail closed).
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 0 });
    const alice = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const bob = await loginToCloud(baseUrl, { loopbackPort: 8766 });
    const headers = { Authorization: `Bearer ${alice.accessToken}`, "Content-Type": "application/json" };

    const parent = await (await post(baseUrl, alice.accessToken, inferenceBody(randomUUID()))).json();
    const childRequest = inferenceBody(randomUUID());
    const child = await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { method: "POST", headers, body: childRequest });
    expect(child.status).toBe(202);
    const childBody = await child.json();
    expect(childBody.parentExecutionId).toBe(parent.executionId);
    expect(childBody.rootExecutionId).toBe(parent.executionId);

    // Retry with the same requestId replays the durable child — never a duplicate.
    const retry = await (await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { method: "POST", headers, body: childRequest })).json();
    expect(retry.created).toBe(false);
    expect(retry.executionId).toBe(childBody.executionId);

    // A grandchild inherits the root, not the immediate parent.
    const grandchild = await (await fetch(`${baseUrl}/v1/hosted/executions/${childBody.executionId}/children`, { method: "POST", headers, body: inferenceBody(randomUUID()) })).json();
    expect(grandchild.parentExecutionId).toBe(childBody.executionId);
    expect(grandchild.rootExecutionId).toBe(parent.executionId);

    // Cross-user: Bob can neither list nor attach to Alice's tree.
    const bobHeaders = { Authorization: `Bearer ${bob.accessToken}`, "Content-Type": "application/json" };
    expect((await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { headers: bobHeaders })).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { method: "POST", headers: bobHeaders, body: inferenceBody(randomUUID()) })).status).toBe(404);

    // Attaching to a terminal parent is a 409 — fail closed, no orphan re-rooting.
    const done = await (await post(baseUrl, alice.accessToken, inferenceBody(randomUUID()))).json();
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 1 });
    await waitForStatus(baseUrl, alice.accessToken, done.executionId, ["completed"]);
    expect((await fetch(`${baseUrl}/v1/hosted/executions/${done.executionId}/children`, { method: "POST", headers, body: inferenceBody(randomUUID()) })).status).toBe(409);

    for (const id of [parent.executionId, childBody.executionId, grandchild.executionId]) {
      await waitForStatus(baseUrl, alice.accessToken, id, ["completed"]);
    }
    const children = await (await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { headers })).json();
    expect(children).toHaveLength(1);
    expect(children[0].executionId).toBe(childBody.executionId);
    expect(provider.calls).toBe(4);
  });

  it("cancelling a parent over HTTP cascades to its queued children without provider calls", async () => {
    await boot();
    await server.db.setHostedProviderCapacity({ providerId: FREE_MODEL.providerId, modelId: FREE_MODEL.modelId, maxConcurrent: 0 });
    const { accessToken } = await loginToCloud(baseUrl, { loopbackPort: 8765 });
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

    const parent = await (await post(baseUrl, accessToken, inferenceBody(randomUUID()))).json();
    const child = await (await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/children`, { method: "POST", headers, body: inferenceBody(randomUUID()) })).json();

    const cancel = await fetch(`${baseUrl}/v1/hosted/executions/${parent.executionId}/cancel`, { method: "POST", headers });
    const cancelled = await cancel.json();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledChildIds).toEqual([child.executionId]);

    const childStatus = await (await fetch(`${baseUrl}/v1/hosted/executions/${child.executionId}`, { headers })).json();
    expect(childStatus.status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.calls).toBe(0);
  });
});
