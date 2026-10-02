import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EightBitRouteHealthAuthority } from "@codeforge/eight-bit";
import { RemoteDirectAuthority, RemoteDirectDevice, type RemoteDirectAssignment, type RemoteDirectFeedback } from "../src/remote-client-direct.js";

const now = Date.parse("2026-10-01T20:00:00Z");
const request = { messages: [{ role: "user", content: "public synthetic task" }], maxTokens: 32 };

function feedback(a: RemoteDirectAssignment, status: RemoteDirectFeedback["status"]): RemoteDirectFeedback {
  return {
    requestId: a.requestId, runId: a.runId, routeId: a.routeId, quotaDomainId: a.quotaDomainId,
    provider: a.provider, physicalModel: "stealth/space-bunny-alpha", status, latencyMs: 100,
    httpClass: status === "rate_limited" ? 4 : 2, toolCallCount: 0,
    terminationReason: status === "rate_limited" ? "provider_rate_limit" : "completed",
    timestamp: new Date(now + 1_000).toISOString(), accountId: a.accountId,
    deviceId: a.deviceId, sessionId: a.sessionId, workspaceId: a.workspaceId, nonce: a.nonce,
  };
}

describe("remote client-direct assignment and feedback", () => {
  it("binds account, device, workspace, request, stream order, and feedback to a session", () => {
    const authority = new RemoteDirectAuthority();
    const alice = { accountId: "alice", deviceId: "a-device", sessionId: "a-session", workspaceId: "a-public" };
    const bob = { accountId: "bob", deviceId: "b-device", sessionId: "b-session", workspaceId: "b-public" };
    const aKey = randomBytes(32);
    const bKey = randomBytes(32);
    authority.registerSession(alice, aKey);
    authority.registerSession(bob, bKey);
    const aDevice = new RemoteDirectDevice(alice, aKey, () => true);
    const bDevice = new RemoteDirectDevice(bob, bKey, () => true);
    const a = authority.issue(alice.sessionId, { runId: "run-a", routeId: "kilo-a", quotaDomainId: "ip-a", model: "kilo-auto/free", request }, now);
    const b = authority.issue(bob.sessionId, { runId: "run-b", routeId: "kilo-b", quotaDomainId: "ip-b", model: "kilo-auto/free", request }, now);

    expect(() => bDevice.accept(a, request, now)).toThrow("MAC_INVALID");
    expect(() => aDevice.accept(a, { ...request, maxTokens: 64 }, now)).toThrow("POLICY_DENIED");
    const signal = aDevice.accept(a, request, now);
    expect(() => aDevice.accept(a, request, now)).toThrow("REPLAY");
    bDevice.accept(b, request, now);
    const delta = aDevice.signFrame({ requestId: a.assignment.requestId, sequence: 0, kind: "content_delta", payload: "hi" });
    expect(() => authority.acceptFrame(delta, now)).toThrow("FRAME_INVALID");
    const ack = aDevice.acknowledge(a.assignment.requestId);
    authority.acceptAcknowledgement(ack, now);
    expect(() => authority.acceptAcknowledgement(ack, now)).toThrow("ACKNOWLEDGEMENT_INVALID");
    authority.acceptAcknowledgement(bDevice.acknowledge(b.assignment.requestId), now);
    expect(authority.acceptFrame(delta, now).payload).toBe("hi");
    expect(() => authority.acceptFrame(delta, now)).toThrow("FRAME_INVALID");
    aDevice.cancel(a.assignment.requestId);
    expect(signal.aborted).toBe(true);

    const a429 = aDevice.signFeedback(feedback(a.assignment, "rate_limited"));
    const bSuccess = bDevice.signFeedback(feedback(b.assignment, "success"));
    const health = new EightBitRouteHealthAuthority(undefined, () => now + 1_000);
    expect(authority.acceptAndObserveFeedback(a429, health, now + 1_000).quotaDomainId).toBe("ip-a");
    expect(authority.acceptAndObserveFeedback(bSuccess, health, now + 1_000).quotaDomainId).toBe("ip-b");
    expect(health.assess("kilo-free-direct", "kilo-auto/free", { quotaDomainId: "ip-a", now: now + 1_000 }).hardExclude).toBe(true);
    expect(health.assess("kilo-free-direct", "kilo-auto/free", { quotaDomainId: "ip-b", now: now + 1_000 }).hardExclude).toBe(false);
    expect(() => authority.acceptFeedback(a429, now + 1_000)).toThrow("REPLAY");
  });

  it("rejects tampering and missing local workspace consent", () => {
    const authority = new RemoteDirectAuthority();
    const identity = { accountId: "alice", deviceId: "device", sessionId: "session", workspaceId: "private" };
    const key = randomBytes(32);
    authority.registerSession(identity, key);
    const device = new RemoteDirectDevice(identity, key, () => false);
    const signed = authority.issue(identity.sessionId, { runId: "run", routeId: "route", quotaDomainId: "ip", model: "kilo-auto/free", request }, now);
    expect(() => device.accept(signed, request, now)).toThrow("LOCAL_ROUTE_DENIED");
    expect(() => device.accept({ ...signed, assignment: { ...signed.assignment, endpoint: "https://other.example/" as typeof signed.assignment.endpoint } }, request, now)).toThrow("MAC_INVALID");
    expect(() => device.accept(signed, request, now + 120_000)).toThrow("POLICY_DENIED");
    expect(authority.expire(signed.assignment.requestId)?.quotaDomainId).toBe("ip");
    expect(authority.expire(signed.assignment.requestId)).toBeUndefined();
  });

  it("rejects forged, expired, wrong-session and revoked acknowledgements before settlement", () => {
    const authority = new RemoteDirectAuthority();
    const identity = { accountId: "alice", deviceId: "device", sessionId: "session", workspaceId: "public" };
    const key = randomBytes(32);
    authority.registerSession(identity, key);
    const device = new RemoteDirectDevice(identity, key, () => true);
    const signed = authority.issue(identity.sessionId, { runId: "run", routeId: "route", quotaDomainId: "ip", model: "kilo-auto/free", request }, now);
    device.accept(signed, request, now);
    const ack = device.acknowledge(signed.assignment.requestId);
    expect(() => authority.acceptAcknowledgement({ ...ack, acknowledgement: { ...ack.acknowledgement, sessionId: "other" } }, now)).toThrow("ACKNOWLEDGEMENT_INVALID");
    expect(() => authority.acceptAcknowledgement({ ...ack, mac: "forged" }, now)).toThrow("ACKNOWLEDGEMENT_INVALID");
    expect(() => authority.acceptAcknowledgement(ack, now + 120_000)).toThrow("ACKNOWLEDGEMENT_INVALID");
    authority.revokeSession(identity.sessionId);
    expect(() => authority.acceptAcknowledgement(ack, now)).toThrow("ACKNOWLEDGEMENT_INVALID");
    expect(() => authority.issue(identity.sessionId, { runId: "run", routeId: "route", quotaDomainId: "ip", model: "kilo-auto/free", request }, now)).toThrow("SESSION_UNKNOWN");
    expect(() => authority.registerSession(identity, key)).not.toThrow();
  });

  it("refuses empty scopes and duplicate session registration", () => {
    const authority = new RemoteDirectAuthority();
    const identity = { accountId: "alice", deviceId: "device", sessionId: "session", workspaceId: "public" };
    const key = randomBytes(32);
    authority.registerSession(identity, key);
    expect(() => authority.registerSession(identity, randomBytes(32))).toThrow("IDENTITY_INVALID");
    expect(() => authority.issue(identity.sessionId, { runId: "", routeId: "route", quotaDomainId: "ip", model: "kilo-auto/free", request }, now)).toThrow("SCOPE_INVALID");
  });
});
