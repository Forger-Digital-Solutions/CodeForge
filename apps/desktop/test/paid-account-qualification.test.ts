import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, OpenAICompatibleAdapter, ProviderError, type ChatRequest, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { REVIEWER_PROTOCOL, EXPLORER_PROTOCOL, ROLE_QUALIFICATION_SUITE_VERSION, type ModelQualificationReceipt, type runRoleAwareQualification } from "@codeforge/eight-bit";
import { UserIntelligenceRuntimeRegistry } from "../../../packages/server/src/user-intelligence.js";
import type { PersonalAccountAuthority, PersonalRoutingPolicy } from "../../../packages/server/src/personal-account-policy.js";
import type { ConnectedAccountAuthority } from "../src/connected-accounts.js";
import { qualifyPersonalPaidModel, type PaidQualificationOptions } from "../src/provider-account-qualification.js";

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const KEY = "fixture-paid-qualification-key";
const MODEL = "fixture-paid-model";
const WORKSPACE = "G:\\fixture-public-project";
const PRICE = "https://openrouter.ai/api/v1/models";
const model: ProviderModel = { modelId: MODEL, displayName: "Fixture", isFree: false, freeStatus: "paid", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
  pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE, verifiedAt: AT, recheckAt: UNTIL, tokenOnly: true } };
const account = (): PersonalAccountAuthority & ConnectedAccountAuthority => ({ ownerUserId: "alice", connectionId: "conn-qualification", providerId: "openrouter", credentialRef: "conn-qualification",
  credentialFingerprint: createHash("sha256").update(KEY).digest("hex"), accountClass: "PAID", quotaDomainId: "openrouter:user:fixture-account", quotaScopeVerified: true,
  enabled: true, paidSpendingEnabled: true, monthlyBudgetCents: 100, verifiedAt: AT, recheckAt: UNTIL, authState: "ok", preference: "AUTO", freeAdmissionVerified: false,
  authorizedWorkspacePath: WORKSPACE, modelPricing: [{ modelId: MODEL, ...model.pricing! }] });
const receipt = (): ModelQualificationReceipt => ({ suiteVersion: ROLE_QUALIFICATION_SUITE_VERSION, providerId: "openrouter", modelId: MODEL, modelDisplayName: "Fixture", accessClass: "PAID", freeStatus: "paid",
  startedAt: AT, completedAt: AT, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [], metadata: { roleProtocolVersions: { EXPLORER: EXPLORER_PROTOCOL.version, REVIEWER: REVIEWER_PROTOCOL.version } },
  roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], startedAt: AT, completedAt: AT } } });
const request = (): ChatRequest => ({ model: MODEL, messages: [{ role: "user", content: "public fixture" }], maxTokens: 16 });

describe("budget-authorized paid model qualification", () => {
  let persistence: ISessionPersistence;
  let authority: ReturnType<typeof account>;
  let policy: PersonalRoutingPolicy;
  let registry: UserIntelligenceRuntimeRegistry;
  let calls: number;
  let events: StreamEvent[];
  let stored: ModelQualificationReceipt[];
  let estimates: unknown[];
  let transport: ProviderAdapter;
  const options = (runQualification: typeof runRoleAwareQualification): PaidQualificationOptions => ({ authority, model, workspacePath: WORKSPACE, transport,
    assertCurrent: () => { if (!authority.enabled || authority.ownerUserId !== "alice") throw new Error("ACCOUNT_AUTHORITY_CHANGED"); },
    reserve: (binding, stamped) => registry.reservePersonalAccountQualification(binding, stamped), recordReceipt: async value => { stored.push(value); }, runQualification, now: () => NOW });
  const oneCall = (stream = false): typeof runRoleAwareQualification => async (_record, adapter) => {
    if (stream) { for await (const _event of adapter.streamChat(request())) {} } else await adapter.chat!(request());
    return receipt();
  };
  beforeEach(async () => {
    persistence = createSessionPersistence({ dbPath: ":memory:" }); await persistence.init(); authority = account(); policy = { mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true };
    calls = 0; events = [{ type: "usage", usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.00002 } }, { type: "finish", finishReason: "stop", model: MODEL }]; stored = []; estimates = [];
    registry = new UserIntelligenceRuntimeRegistry(persistence, new InMemoryProviderCatalog(), { get: owner => owner === "alice" ? KEY : undefined }, {
      personalAccountAuthority: owner => owner === "alice" ? authority : undefined, personalRoutingPolicy: () => policy, now: () => NOW,
      onEstimate: async estimate => { estimates.push(estimate); },
    });
    transport = { providerId: "openrouter", isTestProvider: true, listModels: async () => [model], healthCheck: async () => ({ status: "available" }),
      chat: async () => { calls++; return { id: "fixture", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finishReason: "stop" }], usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.00002 } }; },
      async *streamChat() { calls++; for (const event of events) yield event; } };
  });
  afterEach(async () => { await persistence.close(); });

  it.each([false, true])("evaluates an unqualified model through the same durable budget guard, without production promotion (stream=%s)", async stream => {
    const result = await qualifyPersonalPaidModel(options(oneCall(stream)));
    expect(result.freeStatus).toBe("paid"); expect(result.metadata?.qualificationPurpose).toBe("USER_AUTHORIZED_PAID"); expect(calls).toBe(1);
    expect(registry.rosterCandidates("alice")).toEqual([]); expect(estimates).toMatchObject([{ purpose: "QUALIFICATION", modelId: MODEL, workspacePath: WORKSPACE, currency: "USD" }]);
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { chargedMicros: number; status: string } }[];
    expect(attempts[0]!.attempt).toMatchObject({ status: "SETTLED", chargedMicros: 20 }); expect(stored).toHaveLength(1);
    expect(JSON.stringify(attempts)).not.toContain(KEY);
  });

  it("refuses FreeOnly, unknown prices, exhausted budget and a different workspace before transport", async () => {
    for (const change of [() => { policy.mode = "FREE_ONLY"; }, () => { authority.modelPricing![0]!.recheckAt = AT; }, () => { authority.monthlyBudgetCents = 0; }, () => { authority.authorizedWorkspacePath = "G:\\other-project"; }]) {
      authority = account(); policy.mode = "FREE_PREFERRED"; change();
      await expect(qualifyPersonalPaidModel(options(oneCall()))).rejects.toThrow();
    }
    expect(calls).toBe(0); expect(estimates).toEqual([]); expect(stored).toEqual([]);
  });

  it("withholds executable frames after substituted identity, incomplete stream or observed cost anomaly", async () => {
    for (const next of [ [{ type: "tool_call_completed" as const, toolCallId: "fixture", toolName: "read_file", arguments: "{}" }, { type: "finish" as const, model: "unqualified-other", finishReason: "tool_calls" as const }],
      [{ type: "text_delta" as const, delta: "truncated" }], [{ type: "usage" as const, usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.1 } }, { type: "finish" as const, model: MODEL, finishReason: "stop" as const }] ]) {
      events = next; const released: StreamEvent[] = [];
      await expect(qualifyPersonalPaidModel(options(async (_record, adapter) => { for await (const event of adapter.streamChat(request())) released.push(event); return receipt(); }))).rejects.toThrow();
      expect(released).toEqual([]);
    }
    expect(stored).toEqual([]);
  });

  it("keeps provider quota failures transient and preserves a prior conclusive receipt", async () => {
    events = [{ type: "error", code: "RATE_LIMITED", message: "private provider content", status: 429, retryable: true }];
    const prior = receipt();
    const configuration = options(async (_record, adapter) => { try { for await (const _event of adapter.streamChat(request())) {} } catch (error) { expect(error).toBeInstanceOf(ProviderError); }
      return { ...receipt(), qualificationState: "NOT_QUALIFIED", metadata: { transient: true } }; });
    configuration.recordReceipt = async value => { stored.push(value); if (!value.metadata?.transient) Object.assign(prior, value); };
    await qualifyPersonalPaidModel(configuration);
    expect(prior.qualificationState).toBe("QUALIFIED"); expect(stored[0]!.metadata?.transient).toBe(true); expect(stored[0]!.freeStatus).toBe("paid");
  });

  it.each([false, true])("settles an observed charge on rejected served identity before withholding output (stream=%s)", async stream => {
    events = [{ type: "usage", usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } }, { type: "finish", finishReason: "stop", model: "other-model" }];
    transport.chat = async () => { calls++; return { id: "rejected", model: "other-model", choices: [], usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } }; };
    await expect(qualifyPersonalPaidModel(options(oneCall(stream)))).rejects.toThrow("PERSONAL_ACCOUNT_COST_EXCEEDED_RESERVATION");
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { actualMicros: number; chargedMicros: number; reportedCostUsd: number } }[];
    expect(attempts[0]!.attempt).toMatchObject({ actualMicros: 10_000, chargedMicros: 10_000, reportedCostUsd: 0.01 });
    expect(stored).toEqual([]);
  });

  it("records observed usage even when the account is revoked during a stream", async () => {
    transport.streamChat = async function* () { calls++; authority.enabled = false; yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.00002 } }; };
    await expect(qualifyPersonalPaidModel(options(oneCall(true)))).rejects.toThrow("ACCOUNT_AUTHORITY_CHANGED");
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { actualMicros: number; chargedMicros: number; reportedCostUsd: number } }[];
    expect(attempts[0]!.attempt).toMatchObject({ actualMicros: 20, reportedCostUsd: 0.00002 });
    expect(attempts[0]!.attempt.chargedMicros).toBeGreaterThanOrEqual(20); expect(stored).toEqual([]);
  });

  it.each([false, true])("preserves actual OpenRouter wire costs through the canonical transport and qualification ledger (stream=%s)", async stream => {
    const wireUsage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.00002 };
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.usage).toEqual({ include: true }); if (stream) expect(body.stream_options).toEqual({ include_usage: true });
      return stream ? new Response(`data: ${JSON.stringify({ id: "wire", model: MODEL, choices: [{ index: 0, delta: { content: "fixture" }, finish_reason: "stop" }], usage: wireUsage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
        : new Response(JSON.stringify({ id: "wire", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: wireUsage }), { headers: { "Content-Type": "application/json" } });
    });
    transport = new OpenAICompatibleAdapter({ providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", credentialStore: { get: () => KEY, set: () => {}, delete: () => false, has: () => true }, requestBodyExtras: { usage: { include: true } }, includeUsageInStream: true, fetchFn });
    await qualifyPersonalPaidModel(options(oneCall(stream)));
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt") as unknown as { attempt: { chargedMicros: number; reportedCostUsd: number } }[];
    expect(attempts[0]!.attempt).toMatchObject({ chargedMicros: 20, reportedCostUsd: 0.00002 }); expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("archives a local policy stop as inconclusive rather than model incompetence", async () => {
    policy.paidEnabled = false;
    const result = await qualifyPersonalPaidModel(options(async (_record, adapter) => { try { await adapter.chat!(request()); } catch {} return { ...receipt(), qualificationState: "HARD_FAILURE" }; }));
    expect(result.metadata).toMatchObject({ transient: true, qualificationAdmissionInterrupted: true }); expect(calls).toBe(0); expect(stored).toHaveLength(1);
  });

  it("the production suite classifies provider 429 as transient without retrying another account", async () => {
    events = [{ type: "error", code: "RATE_LIMITED", message: "private provider body", status: 429, retryable: true }];
    const configuration = options(oneCall()); delete configuration.runQualification;
    const result = await qualifyPersonalPaidModel(configuration);
    expect(result.metadata?.transient).toBe(true); expect(calls).toBe(1); expect(result.qualificationState).not.toBe("QUALIFIED");
    expect(JSON.stringify(stored)).not.toContain("private provider body");
  });

  it("rechecks consent after estimate presentation and releases a denied pre-dispatch reservation", async () => {
    registry = new UserIntelligenceRuntimeRegistry(persistence, new InMemoryProviderCatalog(), { get: () => KEY }, { personalAccountAuthority: () => authority, personalRoutingPolicy: () => policy, now: () => NOW,
      onEstimate: async () => { policy.explicitConsent = false; } });
    await expect(qualifyPersonalPaidModel(options(oneCall()))).rejects.toThrow(); expect(calls).toBe(0);
    const budgets = await persistence.getWorkItemsByKind("personal_account_budget") as unknown as { budget: { consumedMicros: number; reservedMicros: number } }[];
    expect(budgets[0]!.budget).toEqual({ consumedMicros: 0, reservedMicros: 0 });
  });

  it("reuses current conclusive protocol evidence without reserving or spending again", async () => {
    const runner = vi.fn(oneCall()); const configuration = { ...options(runner), cachedReceipt: receipt() };
    expect(await qualifyPersonalPaidModel(configuration)).toBe(configuration.cachedReceipt); expect(runner).not.toHaveBeenCalled(); expect(calls).toBe(0); expect(stored).toEqual([]);
  });

  it("runs the unchanged production suites and rejects an always-approve Reviewer", async () => {
    transport.streamChat = async function* (req) {
      calls++;
      const body = req.messages.map(message => message.content).join("\n");
      let frames: StreamEvent[];
      if (body.includes("Open src/calc.ts")) frames = [{ type: "tool_call_completed", toolCallId: "read", toolName: "read_file", arguments: '{"path":"src/calc.ts"}' }, { type: "finish", finishReason: "tool_calls", model: MODEL }];
      else if (body.includes("has a bug")) frames = [{ type: "tool_call_completed", toolCallId: "edit", toolName: "edit_file", arguments: '{"path":"src/calc.ts","oldText":"return a - b;","newText":"return a + b;"}' }, { type: "finish", finishReason: "tool_calls", model: MODEL }];
      else if (body.includes("read-only repository explorer")) {
        const files = body.includes("reservation") ? ["src/fabric/admission.ts", "src/fabric/ledger.ts"] : ["src/router.ts", "src/provider/client.ts"];
        frames = req.messages.some(message => message.role === "tool")
          ? [{ type: "text_delta", delta: JSON.stringify({ files }) }, { type: "finish", finishReason: "stop", model: MODEL }]
          : [...files.map((path, index): StreamEvent => ({ type: "tool_call_completed", toolCallId: `read-${index}`, toolName: "read_file", arguments: JSON.stringify({ path }) })), { type: "finish", finishReason: "tool_calls", model: MODEL }];
      }
      else frames = [{ type: "text_delta", delta: body.includes('"files" (array') ? '{"files":["src/calc.ts","test/calc.test.ts"],"verified":true}' : body.includes("independent change reviewer") ? '{"verdict":"pass","summary":"approve everything","findings":[]}' : '{}' }, { type: "finish", finishReason: "stop", model: MODEL }];
      yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.00002 } }; for (const frame of frames) yield frame;
    };
    const configuration = options(oneCall()); delete configuration.runQualification;
    const result = await qualifyPersonalPaidModel(configuration);
    expect(result.roleResults.CODER?.status).toBe("QUALIFIED"); expect(result.roleResults.REVIEWER?.status).toBe("HARD_FAILURE");
    expect(result.metadata?.roleProtocolVersions).toMatchObject({ REVIEWER: REVIEWER_PROTOCOL.version }); expect(calls).toBeGreaterThan(6); expect(calls).toBeLessThanOrEqual(24);
    expect(result.freeStatus).toBe("paid"); expect(registry.rosterCandidates("alice")).toEqual([]);
  });
});
