import { afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { LocalKeyEncryptionProvider, SecretEnvelopeService } from "@codeforge/crypto";
import { RemoteDirectTransport } from "../src/remote-direct-transport.js";
import { RemoteDirectDevice, type RemoteDirectAssignment, type RemoteDirectFeedback } from "../src/remote-client-direct.js";

const principal = { accountId: "alice", authSessionId: "auth-a" };
const binding = { accountId: "alice", deviceId: "device-a", workspaceId: "workspace-a", runId: "run-a", routeId: "route-a", quotaDomainId: "domain-a" };
const request = { model: "kilo-auto/free", messages: [{ role: "user" as const, content: "synthetic protocol fixture" }] };
const response = { id: "response", model: "kilo-auto/free", choices: [{ index: 0, message: { role: "assistant" as const, content: "proposal" }, finishReason: "stop" as const }], usage: { inputTokens: 4, outputTokens: 2 } };
const stores: ISessionPersistence[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function fixture() {
  let now = Date.now();
  let admitted = true;
  let authActive = true;
  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  stores.push(persistence);
  await persistence.init();
  const envelope = new SecretEnvelopeService(LocalKeyEncryptionProvider.ephemeral());
  const options = { persistence, envelope, now: () => now, admit: () => admitted, sessionActive: () => authActive, leaseMs: 100, sessionMs: 1_000, maxAttempts: 2 };
  const transport = new RemoteDirectTransport(options);
  const session = await transport.bootstrap(principal, binding);
  const device = new RemoteDirectDevice(session.identity, Buffer.from(session.secret, "base64url"), () => true);
  const jobId = await transport.enqueue(binding, request, "fixture");
  const delivery = (await transport.poll(principal, session.identity.sessionId))[0]!;
  device.accept(delivery.signed, request, now);
  const assignment = delivery.signed.assignment;
  const ack = device.acknowledge(assignment.requestId);
  const result = () => device.signResult({ requestId: assignment.requestId, nonce: assignment.nonce, response, toolExecutionState: "PROPOSED_ONLY" });
  const feedback = (): RemoteDirectFeedback => ({ ...session.identity, requestId: assignment.requestId, nonce: assignment.nonce,
    runId: binding.runId, routeId: binding.routeId, quotaDomainId: binding.quotaDomainId, provider: "kilo-free-direct", physicalModel: response.model,
    status: "success", httpClass: 2, terminationReason: "completed", latencyMs: 10, toolCallCount: 0, timestamp: new Date(now).toISOString(), inputTokens: 4, outputTokens: 2 });
  return { persistence, options, transport, session, device, jobId, delivery, assignment, ack, result, feedback,
    advance: (amount: number) => { now += amount; }, admission: (value: boolean) => { admitted = value; }, auth: (value: boolean) => { authActive = value; } };
}

describe("durable hosted remote direct transport", () => {
  it("bootstraps an encrypted scoped session, redelivers idempotently, and commits one result with feedback", async () => {
    const f = await fixture();
    const persisted = await f.persistence.getWorkItem(f.session.identity.sessionId);
    expect(JSON.stringify(persisted)).not.toContain(f.session.secret);
    expect(persisted).toMatchObject({ secretEnvelope: expect.stringMatching(/^cfe1\./) });
    expect((await f.transport.poll(principal, f.session.identity.sessionId))[0]).toEqual(f.delivery);
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    f.advance(50);
    await f.transport.heartbeat(principal, f.session.identity.sessionId);
    f.advance(75);
    await f.transport.result(principal, f.session.identity.sessionId, f.jobId, f.result());
    expect(await f.transport.status(principal.accountId, f.jobId)).toEqual({ state: "result" });
    await f.transport.feedback(principal, f.session.identity.sessionId, f.jobId, f.device.signFeedback(f.feedback()));
    expect(await f.transport.status(principal.accountId, f.jobId)).toMatchObject({ state: "settled", response });
    expect(await f.transport.enqueue(binding, request, "fixture")).toBe(f.jobId);
    await expect(f.transport.enqueue(binding, { ...request, maxTokens: 10 }, "fixture")).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("recovers after disconnect, rejects the former generation, and accepts only the reconnected owner", async () => {
    const f = await fixture();
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    const stale = f.result();
    f.advance(101);
    const restarted = new RemoteDirectTransport(f.options);
    await restarted.recover();
    expect(await restarted.status(principal.accountId, f.jobId)).toEqual({ state: "queued" });
    const nextSession = await restarted.bootstrap(principal, binding);
    const nextDevice = new RemoteDirectDevice(nextSession.identity, Buffer.from(nextSession.secret, "base64url"), () => true);
    const next = (await restarted.poll(principal, nextSession.identity.sessionId))[0]!;
    expect(next.signed.assignment.requestId).not.toBe(f.assignment.requestId);
    nextDevice.accept(next.signed, request, f.options.now());
    await restarted.acknowledge(principal, nextSession.identity.sessionId, f.jobId, nextDevice.acknowledge(next.signed.assignment.requestId));
    await expect(restarted.result(principal, f.session.identity.sessionId, f.jobId, stale)).rejects.toThrow("STALE");
    await expect(restarted.result(principal, nextSession.identity.sessionId, f.jobId, stale)).rejects.toThrow("INVALID");
    f.advance(101);
    await restarted.recover();
    expect(await restarted.status(principal.accountId, f.jobId)).toEqual({ state: "blocked" });
  });

  it.each(["wrong user", "wrong device", "wrong workspace", "wrong auth session", "forged session"])("rejects %s session and assignment ownership", async (kind) => {
    const f = await fixture();
    const p = kind === "wrong user" ? { ...principal, accountId: "bob" } : kind === "wrong auth session" ? { ...principal, authSessionId: "auth-b" } : principal;
    let id = f.session.identity.sessionId;
    if (kind === "forged session") id = "missing-session";
    if (kind === "wrong device" || kind === "wrong workspace") {
      const foreign = await f.transport.bootstrap(principal, { deviceId: kind === "wrong device" ? "device-b" : binding.deviceId, workspaceId: kind === "wrong workspace" ? "workspace-b" : binding.workspaceId });
      id = foreign.identity.sessionId;
      expect(await f.transport.poll(principal, id)).toEqual([]);
    }
    await expect(f.transport.acknowledge(p, id, f.jobId, f.ack)).rejects.toThrow();
    expect(await f.transport.status(principal.accountId, f.jobId)).toEqual({ state: "delivered" });
  });

  it.each(["forged MAC", "forged assignment", "wrong task", "reused acknowledgement"])("rejects %s without state mutation", async (kind) => {
    const f = await fixture();
    if (kind === "reused acknowledgement") {
      await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
      await expect(f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack)).rejects.toThrow();
      expect((await f.transport.status(principal.accountId, f.jobId)).state).toBe("acknowledged");
    } else {
      if (kind === "forged assignment") {
        const foreign = { ...f.delivery.signed, assignment: { ...f.assignment, runId: "forged" } as RemoteDirectAssignment };
        expect(() => f.device.accept(foreign, request)).toThrow("MAC_INVALID");
      }
      const signed = kind === "forged MAC" ? { ...f.ack, mac: "x".repeat(43) } : { ...f.ack, acknowledgement: { ...f.ack.acknowledgement, requestId: "wrong-task" } };
      await expect(f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, signed)).rejects.toThrow();
      expect((await f.transport.status(principal.accountId, f.jobId)).state).toBe("delivered");
    }
  });

  it.each(["expired session", "expired assignment", "revoked session", "revoked auth", "cancelled"])("rejects results after %s", async (kind) => {
    const f = await fixture();
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    const result = f.result();
    if (kind === "expired session") f.advance(1_001);
    if (kind === "expired assignment") f.advance(120_001);
    if (kind === "revoked session") await f.transport.revoke(principal, f.session.identity.sessionId);
    if (kind === "revoked auth") f.auth(false);
    if (kind === "cancelled") await f.transport.cancel(principal.accountId, f.jobId);
    await expect(f.transport.result(principal, f.session.identity.sessionId, f.jobId, result)).rejects.toThrow();
    expect((await f.persistence.getWorkItem(f.jobId))?.kind === "remote_direct_job").toBe(true);
    expect((await f.transport.status(principal.accountId, f.jobId)).state).not.toBe("settled");
  });

  it("rejects concurrent duplicate result uploads, duplicate feedback, and non-owner feedback", async () => {
    const f = await fixture();
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    const signed = f.result();
    const outcomes = await Promise.allSettled([f.transport.result(principal, f.session.identity.sessionId, f.jobId, signed), f.transport.result(principal, f.session.identity.sessionId, f.jobId, signed)]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const feedback = f.device.signFeedback(f.feedback());
    await expect(f.transport.feedback({ ...principal, accountId: "bob" }, f.session.identity.sessionId, f.jobId, feedback)).rejects.toThrow();
    await f.transport.feedback(principal, f.session.identity.sessionId, f.jobId, feedback);
    await expect(f.transport.feedback(principal, f.session.identity.sessionId, f.jobId, feedback)).rejects.toThrow();
    await expect(f.transport.status("bob", f.jobId)).rejects.toThrow("UNAUTHORIZED");
  });

  it("fails closed on broad workspace scope, revoked admission, and abandoned undelivered jobs", async () => {
    const f = await fixture();
    await expect(f.transport.bootstrap(principal, { deviceId: binding.deviceId, workspaceId: "*" })).rejects.toThrow("SCOPE_INVALID");
    f.admission(false);
    await expect(f.transport.enqueue(binding, request, "denied")).rejects.toThrow("ADMISSION_DENIED");
    f.admission(true);
    const queued = await f.transport.enqueue(binding, request, "abandoned");
    f.advance(600_001);
    expect((await f.transport.status(principal.accountId, queued)).state).toBe("blocked");
  });

  it("rechecks identity at bootstrap and domain admission at delivery", async () => {
    const f = await fixture();
    f.auth(false);
    await expect(f.transport.bootstrap(principal, binding)).rejects.toThrow("UNAUTHORIZED");
    f.auth(true);
    const queued = await f.transport.enqueue(binding, request, "drifted");
    f.admission(false);
    expect(await f.transport.poll(principal, f.session.identity.sessionId)).toEqual([f.delivery]);
    expect((await f.transport.status(principal.accountId, queued)).state).toBe("blocked");
  });

  it("rejects paid reported cost and malformed tool proposals before accepting a result", async () => {
    const f = await fixture();
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    const paid = f.device.signResult({ requestId: f.assignment.requestId, nonce: f.assignment.nonce,
      response: { ...response, usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.1 } }, toolExecutionState: "PROPOSED_ONLY" });
    await expect(f.transport.result(principal, f.session.identity.sessionId, f.jobId, paid)).rejects.toThrow("COST_DENIED");
    const invalid = f.device.signResult({ requestId: f.assignment.requestId, nonce: f.assignment.nonce,
      response: { ...response, choices: [{ ...response.choices[0]!, message: { ...response.choices[0]!.message, toolCalls: [{ bad: "tool" }] } }] }, toolExecutionState: "PROPOSED_ONLY" });
    await expect(f.transport.result(principal, f.session.identity.sessionId, f.jobId, invalid)).rejects.toThrow();
    expect((await f.transport.status(principal.accountId, f.jobId)).state).toBe("acknowledged");
  });

  it("rejects owner-signed accounting inflation and wrong task feedback", async () => {
    const f = await fixture();
    await f.transport.acknowledge(principal, f.session.identity.sessionId, f.jobId, f.ack);
    await f.transport.result(principal, f.session.identity.sessionId, f.jobId, f.result());
    expect(() => f.device.signFeedback({ ...f.feedback(), runId: "wrong-run" })).toThrow("SCOPE_INVALID");
    const inflated = f.device.signFeedback({ ...f.feedback(), inputTokens: 1_000 });
    await expect(f.transport.feedback(principal, f.session.identity.sessionId, f.jobId, inflated)).rejects.toThrow("ACCOUNTING_MISMATCH");
    expect((await f.transport.status(principal.accountId, f.jobId)).state).toBe("result");
  });
});
