import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog, ProviderError, type ChatRequest, type ProviderAdapter, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { CapacityReservationLedger, ForgeZero, createGenericFreeRecord, type CapacityRoute, type ProviderCapacityPool } from "@codeforge/forge-zero";
import { REVIEWER_PROTOCOL, createFreeFabric, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { createForgeGreenR0TelemetryStore } from "@codeforge/forge-green";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import { resolveForgeAutoRole, rosterRouteAllowance, type ForgeAutoRoster, type RosterCandidate, type RosterRouteAllowance } from "../src/forgeauto-roster.js";
import type { PersonalAccountAuthority, PersonalRoutingPolicy } from "../src/personal-account-policy.js";
import { UserIntelligenceRuntimeRegistry, type UserIntelligenceSource } from "../src/user-intelligence.js";

const KEY = "fixture-runtime-personal-secret";
const PRICE = "https://openrouter.ai/api/v1/models";
const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const UNTIL = new Date(NOW + 3_600_000).toISOString();
const qualification = (): ModelQualificationReceipt => ({ suiteVersion: "R73_ROLE_QUALIFICATION_V6", providerId: "openrouter", modelId: "personal-model", modelDisplayName: "Fixture", accessClass: "API_KEY", freeStatus: "FREE", startedAt: AT, completedAt: AT, totalLatencyMs: 1, qualificationState: "QUALIFIED", hardFailureRoles: [], metadata: { roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } }, roleResults: { CODER: { role: "CODER", status: "QUALIFIED", overallScore: 1, testCases: [], hardFailures: [], startedAt: AT, completedAt: AT } } });
const account = (): PersonalAccountAuthority => ({ ownerUserId: "alice", connectionId: "conn-a", providerId: "openrouter", credentialRef: "conn-a", credentialFingerprint: createHash("sha256").update(KEY).digest("hex"), accountClass: "PAID", quotaDomainId: "openrouter:USER_ACCOUNT:physical-account-a", quotaScopeVerified: true, enabled: true, paidSpendingEnabled: true, monthlyBudgetCents: 100, verifiedAt: AT, recheckAt: UNTIL, authState: "ok", modelPricing: [{ modelId: "personal-model", inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE, verifiedAt: AT, recheckAt: UNTIL, tokenOnly: true }] });
const personalSource = (): UserIntelligenceSource => ({ sourceId: "source-a", ownerUserId: "alice", providerId: "untrusted-input", protocol: "OPENAI_COMPATIBLE", endpointUrl: "https://openrouter.ai/api/v1", modelId: "personal-model", familyId: "personal", version: "1", credentialRef: "conn-a", connectionId: "conn-a", canonicalProviderId: "openrouter", qualification: "QUALIFIED", qualifiedRoles: ["CODER"], qualificationEvidence: qualification(), dataPolicy: { privateCode: true, userConsentRequired: true }, pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "AUTHORITATIVE", source: PRICE }, createdAt: AT, updatedAt: AT });
const packagedCandidate = (): RosterCandidate => ({ modelId: "packaged-model", providerId: "fixture-packaged", providerModelId: "packaged-model", familyId: "packaged", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", approved: true, available: true, qualifiedRoles: ["CODER"], dataPolicy: { privateCode: true } });
const packagedRoute = (): CapacityRoute => ({ routeId: "fixture-packaged:packaged-model", providerId: "fixture-packaged", modelId: "packaged-model", canonicalModelId: "packaged-model", family: "packaged", gateway: "fixture-packaged", supplyClass: "PURE_MANAGED_FREE", capacityPoolId: "shared:fixture-packaged", capacityPoolScope: "SHARED_OWNER_POOL", capacityScope: "ORG", dataPolicyProfile: "PRIVATE_CODE_ALLOWED", lifecycle: "APPROVED", explicitZeroPrice: true, paidFallbackDisabled: true, managedMultiUserAllowed: true, privacyClass: "standard", roles: ["PRIMARY_CODING_AGENT"], qualityScore: 80, healthy: true, enabled: true, windows: [{ unit: "requests", limit: 100, remaining: 100, resetAt: UNTIL, observedAt: AT, scope: "ORG", authoritative: true }] });
const ok = (): StreamEvent[] => [{ type: "text_delta", delta: "Task done." }, { type: "usage", usage: { inputTokens: 10, outputTokens: 3 } }, { type: "finish", finishReason: "stop", model: "packaged-model" }];
interface WireRequest { messages: { role: string; content: string; tool_call_id?: string }[]; }

class FixturePackagedProvider implements ProviderAdapter {
  readonly providerId = "fixture-packaged";
  readonly isTestProvider = true;
  calls: ChatRequest[] = [];
  script: (call: number) => StreamEvent[] = () => ok();
  async listModels(): Promise<ProviderModel[]> { return [{ modelId: "packaged-model", displayName: "Fixture", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }]; }
  async chat(): Promise<never> { throw new Error("Use streamChat"); }
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> { this.calls.push(request); yield* this.script(this.calls.length); }
  async healthCheck() { return { status: "available" as const }; }
}

describe("personal paid routing uses the existing autonomous role runtime", () => {
  let workspace: string;
  let persistence: ISessionPersistence;
  let events: EventStore;
  let catalog: InMemoryProviderCatalog;
  let firewall: ForgeZero;
  let packaged: FixturePackagedProvider;
  let registry: UserIntelligenceRuntimeRegistry;
  let authority: PersonalAccountAuthority;
  let routing: PersonalRoutingPolicy;
  let paidPosts: WireRequest[];
  let runtimes: ReturnType<typeof createAgentRuntime>[];
  let freeQualificationScore: number | undefined;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "cf-personal-runtime-")); persistence = createSessionPersistence({ dbPath: ":memory:" }); await persistence.init();
    events = new EventStore(); catalog = new InMemoryProviderCatalog(); firewall = new ForgeZero(); packaged = new FixturePackagedProvider(); catalog.register(packaged);
    firewall.register(createGenericFreeRecord({ providerId: packaged.providerId, modelId: "packaged-model", displayName: "Fixture" }));
    authority = account(); routing = { mode: "FREE_PREFERRED", paidEnabled: true, explicitConsent: true, limitationsAcknowledged: true }; paidPosts = []; runtimes = []; freeQualificationScore = undefined;
    const fetchFn: typeof fetch = async (_url, init) => {
      expect(init?.method).toBe("POST"); paidPosts.push(JSON.parse(String(init?.body)) as WireRequest);
      return new Response([`data: ${JSON.stringify({ model: "personal-model", choices: [{ delta: { content: "Task done." } }] })}`, `data: ${JSON.stringify({ model: "personal-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}`, "data: [DONE]", ""].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    };
    registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, { get: owner => owner === "alice" ? KEY : undefined }, { fetchFn, personalAccountAuthority: owner => owner === "alice" ? authority : undefined, personalRoutingPolicy: () => routing, now: () => NOW });
    await registry.put("alice", personalSource());
    await persistence.upsertSession({ id: "personal-runtime", title: "Fixture", createdAt: AT, updatedAt: AT, status: "idle" });
  });
  afterEach(async () => { for (const runtime of runtimes) await runtime.shutdown(); await persistence.close(); await rm(workspace, { recursive: true, force: true }); });
  const allowance = (mode: PersonalRoutingPolicy["mode"]): RosterRouteAllowance => {
    routing = { ...routing, mode, ...(mode === "SPECIFIC_ACCOUNT" ? { specificConnectionId: "conn-a" } : {}) };
    const roster: ForgeAutoRoster = { ownerUserId: "alice", entitlement: "PAID", slots: [...(mode === "SPECIFIC_ACCOUNT" ? [] : [{ kind: "AUTO" as const, sourceClass: "MANAGED_FREE" as const, enabled: true }]), { kind: "AUTO", sourceClass: "USER_API", enabled: true }], lead: { mode: "NONE" }, updatedAt: AT };
    const resolved = resolveForgeAutoRole(roster, [packagedCandidate(), ...registry.rosterCandidates("alice")], "CODER", { privateCode: true, userConsented: true });
    expect(resolved.status).toBe("READY");
    return { ...rosterRouteAllowance(resolved, { ownerUserId: "alice", rosterUpdatedAt: AT, role: "CODER" }), personalRoutingMode: mode };
  };
  const run = async (mode: PersonalRoutingPolicy["mode"], runId: string, authorizationWorkspacePath?: string, useHostAllowance = false) => {
    const route = packagedRoute(); const pool: ProviderCapacityPool = { poolId: route.capacityPoolId, providerId: route.providerId, scope: route.capacityPoolScope, supplyClass: route.supplyClass, windows: route.windows, observedAt: AT, authoritative: true };
    const fabric = createFreeFabric({ managedRoutes: () => [route], managedPools: () => [pool], reservations: new CapacityReservationLedger({ routes: [], pools: [] }) });
    const receipt = qualification(); receipt.providerId = packaged.providerId; receipt.modelId = "packaged-model"; receipt.roleResults.CODER!.overallScore = freeQualificationScore;
    const freeCloud: import("@codeforge/model-registry").FreeCloudRoutingHooks | undefined = freeQualificationScore === undefined ? undefined : {
      isForgeAutoEligible: provider => provider === packaged.providerId,
      canonicalIdOf: (provider, model) => `${provider}/${model}`,
      sameModelAlternates: () => [], recordRouteFailure: () => undefined, recordRouteSuccess: () => undefined,
      quotaRemaining: () => undefined, capacityRoutingAdvice: () => ({ scoreAdjustment: 0, reasonCodes: [] }),
      getQualificationReceipt: provider => provider === packaged.providerId ? receipt : undefined,
    };
    const resolvedAllowance = allowance(mode);
    const runtime = createAgentRuntime({ sessionId: "personal-runtime", eventStore: events, persistence, firewall, providerCatalog: catalog, workspacePath: workspace, userId: "alice", freeFabric: fabric, freeCloud, qualificationRecoveryBudgetMs: 0, ...(useHostAllowance ? { personalRoleAllowance: (owner, role, requestedWorkspace) => {
      expect(owner).toBe("alice"); expect(role).toBe("coder"); expect(requestedWorkspace).toBe(authorizationWorkspacePath ?? workspace);
      return resolvedAllowance;
    } } : {}), fabricContext: () => ({ userId: "alice", userIdentities: [], dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }) }); runtimes.push(runtime);
    return runtime.executeAgentRun({ runId, agentId: "coder-a", role: "coder", goal: "Finish the bounded fixture task", workspaceId: "ws-personal", workspacePath: workspace, authorizationWorkspacePath, permissions: { read: true, search: true, write: true, executeCommand: false, network: false }, roleRouting: true, ...(useHostAllowance ? {} : { rosterAllowance: resolvedAllowance }), userId: "alice", adapter: createWorkspaceEventAdapter({ sessionId: "personal-runtime", eventStore: events, persistence }) });
  };

  it.each(["FREE_ONLY", "FREE_PREFERRED"] as const)("%s selects available packaged Free while leaving connected paid capacity unused", async mode => {
    const result = await run(mode, `run-${mode}`);
    expect(result.status).toBe("completed"); expect(packaged.calls).toHaveLength(1); expect(paidPosts).toEqual([]);
  });

  it("Paid Preferred selects a qualified, explicitly authorized personal account", async () => {
    const result = await run("PAID_PREFERRED", "run-paid-preferred");
    expect(result.status).toBe("completed"); expect(packaged.calls).toEqual([]); expect(paidPosts).toHaveLength(1);
    const attempts = await persistence.getWorkItemsByKind("personal_account_attempt"); expect(attempts).toHaveLength(1);
  });

  it("resolves personal capacity through the trusted host callback for a normal run without an explicit roster allowance", async () => {
    const result = await run("PAID_PREFERRED", "run-host-allowance", undefined, true);
    expect(result.status).toBe("completed"); expect(packaged.calls).toEqual([]); expect(paidPosts).toHaveLength(1);
    expect(await persistence.getWorkItemsByKind("personal_account_attempt")).toHaveLength(1);
  });

  it("keeps a Manual account outside automatic routing while permitting its explicit account selection", async () => {
    authority.preference = "MANUAL";
    const automatic = await run("PAID_PREFERRED", "run-manual-auto");
    expect(automatic.status).toBe("completed"); expect(packaged.calls).toHaveLength(1); expect(paidPosts).toEqual([]);
    const explicit = await run("SPECIFIC_ACCOUNT", "run-manual-specific");
    expect(explicit.status).toBe("completed"); expect(packaged.calls).toHaveLength(1); expect(paidPosts).toHaveLength(1);
  });

  it("Auto Best selects the stronger measured personal role only when paid consent remains enabled", async () => {
    freeQualificationScore = 0.8;
    const permitted = await run("AUTO_BEST", "run-measured-best");
    expect(permitted.status).toBe("completed"); expect(packaged.calls).toEqual([]); expect(paidPosts).toHaveLength(1);
    routing.explicitConsent = false;
    const optedOut = await run("AUTO_BEST", "run-measured-opt-out");
    expect(optedOut.status).toBe("completed"); expect(packaged.calls).toHaveLength(1); expect(paidPosts).toHaveLength(1);
  });

  it("keeps unknown Free quality ahead of a paid route rather than manufacturing a comparison", async () => {
    const result = await run("AUTO_BEST", "run-unknown-best");
    expect(result.status).toBe("completed"); expect(packaged.calls).toHaveLength(1); expect(paidPosts).toEqual([]);
  });

  it("uses the parent-authorized disclosure workspace for an isolated child worktree", async () => {
    const parentWorkspace = join(workspace, "authorized-parent"); authority.authorizedWorkspacePath = parentWorkspace;
    const blocked = await run("SPECIFIC_ACCOUNT", "run-workspace-mismatch");
    expect(blocked.status).not.toBe("completed"); expect(paidPosts).toEqual([]);
    const allowed = await run("SPECIFIC_ACCOUNT", "run-child-authorized", parentWorkspace);
    expect(allowed.status).toBe("completed"); expect(paidPosts).toHaveLength(1);
  });

  it("keeps a local personal disclosure denial out of provider health and retry accounting", async () => {
    authority.authorizedWorkspacePath = join(workspace, "different-consented-workspace");
    const result = await run("SPECIFIC_ACCOUNT", "run-local-policy-denial");
    expect(result.status).not.toBe("completed"); expect(result.error).toContain("PERSONAL_ACCOUNT_WORKSPACE_MISMATCH");
    expect(packaged.calls).toEqual([]); expect(paidPosts).toEqual([]);
    expect(await persistence.getWorkItemsByKind("personal_account_attempt")).toEqual([]);
    const telemetry = await createForgeGreenR0TelemetryStore(persistence).loadByRun("personal-runtime", "run-local-policy-denial");
    expect(telemetry).toBeDefined();
    expect(telemetry!.providerFailures.providerFailures.value).toBe(0);
    expect(telemetry!.providerFailures.failureCodes).toEqual([]);
    expect(telemetry!.retries.retryCount.value).toBe(0);
  });

  it.each(["PAID_PREFERRED", "SPECIFIC_ACCOUNT"] as const)("handles credential rejection without replaying or replacing an explicit account in %s", async (mode) => {
    const secondKey = "fixture-runtime-personal-second-secret";
    const secondAuthority: PersonalAccountAuthority = { ...account(), connectionId: "conn-b", credentialRef: "conn-b",
      credentialFingerprint: createHash("sha256").update(secondKey).digest("hex"), quotaDomainId: "openrouter:USER_ACCOUNT:physical-account-b" };
    const seen: string[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const first = new Headers(init?.headers).get("Authorization") === `Bearer ${KEY}`;
      seen.push(first ? "conn-a" : "conn-b");
      if (first) return new Response(JSON.stringify({ error: { message: "Unauthorized", code: 401 } }), { status: 401 });
      return new Response([`data: ${JSON.stringify({ model: "personal-model", choices: [{ delta: { content: "Task done." } }] })}`,
        `data: ${JSON.stringify({ model: "personal-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0 } })}`,
        "data: [DONE]", ""].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    };
    registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, { get: (owner, ref) => owner === "alice" ? ref === "conn-a" ? KEY : ref === "conn-b" ? secondKey : undefined : undefined },
      { fetchFn, personalAccountAuthority: (owner, connection) => owner === "alice" ? connection === "conn-a" ? authority : connection === "conn-b" ? secondAuthority : undefined : undefined,
        personalRoutingPolicy: () => routing, now: () => NOW });
    await registry.put("alice", personalSource());
    await registry.put("alice", { ...personalSource(), sourceId: "source-b", connectionId: "conn-b", credentialRef: "conn-b" });
    const result = await run(mode, `run-auth-rejection-${mode}`);
    expect(packaged.calls).toEqual([]);
    if (mode === "PAID_PREFERRED") {
      expect(result.status).toBe("completed");
      expect(seen).toEqual(["conn-a", "conn-b"]);
      expect(result.contextMetrics?.routeFailovers).toHaveLength(1);
    } else {
      expect(result.status).not.toBe("completed");
      expect(seen).toEqual(["conn-a"]);
    }
    expect(await persistence.getWorkItemsByKind("personal_account_attempt")).toHaveLength(seen.length);
  });

  it("Free Preferred preserves successful edits and tool observations through injected Free failure and authorized paid continuation", async () => {
    await writeFile(join(workspace, "calculator.ts"), "export const add = (a, b) => a - b;\n");
    packaged.script = call => {
      if (call === 1) return [{ type: "tool_call_started", toolCallId: "read-a", toolName: "read_file" }, { type: "tool_call_completed", toolCallId: "read-a", toolName: "read_file", arguments: '{"path":"calculator.ts"}' }, { type: "finish", finishReason: "tool_calls" }];
      if (call === 2) return [{ type: "tool_call_started", toolCallId: "edit-a", toolName: "edit_file" }, { type: "tool_call_completed", toolCallId: "edit-a", toolName: "edit_file", arguments: '{"path":"calculator.ts","oldText":"a - b","newText":"a + b"}' }, { type: "finish", finishReason: "tool_calls" }];
      throw new ProviderError("Injected upstream outage", "PROVIDER_UNAVAILABLE", true, { status: 503 });
    };
    const result = await run("FREE_PREFERRED", "run-preserve-progress");
    expect(result.status).toBe("completed"); expect(paidPosts).toHaveLength(1);
    expect(await readFile(join(workspace, "calculator.ts"), "utf8")).toContain("a + b");
    expect(result.toolExecutions.filter(execution => execution.toolName === "edit_file" && execution.success)).toHaveLength(1);
    const paidBody = paidPosts[0]!;
    expect(paidBody.messages.filter(message => message.role === "tool" && message.tool_call_id === "edit-a")).toHaveLength(1);
    expect(JSON.stringify(await persistence.getWorkItemsByKind("agent_run_journal"))).not.toContain(KEY);
  });

  it("Free Only never consumes the connected paid route when every allowed Free attempt fails", async () => {
    packaged.script = () => { throw new ProviderError("Injected upstream outage", "PROVIDER_UNAVAILABLE", true, { status: 503 }); };
    const result = await run("FREE_ONLY", "run-free-only-failure");
    expect(result.status).not.toBe("completed"); expect(paidPosts).toEqual([]);
    expect(await persistence.getWorkItemsByKind("personal_account_attempt")).toEqual([]);
  });
});
