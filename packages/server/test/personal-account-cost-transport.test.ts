import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, type ChatRequest, type StreamEvent } from "@codeforge/providers";
import { type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { UserIntelligenceRuntimeRegistry, type UserIntelligenceSource } from "../src/user-intelligence.js";
import type { PersonalAccountAuthority } from "../src/personal-account-policy.js";

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const KEY = "fixture-cost-transport-secret";
const MODEL = "fixture-free-model";
const PRICE = "https://openrouter.ai/api/v1/models";
const RECEIPT: ModelQualificationReceipt = { suiteVersion: "R73_ROLE_QUALIFICATION_V6", providerId: "openrouter", modelId: MODEL,
  modelDisplayName: "Fixture", accessClass: "API_KEY", freeStatus: "FREE", startedAt: AT, completedAt: AT, totalLatencyMs: 1,
  qualificationState: "QUALIFIED", hardFailureRoles: [], roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT } } };
const source = (): UserIntelligenceSource => ({ sourceId: "fixture-cost-source", ownerUserId: "alice", providerId: "derived", protocol: "OPENAI_COMPATIBLE",
  endpointUrl: "https://openrouter.ai/api/v1", modelId: MODEL, familyId: "fixture", version: "1", credentialRef: "conn-cost", connectionId: "conn-cost",
  canonicalProviderId: "openrouter", qualification: "QUALIFIED", qualifiedRoles: ["CODER"], qualificationEvidence: RECEIPT,
  dataPolicy: { privateCode: false, userConsentRequired: true }, pricing: { inputCostPerMillion: 0, outputCostPerMillion: 0, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE }, createdAt: AT, updatedAt: AT });
const authority: PersonalAccountAuthority = { ownerUserId: "alice", connectionId: "conn-cost", providerId: "openrouter", credentialRef: "conn-cost",
  credentialFingerprint: createHash("sha256").update(KEY).digest("hex"), accountClass: "FREE_VERIFIED", accountIdentityHash: "a".repeat(64),
  quotaDomainId: "openrouter:USER_ACCOUNT:fixture-physical-account", quotaScopeVerified: true, enabled: true, paidSpendingEnabled: false,
  verifiedAt: AT, recheckAt: UNTIL, authState: "ok", freeAdmissionVerified: true,
  modelPricing: [{ modelId: MODEL, inputCostPerMillion: 0, outputCostPerMillion: 0, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE, verifiedAt: AT, recheckAt: UNTIL, tokenOnly: true }],
  admissionEvidence: { sourceDocumentation: "https://openrouter.ai/docs/guides/overview/auth/oauth", termsEvidence: "https://openrouter.ai/terms", privacyEvidence: "https://openrouter.ai/privacy", priceEvidence: PRICE, verifiedAt: AT, recheckAt: UNTIL } };
const request = (id: string): ChatRequest => ({ model: MODEL, messages: [{ role: "user", content: "public fixture" }], maxTokens: 16,
  metadata: { personalAccountOwnerUserId: "alice", personalAccountConnectionId: "conn-cost", personalAccountRequestId: id } });

describe("reported OpenRouter cost reaches the personal account ledger", () => {
  let persistence: ISessionPersistence;
  let posts: Record<string, unknown>[];
  let cost: unknown;
  let streaming: boolean;
  let catalog: InMemoryProviderCatalog;
  const makeRegistry = () => new UserIntelligenceRuntimeRegistry(persistence, catalog, { get: owner => owner === "alice" ? KEY : undefined }, {
    now: () => NOW, personalAccountAuthority: owner => owner === "alice" ? authority : undefined,
    personalRoutingPolicy: () => ({ mode: "FREE_ONLY", paidEnabled: false, explicitConsent: false, limitationsAcknowledged: false }),
    fetchFn: async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const usage = { prompt_tokens: 4, completion_tokens: 2, cost };
      if (!streaming) return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: "fixture result" }, finish_reason: "stop" }], usage }));
      return new Response([
        `data: ${JSON.stringify({ model: MODEL, choices: [{ delta: { tool_calls: [{ id: "fixture-tool", index: 0, function: { name: "read_file", arguments: "{}" } }] } }] })}`,
        `data: ${JSON.stringify({ model: MODEL, choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        `data: ${JSON.stringify({ model: MODEL, choices: [], usage })}`, "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });
  beforeEach(async () => { persistence = createSessionPersistence({ dbPath: ":memory:" }); await persistence.init(); posts = []; cost = 0.025; streaming = false; catalog = new InMemoryProviderCatalog(); });
  afterEach(async () => { await persistence.close(); });

  it.each([false, true])("blocks an unexpected charge and persists the actual amount across restart (stream=%s)", async stream => {
    streaming = stream;
    let registry = makeRegistry(); const stored = await registry.put("alice", source()); const adapter = catalog.get(stored.providerId)!;
    const seen: StreamEvent[] = [];
    const run = async () => { if (!stream) return adapter.chat(request("charged-request")); for await (const event of adapter.streamChat(request("charged-request"))) seen.push(event); };
    await expect(run()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_COST_EXCEEDED_RESERVATION" });
    expect(posts).toHaveLength(1); expect(posts[0]!.usage).toEqual({ include: true });
    if (stream) { expect(posts[0]!.stream_options).toEqual({ include_usage: true }); expect(seen.filter(event => event.type.startsWith("tool_call_") || event.type === "finish")).toEqual([]); }
    const budgets = await persistence.getWorkItemsByKind("personal_account_budget") as unknown as { budget: { consumedMicros: number; reservedMicros: number; unexpectedCharge: boolean } }[];
    expect(budgets[0]!.budget).toEqual({ consumedMicros: 25_000, reservedMicros: 0, unexpectedCharge: true });
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { status: string; estimatedMicros: number; chargedMicros: number; actualMicros: number } }[];
    expect(attempts[0]!.attempt).toMatchObject({ status: "SETTLED", estimatedMicros: 0, chargedMicros: 25_000, actualMicros: 25_000 });
    catalog = new InMemoryProviderCatalog(); registry = makeRegistry(); await registry.hydrateOwner("alice");
    expect(registry.rosterCandidates("alice")[0]!.available).toBe(false);
    await expect(catalog.get(stored.providerId)!.chat(request("after-restart"))).rejects.toThrow(); expect(posts).toHaveLength(1);
  });

  it.each([false, true])("does not mistake malformed reported billing for a passing result (stream=%s)", async stream => {
    streaming = stream; cost = "sensitive-invalid-value"; const registry = makeRegistry(); const stored = await registry.put("alice", source()); const adapter = catalog.get(stored.providerId)!;
    const run = async () => { if (!stream) return adapter.chat(request("malformed-cost")); for await (const _event of adapter.streamChat(request("malformed-cost"))) {} };
    await expect(run()).rejects.toMatchObject({ code: "MALFORMED_USAGE_COST", message: "Provider returned invalid usage cost" });
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { status: string; chargedMicros: number } }[];
    expect(attempts[0]!.attempt).toMatchObject({ status: "SETTLED", chargedMicros: 0 });
    expect(JSON.stringify(attempts)).not.toContain(String(cost)); expect(posts).toHaveLength(1);
  });

  it.each([false, true])("blocks unrepresentable reported charges durably instead of replacing them with a zero estimate (stream=%s)", async stream => {
    streaming = stream; cost = 1e12;
    let registry = makeRegistry(); const stored = await registry.put("alice", source()); const adapter = catalog.get(stored.providerId)!;
    const seen: StreamEvent[] = [];
    const run = async () => { if (!stream) return adapter.chat(request("unrepresentable-cost")); for await (const event of adapter.streamChat(request("unrepresentable-cost"))) seen.push(event); };
    await expect(run()).rejects.toMatchObject({ code: "PERSONAL_ACCOUNT_ACCOUNTING_UNCERTAIN" });
    expect(seen.filter(event => event.type.startsWith("tool_call_") || event.type === "finish")).toEqual([]);
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { reportedCostUsd: number; chargedMicros: number; accountingUncertain: boolean } }[];
    expect(attempts[0]!.attempt).toMatchObject({ reportedCostUsd: 1e12, chargedMicros: Number.MAX_SAFE_INTEGER, accountingUncertain: true });
    catalog = new InMemoryProviderCatalog(); registry = makeRegistry(); await registry.hydrateOwner("alice");
    expect(registry.rosterCandidates("alice")[0]!.available).toBe(false);
    await expect(catalog.get(stored.providerId)!.chat(request("after-unrepresentable-restart"))).rejects.toThrow();
    expect(posts).toHaveLength(1);
  });
});
