import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { LocalKeyEncryptionProvider, SecretEnvelopeService } from "@codeforge/crypto";
import { sponsorManifestProposal, sponsorManifestSigningBytes, type SignedSponsorManifest } from "@codeforge/forge-zero";
import { SponsorOperatorService, sponsorManifestDigest, type SponsorIndependentVerification, type SponsorOperatorPolicy } from "../src/sponsor-operator-service.js";
import { CodeForgeCloudServer } from "../src/server.js";
import { mintSessionAccessToken } from "./helpers/session-token.js";
import { createServer, RemoteDirectTransport } from "@codeforge/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const initialTime = Date.now();
let now = initialTime;
const at = (offset: number) => new Date(now + offset).toISOString();
const keyPair = generateKeyPairSync("ed25519");
function manifest(sequence = 1, override: Partial<SignedSponsorManifest> = {}): SignedSponsorManifest {
  const fields = {
    manifestVersion: 1 as const, sponsorId: "lab", providerId: "lab-api", offerId: "grant",
    logicalRouteId: "lab-coder", physicalModel: "lab/coder", supplyClass: "PACKAGED_FREE_SPONSORED" as const,
    quotaDomainType: "SPONSOR_POOL" as const, egressMode: "SERVER_SPONSORED" as const, authMode: "PROVIDER_GRANT" as const,
    issuedAt: at(-1000), startsAt: at(-1000), expiresAt: at(86_400_000), sequence, revoked: false,
    quota: [{ unit: "requests" as const, limit: 100, period: "DAILY_RESET" as const }], concurrency: 2,
    zeroUserCost: true as const, zeroCodeForgeMarginalCost: true as const, commercialUse: true as const,
    privacyClass: "PRIVATE_SAFE" as const, trainingUse: "NO" as const, retentionPolicy: "none",
    termsUrl: "https://example.test/terms", termsHash: "a".repeat(64), privacyUrl: "https://example.test/privacy", privacyHash: "b".repeat(64),
    providerEvidence: ["https://example.test/grant"], keyId: "key-1", ...override,
  };
  const { signature: _signature, ...signedFields } = fields as SignedSponsorManifest;
  return { ...signedFields, signature: sign(null, sponsorManifestSigningBytes(signedFields), keyPair.privateKey).toString("base64url") };
}
function verified(m: SignedSponsorManifest): SponsorIndependentVerification {
  const proposal = sponsorManifestProposal(m);
  return {
    manifestSha256: sponsorManifestDigest(m), quotaOwnerId: "fixture-wallet", independenceKey: "fixture-independent-wallet", billingReceiptId: "test-billing", capacityReceiptId: "test-capacity",
    termsHash: m.termsHash, privacyHash: m.privacyHash, verifiedAt: at(-500), expiresAt: at(60 * 60_000),
    model: { modelId: m.physicalModel, displayName: "Test sponsor model", contextWindow: 128000, isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } },
    offer: { ...proposal, status: "PROMOTED", allowedUse: "commercial agents", roles: ["CODER", "REVIEWER"], qualificationReceiptId: "test-qualification", canaryReceiptId: "test-canary", zeroCostReceiptId: "test-grant",
      admissionReceipt: { sourceDocumentation: m.providerEvidence[0]!, termsEvidence: m.termsUrl, privacyEvidence: m.privacyUrl, priceEvidence: m.providerEvidence[0]!, verifiedAt: at(-500), qualificationAt: at(-500), recheckAt: at(60 * 60_000) },
      quota: proposal.quota.map((window) => ({ ...window, authoritative: true })),
    },
  };
}
const request = { model: "lab/coder", maxTokens: 8, messages: [{ role: "user" as const, content: "fixture coding task" }] };
const response = { id: "fixture", model: "lab/coder", choices: [{ index: 0, message: { role: "assistant" as const, content: "fixture result" } }], usage: { inputTokens: 2, outputTokens: 2 } };
const cleanup: Array<() => Promise<void>> = [];
async function setup(overrides: Partial<SponsorOperatorPolicy> = {}, store?: ISessionPersistence, keyDuration = 86_400_000) {
  const persistence = store ?? createSqliteSessionPersistence({ dbPath: ":memory:" });
  const envelopes = new SecretEnvelopeService(LocalKeyEncryptionProvider.ephemeral());
  const execute = vi.fn(async () => response);
  const service = new SponsorOperatorService(persistence, envelopes, {
    isTestProvider: true,
    scopesForUser: (user) => user === "operator" ? [{ providerId: "lab-api", models: ["lab/coder"], maxConcurrency: 2 }] : [],
    verify: async (m) => verified(m), execute, ...overrides,
  }, () => now);
  cleanup.push(async () => { await service.stop(); if (!store) await persistence.close(); });
  await service.init();
  await service.enroll("operator", "lab");
  await service.addKey("operator", "lab", { keyId: "key-1", publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(), validFrom: at(-5000), validUntil: at(keyDuration) });
  return { service, persistence, execute, envelopes };
}
async function admit(service: SponsorOperatorService, m = manifest()) { await service.submitManifest("operator", m); await service.verifyOffer("operator", `lab:${m.offerId}`); }
async function settled(service: SponsorOperatorService, user: string, id: string) {
  let status: unknown;
  await vi.waitFor(async () => { status = await service.jobStatus(user, id); expect((status as { state: string }).state).toMatch(/FINISHED|BLOCKED/); }, { timeout: 5000, interval: 10 });
  return status;
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); now = initialTime; });

describe("production sponsor operator authority (scripted evidence only)", () => {
  it("shares SQLite persistence safely with concurrent authenticated remote session polling", async () => {
    const { service, persistence, envelopes } = await setup();
    const transport = new RemoteDirectTransport({ persistence, envelope: envelopes, admit: () => false, now: () => now });
    const principal = { accountId: "alice", authSessionId: "auth-session" };
    const session = await transport.bootstrap(principal, { deviceId: "device", workspaceId: "workspace" });
    const concurrent = await Promise.allSettled([transport.poll(principal, session.identity.sessionId), service.status("operator")]);
    expect(concurrent.map((result) => result.status), JSON.stringify(concurrent)).toEqual(["fulfilled", "fulfilled"]);
  });
  it("serves authenticated operator enrollment, signed intake, verified dispatch, result isolation and revoke over real HTTP", async () => {
    const secret = "sponsor-fixture-jwt-secret-at-least-32characters";
    const cloud = new CodeForgeCloudServer({ dbPath: ":memory:", jwtSecret: secret, logLevel: "silent", stripeConfig: undefined,
      sponsorOperatorPolicy: { isTestProvider: true, scopesForUser: (user) => user === "operator" ? [{ providerId: "lab-api", models: ["lab/coder"], maxConcurrency: 2 }] : [], verify: async (m) => verified(m), execute: async () => response } });
    cleanup.push(() => cloud.stop());
    const port = await cloud.start(0);
    const token = await mintSessionAccessToken(cloud.db, "operator", secret);
    const alice = await mintSessionAccessToken(cloud.db, "alice", secret);
    const bob = await mintSessionAccessToken(cloud.db, "bob", secret);
    const call = (path: string, value?: unknown, credential = token) => fetch(`http://127.0.0.1:${port}/v1/free-capacity/sponsor/${path}`, {
      method: value === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value),
    });
    expect((await call("operators", { operatorId: "lab" }, "forged")).status).toBe(401);
    expect((await call("operators", { operatorId: "lab" })).status).toBe(201);
    expect((await call("operators/lab/keys", { keyId: "key-1", publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(), validFrom: at(-5000), validUntil: at(86_400_000) })).status).toBe(201);
    expect((await call("manifests", manifest())).status).toBe(202);
    const execution = { offerId: "lab:grant", requestId: "http1", role: "CODER", request };
    expect((await call("execute", execution, alice)).status).toBe(400);
    expect((await call("offers/lab:grant/verify", {})).status).toBe(200);
    expect((await call("execute", execution, alice)).status).toBe(202);
    await vi.waitFor(async () => expect(await (await call("results/http1", undefined, alice)).json()).toMatchObject({ state: "FINISHED" }));
    expect((await call("results/http1", undefined, bob)).status).toBe(404);
    expect((await call("operators/lab/keys/key-1/revoke", {}, alice)).status).toBe(403);
    expect((await call("operators/lab/keys/key-1/revoke", {})).status).toBe(200);
    expect((await call("execute", { ...execution, requestId: "http2" }, alice)).status).toBe(400);
  });

  it("wires admitted sponsor service through CodeForgeServer production Fabric and context-bound adapter", async () => {
    const { service, execute } = await setup();
    await admit(service);
    const workspace = await mkdtemp(join(tmpdir(), "cf-sponsor-runtime-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const server = createServer({ port: 0, dbPath: ":memory:", sponsorCapacitySource: service, localUserId: "alice", useRealRuntime: true, externalTools: { enabled: false } as never });
    cleanup.push(() => server.stop());
    await server.start();
    server.setWorkspace(workspace);
    const fabric = (server as unknown as { freeFabric: import("@codeforge/eight-bit").FreeFabric }).freeFabric;
    const diagnostic = fabric.decide({ requestId: "fixture-probe", userId: "alice", role: "PRIMARY_CODING_AGENT", demand: { requests: 1, inputTokens: 100, outputTokens: 100 } });
    expect(diagnostic.outcome, JSON.stringify(diagnostic)).toBe("ADMITTED");
    fabric.release("fixture-probe");
    const result = await fetch(`http://127.0.0.1:${server.httpPort}/api/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "sponsor-runtime", userId: "bob-spoofed", message: "Reply with the sponsor fixture response", executionMode: "chat" }) });
    expect(result.status).toBe(200);
    await vi.waitFor(async () => {
      const events = await (await fetch(`http://127.0.0.1:${server.httpPort}/api/sessions/sponsor-runtime/events`)).json();
      expect(execute, JSON.stringify(events)).toHaveBeenCalled();
    }, { timeout: 10_000, interval: 25 });
    expect(execute.mock.calls[0]?.[2]).toBe("alice");
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ quotaDomainType: "SPONSOR_POOL", supplyClass: "PACKAGED_FREE_SPONSORED" });
    await service.revoke("operator", "lab", "key-1");
    const second = await fetch(`http://127.0.0.1:${server.httpPort}/api/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "sponsor-runtime-revoked", message: "Reply again", executionMode: "chat" }) });
    expect(second.status).toBe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps authenticated signed offers inert until independent current qualification", async () => {
    const { service, execute } = await setup();
    await service.submitManifest("operator", manifest());
    expect(service.capacityRoutes()).toEqual([]);
    await expect(service.enqueue("alice", "lab:grant", "r1", "CODER", request)).rejects.toThrow("NOT_ADMITTED");
    await service.verifyOffer("operator", "lab:grant");
    expect(service.capacityRoutes()[0]).toMatchObject({ supplyClass: "PACKAGED_FREE_SPONSORED", quotaDomainType: "SPONSOR_POOL", marginalCostToCodeForge: 0 });
    await service.enqueue("alice", "lab:grant", "r1", "CODER", request);
    expect(await settled(service, "alice", "r1")).toMatchObject({ state: "FINISHED", usage: { costState: "UNKNOWN", codeForgeMarginalCostUsd: 0 } });
    await service.enqueue("alice", "lab:grant", "r1", "CODER", request);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(service.enqueue("alice", "lab:grant", "r1", "CODER", { ...request, maxTokens: 9 })).rejects.toThrow("REPLAY_MISMATCH");
    await expect(service.jobStatus("bob", "r1")).rejects.toThrow("NOT_FOUND");
  });

  it("rejects unauthorized identity, forged key/signature, scope and replay", async () => {
    const { service } = await setup();
    await expect(service.enroll("bob", "bob")).rejects.toThrow("NOT_AUTHORIZED");
    await expect(service.addKey("bob", "lab", { keyId: "x", publicKeyPem: keyPair.publicKey.export({ format: "pem", type: "spki" }).toString(), validFrom: at(-1000), validUntil: at(60_000) })).rejects.toThrow("NOT_AUTHORIZED");
    await expect(service.submitManifest("bob", manifest())).rejects.toThrow("UNKNOWN_SIGNER");
    await expect(service.submitManifest("operator", { ...manifest(), concurrency: 10 })).rejects.toThrow("SIGNATURE_INVALID");
    await expect(service.submitManifest("operator", manifest(1, { physicalModel: "lab/other" }))).rejects.toThrow("SCOPE_DENIED");
    await service.submitManifest("operator", manifest());
    await expect(service.submitManifest("operator", manifest())).rejects.toThrow("REPLAY");
    await expect(service.verifyOffer("bob", "lab:grant")).rejects.toThrow("NOT_AUTHORIZED");
  });

  it("fences admission against forged independent receipts and supersession during verification", async () => {
    let verifier: (value: SponsorIndependentVerification) => void = () => undefined;
    const { service } = await setup({ verify: () => new Promise((resolve) => { verifier = resolve; }) });
    await service.submitManifest("operator", manifest());
    const pending = service.verifyOffer("operator", "lab:grant");
    await vi.waitFor(() => expect(verifier.toString()).not.toContain("undefined"));
    await service.submitManifest("operator", manifest(2));
    verifier(verified(manifest()));
    await expect(pending).rejects.toThrow("SUPERSEDED");
    expect(service.capacityRoutes()).toEqual([]);
    const second = service.verifyOffer("operator", "lab:grant");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    verifier({ ...verified(manifest(2)), billingReceiptId: "" });
    await expect(second).rejects.toThrow("EVIDENCE_INVALID");
  });

  it("suspends admitted supply on signer expiry, rotation, revocation and stale verification", async () => {
    const { service } = await setup();
    await admit(service);
    now += 60 * 60_000;
    expect(service.capacityRoutes()).toEqual([]);
    now = initialTime;
    await service.verifyOffer("operator", "lab:grant");
    const next = generateKeyPairSync("ed25519");
    await service.addKey("operator", "lab", { keyId: "key-2", publicKeyPem: next.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: at(-1000), validUntil: at(60_000) }, "key-1");
    expect(service.capacityRoutes()).toEqual([]);
    await expect(service.submitManifest("operator", manifest(2))).rejects.toThrow("UNKNOWN_SIGNER");
    await service.revoke("operator", "lab");
    await expect(service.verifyOffer("operator", "lab:grant")).rejects.toThrow("NOT_AUTHORIZED");
  });

  it("shares allowance across model/offer aliases and never exceeds the funded pool", async () => {
    const { service, execute } = await setup();
    const one = manifest(1, { quota: [{ unit: "requests", limit: 1, period: "DAILY_RESET" }] });
    await admit(service, one);
    await admit(service, manifest(1, { offerId: "alias", quota: one.quota }));
    expect(service.capacityPools()).toHaveLength(1);
    await service.enqueue("alice", "lab:grant", "r1", "CODER", request);
    expect(await settled(service, "alice", "r1")).toMatchObject({ state: "FINISHED" });
    await service.enqueue("bob", "lab:alias", "r2", "CODER", request);
    expect(await settled(service, "bob", "r2")).toMatchObject({ state: "BLOCKED", error: "SPONSOR_ALLOWANCE_EXHAUSTED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses new dispatch when the enrolled signing key expires before the manifest", async () => {
    const { service } = await setup({}, undefined, 60_000);
    await admit(service);
    expect(service.capacityRoutes()).toHaveLength(1);
    now += 60_000;
    expect(service.capacityRoutes()).toHaveLength(0);
    await expect(service.enqueue("alice", "lab:grant", "expired-key", "CODER", request)).rejects.toThrow("NOT_ADMITTED");
  });

  it("stress schedules eight waiting users round robin within one funded slot", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let active = 0;
    let peak = 0;
    const { service } = await setup({ execute: async (_route, _request, user) => {
      order.push(user); active++; peak = Math.max(peak, active);
      if (order.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--; return response;
    } });
    await admit(service, manifest(1, { concurrency: 1 }));
    await service.enqueue("u0", "lab:grant", "u0-0", "CODER", request);
    await vi.waitFor(() => expect(order).toHaveLength(1));
    for (let user = 0; user < 8; user++) for (let turn = user === 0 ? 1 : 0; turn < 8; turn++) await service.enqueue(`u${user}`, "lab:grant", `u${user}-${turn}`, "CODER", request);
    release();
    await vi.waitFor(() => expect(order).toHaveLength(64), { timeout: 10_000, interval: 20 });
    expect(peak).toBe(1);
    for (let index = 0; index < 64; index += 8) expect(new Set(order.slice(index, index + 8)).size).toBe(8);
  });

  it("fences a cancelled dispatch and cannot replay its provider result", async () => {
    const { service } = await setup({ execute: async (_route, _request, _user, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })) });
    await admit(service);
    const provider = service.providerAdapters()[0]!;
    const controller = new AbortController();
    const stream = provider.streamChatWithContext!(request, { userId: "alice" }, controller.signal)[Symbol.asyncIterator]();
    const pending = stream.next();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(await service.status("operator")).toBeDefined();
    const registry = await (service as unknown as { persistence: ISessionPersistence }).persistence.getWorkItem("sponsor-operator-registry:v1");
    expect(registry?.kind === "sponsor_operator_registry" && JSON.parse(registry.stateJson).jobs[0].state).toBe("BLOCKED");
  });

  it("bounds shared concurrency and schedules waiting users ahead of monopolizing user", async () => {
    let release: () => void = () => undefined;
    const users: string[] = [];
    const { service } = await setup({ execute: async (_route, _request, user) => {
      users.push(user);
      if (users.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return response;
    } });
    await admit(service);
    await service.enqueue("alice", "lab:grant", "a1", "CODER", request);
    await vi.waitFor(() => expect(users).toEqual(["alice"]));
    await service.enqueue("alice", "lab:grant", "a2", "CODER", request);
    await service.enqueue("alice", "lab:grant", "a3", "CODER", request);
    await service.enqueue("bob", "lab:grant", "b1", "CODER", request);
    release();
    await settled(service, "alice", "a3");
    expect(users).toEqual(["alice", "bob", "alice", "alice"]);
  });

  it("persists enrollment, audit and encrypted request/results across service restart", async () => {
    const { service, persistence, envelopes } = await setup();
    await admit(service);
    await service.enqueue("alice", "lab:grant", "a1", "CODER", request);
    await settled(service, "alice", "a1");
    await service.stop();
    const restarted = new SponsorOperatorService(persistence, envelopes, { isTestProvider: true, scopesForUser: () => [], verify: async (m) => verified(m), execute: async () => response }, () => now);
    cleanup.push(() => restarted.stop());
    await restarted.init();
    expect(restarted.capacityRoutes()).toHaveLength(1);
    expect(await restarted.jobStatus("alice", "a1")).toMatchObject({ state: "FINISHED" });
    const row = await persistence.getWorkItem("sponsor-operator-registry:v1");
    expect(JSON.stringify(row)).not.toContain("fixture result");
    const events = await persistence.getEvents("sponsor-operator-authority");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ action: "ENROLLED" }), expect.objectContaining({ action: "USAGE_SETTLED" })]));
  });

  it("suspends unhealthy supply and rejects unqualified roles, paid fallback and oversized output", async () => {
    const { service } = await setup({ execute: async () => ({ ...response, usage: { inputTokens: 2, outputTokens: 999 } }) });
    await admit(service);
    await expect(service.enqueue("alice", "lab:grant", "x1", "PLANNER", request)).rejects.toThrow("NOT_ADMITTED");
    await expect(service.enqueue("alice", "lab:grant", "x2", "CODER", { ...request, fallbackModels: ["paid"] })).rejects.toThrow("BOUNDS_REQUIRED");
    await service.enqueue("alice", "lab:grant", "x3", "CODER", request);
    expect(await settled(service, "alice", "x3")).toMatchObject({ state: "BLOCKED", error: "SPONSOR_USAGE_BOUND_EXCEEDED" });
    expect(service.capacityRoutes()).toHaveLength(0);
  });

  it("classifies capacity failure and suspends only the failing sponsor wallet aliases", async () => {
    const { service } = await setup({ execute: async () => { throw Object.assign(new Error("upstream 429 account quota exhausted"), { status: 429 }); } });
    await admit(service);
    await admit(service, manifest(1, { offerId: "alias" }));
    await service.enqueue("alice", "lab:grant", "failure", "CODER", request);
    expect(await settled(service, "alice", "failure")).toMatchObject({ state: "BLOCKED", error: "SPONSOR_RATE_LIMITED_429" });
    expect(service.capacityRoutes()).toEqual([]);
    expect(await service.status("operator")).toMatchObject({ offers: [expect.objectContaining({ reason: "SPONSOR_RATE_LIMITED_429" }), expect.objectContaining({ reason: "SPONSOR_RATE_LIMITED_429" })] });
  });
});
