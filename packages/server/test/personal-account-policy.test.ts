import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, ProviderError, type ChatRequest } from "@codeforge/providers";
import { REVIEWER_PROTOCOL, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { PersonalAccountBudgetGuard, personalAccountDomain, type PersonalAccountAuthority, type PersonalAccountBinding, type PersonalRoutingPolicy } from "../src/personal-account-policy.js";
import { UserIntelligenceRuntimeRegistry, userApiAdapterIdentity, type UserIntelligenceSource } from "../src/user-intelligence.js";

const NOW = Date.parse("2026-10-09T18:00:00Z");
const AT = new Date(NOW).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const KEY = "fixture-personal-secret";
const PRICE = "https://openrouter.ai/api/v1/models";
const binding = (connectionId = "conn-a"): PersonalAccountBinding => ({ ownerUserId: "alice", connectionId, canonicalProviderId: "openrouter", credentialRef: connectionId, modelId: "model-a", pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE } });
const request = (requestId = "request-a", connectionId = "conn-a"): ChatRequest => ({ model: "model-a", messages: [{ role: "user", content: "fixture" }], maxTokens: 10, metadata: { personalAccountRequestId: requestId, personalAccountOwnerUserId: "alice", personalAccountConnectionId: connectionId } });
const paidPolicy = (): PersonalRoutingPolicy => ({ mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true });
const authority = (connectionId = "conn-a"): PersonalAccountAuthority => ({ ownerUserId: "alice", connectionId, providerId: "openrouter", credentialRef: connectionId, credentialFingerprint: createHash("sha256").update(KEY).digest("hex"), accountClass: "PAID", enabled: true, paidSpendingEnabled: true, monthlyBudgetCents: 1, authState: "ok", quotaScopeVerified: true, quotaDomainId: "user:physical-account-a", verifiedAt: AT, recheckAt: UNTIL, modelPricing: [{ modelId: "model-a", inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE, verifiedAt: AT, recheckAt: UNTIL, tokenOnly: true }] });
const qualification = (): ModelQualificationReceipt => ({ suiteVersion: "R73_ROLE_QUALIFICATION_V6", providerId: "openrouter", modelId: "model-a", modelDisplayName: "Fixture", accessClass: "API_KEY", freeStatus: "FREE", startedAt: AT, completedAt: AT, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [], metadata: { roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } }, roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT }, REVIEWER: { role: "REVIEWER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT } } });

describe("personal account runtime admission and durable accounting", () => {
  let persistence: ISessionPersistence;
  let accounts: Map<string, PersonalAccountAuthority>;
  let policy: PersonalRoutingPolicy | undefined;
  let clock: number;
  let guard: PersonalAccountBudgetGuard;
  const makeGuard = () => new PersonalAccountBudgetGuard(persistence, { personalAccountAuthority: (owner, connection) => owner === "alice" ? accounts.get(connection) : undefined, personalRoutingPolicy: () => policy, now: () => clock });
  beforeEach(async () => { persistence = createSessionPersistence({ dbPath: ":memory:" }); await persistence.init(); accounts = new Map([["conn-a", authority()]]); policy = paidPolicy(); clock = NOW; guard = makeGuard(); });
  afterEach(async () => { await persistence.close(); });

  it("defaults paid requests off and requires every explicit permission", async () => {
    policy = undefined;
    expect(guard.eligible(binding())).toBe(false);
    await expect(guard.reserve(binding(), request(), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_PAID_DISABLED" });
    for (const field of ["paidEnabled", "explicitConsent", "limitationsAcknowledged"] as const) { policy = { ...paidPolicy(), [field]: false }; expect(guard.eligible(binding())).toBe(false); }
    policy = { ...paidPolicy(), mode: "FREE_ONLY" }; expect(guard.eligible(binding())).toBe(false);
    policy = { ...paidPolicy(), mode: "SPECIFIC_ACCOUNT", specificConnectionId: "other" }; expect(guard.eligible(binding())).toBe(false);
    policy = paidPolicy(); accounts.get("conn-a")!.paidSpendingEnabled = false; expect(guard.eligible(binding())).toBe(false);
  });

  it("admits an exact zero current certificate under default free-only policy without a paid budget", async () => {
    const account = accounts.get("conn-a")!; account.accountClass = "FREE_VERIFIED"; account.freeAdmissionVerified = true; account.paidSpendingEnabled = false; account.monthlyBudgetCents = undefined;
    account.modelPricing![0]!.inputCostPerMillion = 0; account.modelPricing![0]!.outputCostPerMillion = 0;
    account.admissionEvidence = { sourceDocumentation: "official", termsEvidence: "terms", priceEvidence: "price", privacyEvidence: "privacy", verifiedAt: AT, recheckAt: UNTIL };
    const freeBinding = binding(); freeBinding.pricing.inputCostPerMillion = 0; freeBinding.pricing.outputCostPerMillion = 0; policy = undefined;
    expect(guard.classification(freeBinding)).toBe("FREE_VERIFIED");
    const reservation = await guard.reserve(freeBinding, request(), KEY); await reservation.dispatch(); await reservation.settle({ inputTokens: 2, outputTokens: 3 });
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_budget"))).toContain('"consumedMicros":0');
    account.freeAdmissionVerified = false; expect(guard.eligible(freeBinding)).toBe(false);
  });

  it("rejects expired, revoked, owner-mismatched and rotated credentials", async () => {
    accounts.get("conn-a")!.recheckAt = AT; expect(guard.eligible(binding())).toBe(false);
    accounts.set("conn-a", authority()); accounts.get("conn-a")!.accountClass = "REVOKED"; expect(guard.eligible(binding())).toBe(false);
    accounts.set("conn-a", authority()); accounts.get("conn-a")!.ownerUserId = "bob"; expect(guard.eligible(binding())).toBe(false);
    accounts.set("conn-a", authority()); await expect(guard.reserve(binding(), request(), "other-key")).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_CREDENTIAL_CHANGED" });
    await expect(guard.reserve(binding(), { ...request(), metadata: { personalAccountOwnerUserId: "bob" } }, KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_OWNER_MISMATCH" });
  });

  it("fails closed for stale prices, ancillary fees, price mismatch, missing limits and fallback", async () => {
    accounts.get("conn-a")!.modelPricing![0]!.recheckAt = AT; expect(guard.eligible(binding())).toBe(false);
    accounts.set("conn-a", authority()); accounts.get("conn-a")!.modelPricing![0]!.tokenOnly = false; expect(guard.eligible(binding())).toBe(false);
    accounts.set("conn-a", authority()); const mismatch = binding(); mismatch.pricing.inputCostPerMillion = 0; expect(guard.eligible(mismatch)).toBe(false);
    await expect(guard.reserve(binding(), { ...request(), maxTokens: undefined }, KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_OUTPUT_BOUND_REQUIRED" });
    await expect(guard.reserve(binding(), { ...request(), fallbackModels: ["paid-other-model"] }, KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_FALLBACK_DENIED" });
    accounts.get("conn-a")!.monthlyBudgetCents = undefined; expect(guard.eligible(binding())).toBe(false);
  });

  it("reserves durably, releases only pre-dispatch and never dispatches an attempt twice", async () => {
    const hold = await guard.reserve(binding(), request(), KEY);
    await expect(guard.reserve(binding(), request(), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_ALREADY_RESERVED" });
    await hold.fail();
    const budget = await persistence.getWorkItemsByKind("personal_account_budget"); expect(JSON.stringify(budget)).toContain('"consumedMicros":0');
    await expect(guard.reserve(binding(), request(), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_ALREADY_RESERVED" });
    const next = await guard.reserve(binding(), request("request-b"), KEY); await next.dispatch(); await expect(next.dispatch()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_ALREADY_DISPATCHED" }); await next.fail();
    const attempt = (await persistence.getWorkItemsByKind("personal_account_attempt"))[1] as unknown as { attempt: { estimatedMicros: number; chargedMicros: number } }; expect(attempt.attempt.chargedMicros).toBe(attempt.attempt.estimatedMicros);
  });

  it("rechecks a reduced budget before the physical request", async () => {
    const hold = await guard.reserve(binding(), { ...request(), maxTokens: 4_000 }, KEY);
    accounts.get("conn-a")!.monthlyBudgetCents = 0;
    await expect(hold.dispatch()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_BUDGET_UNKNOWN" }); await hold.fail();
    expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_budget"))).toContain('"consumedMicros":0');
  });

  it("counts uncertain post-dispatch consumption across restart and rejects over-budget reservations", async () => {
    const hold = await guard.reserve(binding(), { ...request(), maxTokens: 4_000 }, KEY); await hold.dispatch(); await hold.fail(new Error("stream disconnect"));
    guard = makeGuard(); await guard.hydrateOwner("alice");
    await expect(guard.reserve(binding(), { ...request("request-b"), maxTokens: 4_000 }, KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_BUDGET_EXHAUSTED" });
    const attempts = JSON.stringify(await persistence.getWorkItemsByKind("personal_account_attempt")); expect(attempts).not.toContain(KEY); expect(attempts).not.toContain("fixture\"");
  });

  it("preserves crash holds and blocks a second request in the same actual domain", async () => {
    await guard.reserve(binding(), request(), KEY); guard = makeGuard(); await guard.hydrateOwner("alice");
    await expect(guard.reserve(binding(), request("request-b"), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_DOMAIN_BUSY" });
  });

  it("shares physical-account concurrency and 429 cooldown across keys but isolates independent accounts", async () => {
    accounts.set("conn-b", authority("conn-b")); accounts.set("conn-c", { ...authority("conn-c"), quotaDomainId: "user:other-account" });
    const hold = await guard.reserve(binding(), request(), KEY);
    await expect(guard.reserve(binding("conn-b"), request("request-b", "conn-b"), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_DOMAIN_BUSY" });
    const independent = await guard.reserve(binding("conn-c"), request("request-c", "conn-c"), KEY); await independent.fail();
    await hold.dispatch(); await hold.fail(new ProviderError("limited", "RATE_LIMITED", true, { status: 429, retryAfter: NOW + 120_000 }));
    await expect(guard.reserve(binding("conn-b"), request("request-b", "conn-b"), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_DOMAIN_COOLDOWN" });
    clock += 120_001; const after = await guard.reserve(binding("conn-b"), request("request-b", "conn-b"), KEY); await after.fail();
  });

  it("conservatively groups unknown quota identities without using credential or connection IDs", () => {
    const first = { ...authority(), quotaScopeVerified: false }; const second = { ...authority("conn-b"), quotaScopeVerified: false, quotaDomainId: "invented-independent" };
    expect(personalAccountDomain(first)).toBe(personalAccountDomain(second)); expect(personalAccountDomain(first)).toBe("openrouter:shared:unverified-account");
  });

  it("uses the higher observed charge and blocks output when upstream exceeds the reservation", async () => {
    const hold = await guard.reserve(binding(), request(), KEY); await hold.dispatch();
    await expect(hold.settle({ inputTokens: 1, outputTokens: 1, costUsd: 0.02 })).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_COST_EXCEEDED_RESERVATION" });
    await hold.fail(); expect(JSON.stringify(await persistence.getWorkItemsByKind("personal_account_budget"))).toContain('"consumedMicros":20000'); expect(guard.eligible(binding())).toBe(false);
  });

  const makeSource = (): UserIntelligenceSource => ({ sourceId: "source-a", ownerUserId: "alice", providerId: "ignored", protocol: "OPENAI_COMPATIBLE", endpointUrl: "https://openrouter.ai/api/v1", modelId: "model-a", familyId: "fixture", version: "1", credentialRef: "conn-a", connectionId: "conn-a", canonicalProviderId: "openrouter", qualification: "QUALIFIED", qualifiedRoles: ["CODER", "REVIEWER"], qualificationEvidence: qualification(), dataPolicy: { privateCode: false }, pricing: binding().pricing as UserIntelligenceSource["pricing"], createdAt: AT, updatedAt: AT });
  const registryFixture = (servedModel = "model-a", finishReason = "tool_calls") => {
    let calls = 0; const catalog = new InMemoryProviderCatalog();
    const fetchFn: typeof fetch = async () => { calls++; return new Response([
      `data: ${JSON.stringify({ model: servedModel, choices: [{ delta: { tool_calls: [{ index: 0, id: "tool-a", function: { name: "write_file", arguments: '{"path":"a"}' } }] } }] })}`,
      `data: ${JSON.stringify({ model: servedModel, choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}`,
      "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }); };
    const registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, { get: () => KEY }, { fetchFn, now: () => clock, personalAccountAuthority: (_owner, conn) => accounts.get(conn), personalRoutingPolicy: () => policy });
    return { registry, catalog, calls: () => calls };
  };

  it("exposes live measured roles and admission, and releases a complete exact-model tool stream once", async () => {
    const f = registryFixture(); const source = await f.registry.put("alice", makeSource()); const adapter = f.catalog.get(source.providerId)!;
    expect(userApiAdapterIdentity(adapter)).toMatchObject({ connectionId: "conn-a", canonicalProviderId: "openrouter", qualifiedRoles: ["CODER", "REVIEWER"], personalAdmission: "PAID_AUTHORIZED" });
    const events = []; for await (const event of adapter.streamChat(request())) events.push(event);
    expect(events.filter(event => event.type === "tool_call_completed")).toHaveLength(1); expect(f.calls()).toBe(1);
    accounts.get("conn-a")!.accountClass = "REVOKED"; expect(f.registry.rosterCandidates("alice")[0]!.available).toBe(false);
    await expect(adapter.chat(request("request-b"))).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_NOT_ADMITTED" }); expect(f.calls()).toBe(1);
  });

  it("withholds tool calls on model substitution and local duplicate attempt", async () => {
    const f = registryFixture("substituted-model"); const source = await f.registry.put("alice", makeSource()); const adapter = f.catalog.get(source.providerId)!; const events = [];
    await expect((async () => { for await (const event of adapter.streamChat(request())) events.push(event); })()).rejects.toMatchObject({ code: "MODEL_SUBSTITUTED" });
    expect(events.filter(event => event.type === "tool_call_completed")).toHaveLength(0);
    await expect((async () => { for await (const _event of adapter.streamChat(request())) { /* consume */ } })()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_REQUEST_ALREADY_RESERVED" }); expect(f.calls()).toBe(1);
  });

  it("withholds truncated tool streams and conservatively accounts their request", async () => {
    const f = registryFixture("model-a", "length"); const source = await f.registry.put("alice", makeSource()); const adapter = f.catalog.get(source.providerId)!; const events = [];
    await expect((async () => { for await (const event of adapter.streamChat(request())) events.push(event); })()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_INCOMPLETE_STREAM" });
    expect(events.filter(event => event.type === "tool_call_completed")).toHaveLength(0);
    const attempt = (await persistence.getWorkItemsByKind("personal_account_attempt"))[0] as unknown as { attempt: { estimatedMicros: number; chargedMicros: number } }; expect(attempt.attempt.chargedMicros).toBe(attempt.attempt.estimatedMicros); expect(f.calls()).toBe(1);
  });

  it("blocks subsequent requests when a certified zero-price response reports a charge", async () => {
    const account = accounts.get("conn-a")!; account.accountClass = "FREE_VERIFIED"; account.freeAdmissionVerified = true; account.modelPricing![0]!.inputCostPerMillion = 0; account.modelPricing![0]!.outputCostPerMillion = 0;
    account.admissionEvidence = { sourceDocumentation: "official", termsEvidence: "terms", priceEvidence: "price", privacyEvidence: "privacy", verifiedAt: AT, recheckAt: UNTIL };
    const b = binding(); b.pricing.inputCostPerMillion = 0; b.pricing.outputCostPerMillion = 0; policy = undefined;
    const hold = await guard.reserve(b, request(), KEY); await hold.dispatch(); await expect(hold.settle({ inputTokens: 1, outputTokens: 1, costUsd: 0.001 })).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_COST_EXCEEDED_RESERVATION" });
    guard = makeGuard(); await guard.hydrateOwner("alice"); expect(guard.eligible(b)).toBe(false);
    await expect(guard.reserve(b, request("request-b"), KEY)).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_UNEXPECTED_CHARGE_BLOCKED" });
  });

  it("requires exact-model qualification evidence and excludes future or expired role claims", async () => {
    const f = registryFixture(); const missing = makeSource(); missing.qualificationEvidence = undefined; await expect(f.registry.put("alice", missing)).rejects.toThrow("USER_SOURCE_ACCOUNT_QUALIFICATION_MISSING");
    const wrong = makeSource(); wrong.qualificationEvidence!.providerId = "groq"; await expect(f.registry.put("alice", wrong)).rejects.toThrow("USER_SOURCE_ACCOUNT_QUALIFICATION_INVALID");
    const source = makeSource(); source.qualifiedRoles.push("TESTER", "LEAD"); await f.registry.put("alice", source); expect(f.registry.rosterCandidates("alice")[0]!.qualifiedRoles).toEqual(["CODER", "REVIEWER"]);
    clock = NOW - 1; expect(f.registry.rosterCandidates("alice")[0]!.qualifiedRoles).toEqual([]);
    clock = NOW + 30 * 86_400_000; expect(f.registry.rosterCandidates("alice")[0]!.qualifiedRoles).toEqual([]);
  });
});
