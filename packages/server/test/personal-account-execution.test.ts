import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { REVIEWER_PROTOCOL, createFreeFabric, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { ModelExecutionAdapter, type ModelExecutionRequest } from "../src/model-execution-adapter.js";
import { UserIntelligenceRuntimeRegistry, type UserIntelligenceSource } from "../src/user-intelligence.js";
import type { PersonalAccountAuthority, PersonalRoutingPolicy } from "../src/personal-account-policy.js";
import { projectPersonalFreeCapacity } from "../src/personal-free-capacity.js";

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const PRICE = "https://openrouter.ai/api/v1/models";
const KEY = "fixture-personal-execution-secret";
const IDENTITY = "a".repeat(64);
const qualification = (): ModelQualificationReceipt => ({ suiteVersion: "R73_ROLE_QUALIFICATION_V6", providerId: "openrouter", modelId: "model-a", modelDisplayName: "Fixture", accessClass: "API_KEY", freeStatus: "FREE", startedAt: AT, completedAt: AT, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [], metadata: { roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } }, roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT }, REVIEWER: { role: "REVIEWER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT } } });
const policy = (mode: PersonalRoutingPolicy["mode"] = "FREE_PREFERRED"): PersonalRoutingPolicy => ({ mode, paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true });
const authority = (free = false, connectionId = "conn-a"): PersonalAccountAuthority => ({ ownerUserId: "alice", connectionId, providerId: "openrouter", credentialRef: connectionId, credentialFingerprint: createHash("sha256").update(KEY).digest("hex"), accountClass: free ? "FREE_VERIFIED" : "PAID", accountIdentityHash: IDENTITY, quotaScopeVerified: true, quotaDomainId: `openrouter:USER_ACCOUNT:${IDENTITY}`, enabled: true, paidSpendingEnabled: !free, monthlyBudgetCents: free ? undefined : 1, verifiedAt: AT, recheckAt: UNTIL, authState: "ok", modelPricing: [{ modelId: "model-a", inputCostPerMillion: free ? 0 : 1, outputCostPerMillion: free ? 0 : 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE, verifiedAt: AT, recheckAt: UNTIL, tokenOnly: true }], freeAdmissionVerified: free, admissionEvidence: free ? { sourceDocumentation: "https://openrouter.ai/docs/guides/overview/auth/oauth", termsEvidence: "https://openrouter.ai/terms", privacyEvidence: "https://openrouter.ai/privacy", priceEvidence: PRICE, verifiedAt: AT, recheckAt: UNTIL } : undefined, quotaScopeEvidence: { scope: "USER_ACCOUNT", identityHash: IDENTITY, source: "https://openrouter.ai/api/v1/key", verifiedAt: AT, recheckAt: UNTIL }, capacityWindows: [{ unit: "requests", limit: 50, remaining: 50, resetAt: UNTIL, observedAt: AT, authoritative: true, scope: "USER_ACCOUNT", period: "DAILY_RESET" }] });
const source = (free = false, connectionId = "conn-a"): UserIntelligenceSource => ({ sourceId: `source-${connectionId}`, ownerUserId: "alice", providerId: "untrusted-input", protocol: "OPENAI_COMPATIBLE", endpointUrl: "https://openrouter.ai/api/v1", modelId: "model-a", familyId: "fixture", version: "1", credentialRef: connectionId, connectionId, canonicalProviderId: "openrouter", qualification: "QUALIFIED", qualifiedRoles: ["CODER", "REVIEWER"], qualificationEvidence: qualification(), dataPolicy: { privateCode: true, userConsentRequired: true }, pricing: { inputCostPerMillion: free ? 0 : 1, outputCostPerMillion: free ? 0 : 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE }, createdAt: AT, updatedAt: AT });

describe("personal connections execute through the production model adapter and spend guard", () => {
  let persistence: ISessionPersistence;
  let catalog: InMemoryProviderCatalog;
  let firewall: ForgeZero;
  let accounts: Map<string, PersonalAccountAuthority>;
  let routing: PersonalRoutingPolicy | undefined;
  let posts: { url: string; body: string }[];
  let registry: UserIntelligenceRuntimeRegistry;
  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init(); catalog = new InMemoryProviderCatalog(); firewall = new ForgeZero(); accounts = new Map([["conn-a", authority()]]); routing = policy(); posts = [];
    const fetchFn: typeof fetch = async (url, init) => {
      expect(init?.method).toBe("POST");
      posts.push({ url: String(url), body: String(init?.body) });
      return new Response([
        `data: ${JSON.stringify({ model: "model-a", choices: [{ delta: { content: "Reviewed fixture." } }] })}`,
        `data: ${JSON.stringify({ model: "model-a", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}`,
        "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    };
    registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, { get: (owner, ref) => owner === "alice" && accounts.has(ref) ? KEY : undefined }, { fetchFn, personalAccountAuthority: (owner, connection) => owner === "alice" ? accounts.get(connection) : undefined, personalRoutingPolicy: () => routing, now: () => NOW });
  });
  afterEach(async () => { await persistence.close(); });
  const request = (providerId: string, extra: Partial<ModelExecutionRequest> = {}): ModelExecutionRequest => ({ modelSelection: { providerId, modelId: "model-a" }, userId: "alice", role: "REVIEWER", messages: [{ role: "user", content: "Review this public fixture." }], maxTokens: 10, ...extra });

  it("stamps the trusted owner and a unique physical attempt before the budget guard, without upstream metadata", async () => {
    const stored = await registry.put("alice", source());
    const executor = new ModelExecutionAdapter(catalog, firewall);
    const first = await executor.execute(request(stored.providerId));
    const second = await executor.execute(request(stored.providerId));
    expect(first.text).toBe("Reviewed fixture."); expect(second.text).toBe(first.text); expect(posts).toHaveLength(2);
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { ownerUserId: string; connectionId: string; requestId: string; status: string; chargedMicros: number } }[];
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map(item => item.attempt.requestId)).size).toBe(2);
    for (const item of attempts) expect(item.attempt).toMatchObject({ ownerUserId: "alice", connectionId: "conn-a", status: "SETTLED", chargedMicros: 16 });
    expect(posts.every(post => post.url === "https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(posts.every(post => !post.body.includes("personalAccount") && !post.body.includes("alice") && !post.body.includes(KEY))).toBe(true);
  });

  it("sends zero provider requests when Free Only or any explicit spending permission is off", async () => {
    const stored = await registry.put("alice", source()); const executor = new ModelExecutionAdapter(catalog, firewall);
    for (const next of [undefined, policy("FREE_ONLY"), { ...policy(), paidEnabled: false }, { ...policy(), explicitConsent: false }, { ...policy(), limitationsAcknowledged: false }]) {
      routing = next;
      await expect(executor.execute(request(stored.providerId))).rejects.toThrow();
    }
    routing = policy(); accounts.get("conn-a")!.paidSpendingEnabled = false;
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow();
    expect(posts).toEqual([]);
    expect(await persistence.getWorkItemsByKind("personal_account_attempt")).toEqual([]);
  });

  it("fails before the wire for a foreign owner, missing owner, exhausted budget or stale price", async () => {
    const stored = await registry.put("alice", source()); const executor = new ModelExecutionAdapter(catalog, firewall);
    await expect(executor.execute(request(stored.providerId, { userId: "bob" }))).rejects.toThrow();
    await expect(executor.execute(request(stored.providerId, { userId: undefined }))).rejects.toThrow();
    await expect(executor.execute(request(stored.providerId, { maxTokens: 10_000 }))).rejects.toThrow();
    accounts.get("conn-a")!.modelPricing![0]!.recheckAt = new Date(NOW).toISOString();
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow();
    expect(posts).toEqual([]);
  });

  it("routes certified personal Free through ForgeZero and an owner-bound FreeFabric reservation", async () => {
    accounts.set("conn-a", authority(true)); routing = policy("FREE_ONLY"); const stored = await registry.put("alice", source(true));
    const projected = projectPersonalFreeCapacity("alice", registry.rosterCandidates("alice"), (owner, id) => owner === "alice" ? accounts.get(id) : undefined, NOW);
    firewall.register(createGenericFreeRecord({ providerId: stored.providerId, modelId: stored.modelId, displayName: "Fixture" }));
    const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [{ routesForUser: owner => owner === "alice" ? projected.routes : [], poolsForUser: owner => owner === "alice" ? projected.pools : [] }], reservations: new CapacityReservationLedger({ routes: [], pools: [], now: () => NOW }), now: () => NOW });
    let admissions = 0;
    const executor = new ModelExecutionAdapter(catalog, firewall, undefined, undefined, undefined, undefined, (selection, req) => {
      const decision = fabric.decide({ requestId: "production-fixture-a", userId: req.userId!, userIdentities: projected.identities, role: "REVIEWER", dataContext: { dataClass: "PUBLIC_CODE", userConsented: true }, demand: { requests: 1, inputTokens: 1, outputTokens: 10 } });
      if (decision.outcome !== "ADMITTED" || decision.selected?.providerId !== selection.providerId || decision.selected.modelId !== selection.modelId || !decision.selected.reservationId) throw new Error(`PERSONAL_FREE_FABRIC_DENIED ${JSON.stringify(decision.explanation)}`);
      admissions++;
      return { independenceKey: decision.selected.independenceKey! };
    });
    expect((await executor.execute(request(stored.providerId))).text).toBe("Reviewed fixture.");
    expect(admissions).toBeGreaterThan(0); expect(posts).toHaveLength(1);
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_budget"))).toContain('"consumedMicros":0');
  });

  it("does not let certified personal Free bypass the firewall or missing fabric authority", async () => {
    accounts.set("conn-a", authority(true)); routing = policy("FREE_ONLY"); const stored = await registry.put("alice", source(true)); const executor = new ModelExecutionAdapter(catalog, firewall);
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow("PERSONAL_ACCOUNT_FREE_FIREWALL_DENIED");
    firewall.register(createGenericFreeRecord({ providerId: stored.providerId, modelId: stored.modelId, displayName: "Fixture" }));
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow("FREE_FABRIC_AUTHORITY_REQUIRED");
    expect(posts).toEqual([]);
  });

  it("revokes one connection without removing a second same-provider credential or accounting", async () => {
    accounts.set("conn-b", authority(false, "conn-b")); const first = await registry.put("alice", source()); const second = await registry.put("alice", source(false, "conn-b"));
    const executor = new ModelExecutionAdapter(catalog, firewall); accounts.get("conn-a")!.accountClass = "REVOKED";
    await expect(executor.execute(request(first.providerId))).rejects.toThrow();
    expect((await executor.execute(request(second.providerId))).text).toBe("Reviewed fixture.");
    expect(posts).toHaveLength(1);
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { connectionId: string } }[];
    expect(attempts.map(item => item.attempt.connectionId)).toEqual(["conn-b"]);
  });

  it("cannot dispatch an incompatible measured role merely because another role qualified", async () => {
    const coderOnly = source(); coderOnly.qualifiedRoles = ["CODER"]; delete coderOnly.qualificationEvidence!.roleResults.REVIEWER;
    const stored = await registry.put("alice", coderOnly); const executor = new ModelExecutionAdapter(catalog, firewall);
    await expect(executor.execute(request(stored.providerId, { role: "REVIEWER" }))).rejects.toThrow();
    expect(posts).toEqual([]);
  });

  it("binds disclosure to the host-authorized workspace before inference and keeps the path off the wire", async () => {
    const allowed = "G:\\fixture\\public-project";
    accounts.get("conn-a")!.authorizedWorkspacePath = allowed;
    const stored = await registry.put("alice", source()); const executor = new ModelExecutionAdapter(catalog, firewall);
    await expect(executor.execute(request(stored.providerId, { workspacePath: "G:\\fixture\\private-project" }))).rejects.toThrow("PERSONAL_ACCOUNT_WORKSPACE_MISMATCH");
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow("PERSONAL_ACCOUNT_WORKSPACE_MISMATCH");
    expect(posts).toEqual([]);
    expect((await executor.execute(request(stored.providerId, { workspacePath: allowed }))).text).toBe("Reviewed fixture.");
    expect(posts).toHaveLength(1); expect(posts[0]!.body).not.toContain("personalAccountWorkspacePath"); expect(posts[0]!.body).not.toContain("public-project");
    accounts.get("conn-a")!.authorizedWorkspacePath = "G:\\fixture\\newly-authorized-project";
    await expect(executor.execute(request(stored.providerId, { workspacePath: allowed }))).rejects.toThrow("PERSONAL_ACCOUNT_WORKSPACE_MISMATCH");
    expect(posts).toHaveLength(1);
  });

  it("honors a Manual preference changed after a previously executable allowance was produced", async () => {
    const stored = await registry.put("alice", source()); const executor = new ModelExecutionAdapter(catalog, firewall);
    expect(registry.rosterCandidates("alice")[0]!.available).toBe(true);
    accounts.get("conn-a")!.preference = "MANUAL";
    await expect(executor.execute(request(stored.providerId))).rejects.toThrow();
    expect(posts).toEqual([]);
    routing = { ...policy("SPECIFIC_ACCOUNT"), specificConnectionId: "conn-a" };
    expect((await executor.execute(request(stored.providerId))).text).toBe("Reviewed fixture."); expect(posts).toHaveLength(1);
  });
});
