import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, SqliteSessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { ForgeZero } from "@codeforge/forge-zero";
import { SubagentRunWorkItemSchema, type SubagentRunWorkItem } from "@codeforge/protocol";
import { ManagedPaidAllowanceLedger, type ManagedPaidPolicy } from "@codeforge/cloud-usage";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import {
  ForgeAutoRosterStore,
  resolveForgeAutoRole,
  rosterRouteAllowance,
  validateForgeAutoRoster,
  type ForgeAutoRoster,
  type RosterCandidate,
} from "../src/forgeauto-roster.js";
import {
  UserIntelligenceRuntimeRegistry,
  userApiAdapterIdentity,
  userApiCredentialRef,
  type OwnerCredentialResolver,
  type UserIntelligenceSource,
} from "../src/user-intelligence.js";

/**
 * R55 multi-user isolation — one suite proving that rosters, user-owned sources and
 * adapters, managed-paid allowance/receipts, and recovered worker routing state stay
 * owner-scoped across a shared persistence store and a restart.
 */

const NOW = "2026-10-05T00:00:00.000Z";
const ALICE_KEY = "alice-secret-key-0123456789abcdef";
const BOB_KEY = "bob-secret-key-0123456789abcdef";

const freeCatalog: RosterCandidate[] = [
  { modelId: "free-a", providerId: "groq", providerModelId: "a", familyId: "free-a", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER", "LEAD"], dataPolicy: { privateCode: true } },
  { modelId: "free-b", providerId: "mistral", providerModelId: "b", familyId: "free-b", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER", "REVIEWER"], dataPolicy: { privateCode: true } },
  { modelId: "free-c", providerId: "groq", providerModelId: "c", familyId: "free-c", version: "1", sourceClass: "MANAGED_FREE", lifecycle: "ACTIVE", available: true, approved: true, qualifiedRoles: ["CODER"], dataPolicy: { privateCode: true } },
];

interface FixtureCall {
  url: string;
  authorization: string | null;
  body: string;
}

function makeFetchFixture() {
  const calls: FixtureCall[] = [];
  const sse = [
    `data: {"id":"chatcmpl-fixture","choices":[{"index":0,"delta":{"content":"Done."}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const fetchFn: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get("authorization"), body: String(init?.body ?? "") });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchFn, calls };
}

function userSource(ownerUserId: string, sourceId: string, endpointUrl: string, modelId: string): UserIntelligenceSource {
  return {
    sourceId,
    ownerUserId,
    providerId: "caller-controlled-value",
    protocol: "OPENAI_COMPATIBLE",
    endpointUrl,
    modelId,
    familyId: `${sourceId}-family`,
    version: "1.0.0",
    credentialRef: userApiCredentialRef(ownerUserId, sourceId),
    qualification: "QUALIFIED",
    qualifiedRoles: ["CODER"],
    dataPolicy: { privateCode: true },
    pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "OBSERVED", source: "user-declared" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function customRoster(ownerUserId: string, slots: ForgeAutoRoster["slots"], lead: ForgeAutoRoster["lead"]): ForgeAutoRoster {
  return { ownerUserId, entitlement: "CUSTOM", slots, lead, updatedAt: NOW };
}

function managedPolicy(ownerUserId: string): ManagedPaidPolicy {
  return {
    ownerUserId,
    entitlement: "PAID",
    costMode: "BALANCED",
    includedAllowanceUsd: 10,
    overageEnabled: false,
    hardMaximumUsd: 20,
    userOwnedAllowed: true,
    paidLeadAllowed: false,
    updatedAt: NOW,
  };
}

function workerItem(id: string, sessionId: string, allowance: SubagentRunWorkItem["rosterAllowance"]): SubagentRunWorkItem {
  return {
    kind: "subagent_run",
    id,
    sessionId,
    parentRunId: "parent-1",
    agentId: "coder",
    role: "coder",
    task: "implement the thing",
    depth: 1,
    status: "running",
    capsule: { schemaVersion: 1, assignment: "a", goal: "g", relevantFiles: [], knownEvidence: [], constraints: [], requiredOutput: [] },
    permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    allowedTools: ["read_file"],
    workspace: { id: "ws-1", kind: "local" },
    rosterAllowance: allowance,
    budget: { maxModelTurns: 5, maxToolCalls: 10, maxContextTokens: 10_000, wallTimeMs: 60_000 },
    telemetry: { wallTimeMs: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, retryCount: 0, duplicateWorkCount: 0, providerFailures: 0 },
    artifacts: [],
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("R55 multi-user isolation", () => {
  let dir: string;
  let ws: string;
  let dbPath: string;
  let persistence: SqliteSessionPersistence;
  let eventStore: EventStore;
  let catalog: InMemoryProviderCatalog;
  let fixture: ReturnType<typeof makeFetchFixture>;
  let credentials: Map<string, string>;
  let resolver: OwnerCredentialResolver;
  let registry: UserIntelligenceRuntimeRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-r55-multi-user-"));
    ws = join(dir, "ws");
    dbPath = join(dir, "sessions.sqlite");
    persistence = new SqliteSessionPersistence({ dbPath });
    eventStore = new EventStore();
    catalog = new InMemoryProviderCatalog();
    fixture = makeFetchFixture();
    credentials = new Map();
    // The resolver answers only for the owner stamped on the ref tuple — an owner can
    // never pull another owner's credential.
    resolver = { get: (ownerUserId, credentialRef) => credentials.get(`${ownerUserId}${credentialRef}`) };
    registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, resolver, { fetchFn: fixture.fetchFn });
    await persistence.upsertSession({ id: "sess-alice", title: "Alice session", createdAt: NOW, updatedAt: NOW, status: "idle" });
    await persistence.upsertSession({ id: "sess-bob", title: "Bob session", createdAt: NOW, updatedAt: NOW, status: "idle" });
  });

  afterEach(async () => {
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  });

  const makeRuntime = (sessionId: string) => createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall: new ForgeZero(),
    providerCatalog: catalog,
    workspacePath: ws,
  });

  it("persists each user's roster separately — lead and pin changes never cross", async () => {
    const rosterStore = new ForgeAutoRosterStore(persistence);
    const alice = customRoster("alice", [
      { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["LEAD"], enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["CODER"], enabled: true },
    ], { mode: "MANUAL", slotIndex: 0 });
    const bob = customRoster("bob", [
      { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["CODER"], enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["LEAD"], enabled: true },
    ], { mode: "MANUAL", slotIndex: 1 });
    const aliceSaved = await rosterStore.put("alice", alice, freeCatalog);
    const bobSaved = await rosterStore.put("bob", bob, freeCatalog);

    expect(await rosterStore.get("alice")).toEqual(aliceSaved);
    expect(await rosterStore.get("bob")).toEqual(bobSaved);
    await expect(rosterStore.put("bob", alice, freeCatalog)).rejects.toThrow("ROSTER_OWNER_MISMATCH");

    // Alice re-pins her coder slot and drops her manual lead — Bob's record is untouched.
    const aliceUpdated = customRoster("alice", [
      { kind: "PINNED_VERSION", modelId: "free-a", allowedRoles: ["LEAD"], enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-c", allowedRoles: ["CODER"], enabled: true },
    ], { mode: "NONE" });
    await rosterStore.put("alice", aliceUpdated, freeCatalog);
    expect((await rosterStore.get("alice"))!.lead).toEqual({ mode: "NONE" });
    expect((await rosterStore.get("alice"))!.slots[1]).toMatchObject({ modelId: "free-c" });
    expect(await rosterStore.get("bob")).toEqual(bobSaved);

    // Restart: both rosters survive, still owner-keyed — two records, never merged.
    await persistence.close();
    persistence = new SqliteSessionPersistence({ dbPath });
    const reopened = new ForgeAutoRosterStore(persistence);
    expect((await reopened.get("alice"))!.lead).toEqual({ mode: "NONE" });
    expect(await reopened.get("bob")).toEqual(bobSaved);
    const items = await persistence.getWorkItemsByKind("forgeauto_roster");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => (item as unknown as { ownerUserId: string }).ownerUserId))).toEqual(new Set(["alice", "bob"]));
  });

  it("cannot let Bob execute Alice's source or adapter — even with a copied allowance", async () => {
    credentials.set(`alice${userApiCredentialRef("alice", "alice-src")}`, ALICE_KEY);
    credentials.set(`bob${userApiCredentialRef("bob", "bob-src")}`, BOB_KEY);
    const aliceStored = await registry.put("alice", userSource("alice", "alice-src", "https://alice-endpoint.example/v1", "alice-model-1"));
    const bobStored = await registry.put("bob", userSource("bob", "bob-src", "https://bob-endpoint.example/v1", "bob-model-1"));

    // Read/projection isolation: Alice's record is invisible under Bob's owner scope, and
    // Bob's candidate projection contains only his own source.
    await expect(registry.get("bob", "alice-src")).resolves.toBeUndefined();
    expect(registry.rosterCandidates("bob").map((candidate) => candidate.sourceId)).toEqual(["bob-src"]);
    expect(userApiAdapterIdentity(catalog.get(aliceStored.providerId))).toMatchObject({ ownerUserId: "alice", sourceId: "alice-src" });

    // Alice resolves her own qualified source through her own roster.
    const aliceCandidates = [...freeCatalog, ...registry.rosterCandidates("alice")];
    const aliceRoster = customRoster("alice", [
      { kind: "PINNED_VERSION", modelId: `alice-src/alice-model-1`, enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["TESTER"], enabled: true },
    ], { mode: "NONE" });
    expect(() => validateForgeAutoRoster(aliceRoster, aliceCandidates)).not.toThrow();
    const aliceAllowance = rosterRouteAllowance(resolveForgeAutoRole(aliceRoster, aliceCandidates, "CODER", { privateCode: true, userConsented: false }));
    expect(aliceAllowance.userRoutes).toHaveLength(1);
    expect(aliceAllowance.userRoutes[0]!.providerId).toBe(aliceStored.providerId);

    // Bob's run carrying a byte-for-byte copy of Alice's allowance: the adapter's stamped
    // owner identity mismatches before any network call is made.
    const bobRuntime = makeRuntime("sess-bob");
    await bobRuntime.init();
    const copied = await bobRuntime.executeAgentRun({
      runId: "run-bob-copied-allowance",
      agentId: "agent-bob-1",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-bob",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      roleRouting: true,
      rosterAllowance: aliceAllowance,
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-bob", eventStore, persistence }),
      userId: "bob",
    });
    expect(copied.status).toBe("failed");
    expect(copied.error).toContain("ROSTER_ROUTE_NOT_SELECTED");
    expect(fixture.calls).toHaveLength(0);

    // Same boundary on an explicit selection with the copied route admitted.
    const bobExplicit = makeRuntime("sess-bob");
    await bobExplicit.init();
    const explicit = await bobExplicit.executeAgentRun({
      runId: "run-bob-explicit-alice",
      agentId: "agent-bob-2",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-bob",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: aliceStored.providerId, modelId: aliceStored.modelId },
      roleRouting: true,
      rosterAllowance: aliceAllowance,
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-bob", eventStore, persistence }),
      userId: "bob",
    });
    expect(explicit.status).toBe("failed");
    expect(fixture.calls).toHaveLength(0);

    // Control: Bob's own source serves him — on his endpoint, with his key.
    const bobCandidates = [...freeCatalog, ...registry.rosterCandidates("bob")];
    const bobRoster = customRoster("bob", [
      { kind: "PINNED_VERSION", modelId: `bob-src/bob-model-1`, enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["TESTER"], enabled: true },
    ], { mode: "NONE" });
    const bobAllowance = rosterRouteAllowance(resolveForgeAutoRole(bobRoster, bobCandidates, "CODER", { privateCode: true, userConsented: false }));
    const bobOwn = makeRuntime("sess-bob");
    await bobOwn.init();
    const result = await bobOwn.executeAgentRun({
      runId: "run-bob-own-source",
      agentId: "agent-bob-3",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-bob",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      roleRouting: true,
      rosterAllowance: bobAllowance,
      adapter: createWorkspaceEventAdapter({ sessionId: "sess-bob", eventStore, persistence }),
      userId: "bob",
    });
    expect(result.status).toBe("completed");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.url).toBe("https://bob-endpoint.example/v1/chat/completions");
    expect(fixture.calls[0]!.authorization).toBe(`Bearer ${BOB_KEY}`);
    expect(fixture.calls.some((call) => call.url.startsWith("https://alice-endpoint.example/"))).toBe(false);
  });

  it("keeps managed-paid allowance and receipts owner-isolated on the shared store", async () => {
    const ledger = new ManagedPaidAllowanceLedger(persistence);
    const alicePolicy = managedPolicy("alice");
    const bobPolicy = managedPolicy("bob");
    await ledger.reserve(alicePolicy, { requestId: "alice-req", taskId: "task-a", role: "CODER", providerId: "alibaba", modelId: "qwen3.8-flash", estimatedUsd: 1, priceSource: "test" });
    await ledger.settle("alice", "alice-req", 0.5, "OBSERVED");

    // Bob's snapshot and receipts see none of Alice's spend; he cannot settle or release it.
    const bobSnap = await ledger.snapshot(bobPolicy);
    expect([bobSnap.consumedUsd, bobSnap.reservedUsd, bobSnap.availableUsd]).toEqual([0, 0, 10]);
    expect(await ledger.receipts("bob")).toEqual([]);
    await expect(ledger.settle("bob", "alice-req", 0.5, "OBSERVED")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });
    await expect(ledger.release("bob", "alice-req")).rejects.toMatchObject({ code: "MANAGED_PAID_RESERVATION_UNKNOWN" });

    // Bob's own reserve works in his own space and never touches Alice's headroom.
    await ledger.reserve(bobPolicy, { requestId: "bob-req", taskId: "task-b", role: "CODER", providerId: "zai", modelId: "glm-5.3-flash", estimatedUsd: 2, priceSource: "test" });
    expect((await ledger.snapshot(bobPolicy)).reservedUsd).toBe(2);
    expect((await ledger.snapshot(alicePolicy)).consumedUsd).toBe(0.5);
    expect((await ledger.receipts("alice")).map((receipt) => receipt.requestId)).toEqual(["alice-req"]);
  });

  it("recovers each worker's owner decision and route allowance after a restart — no cross-user bleed", async () => {
    credentials.set(`alice${userApiCredentialRef("alice", "alice-src")}`, ALICE_KEY);
    const aliceStored = await registry.put("alice", userSource("alice", "alice-src", "https://alice-endpoint.example/v1", "alice-model-1"));
    const aliceCandidates = [...freeCatalog, ...registry.rosterCandidates("alice")];
    const aliceRoster = customRoster("alice", [
      { kind: "PINNED_VERSION", modelId: `alice-src/alice-model-1`, enabled: true },
      { kind: "PINNED_VERSION", modelId: "free-b", allowedRoles: ["TESTER"], enabled: true },
    ], { mode: "NONE" });
    const aliceAllowance = rosterRouteAllowance(
      resolveForgeAutoRole(aliceRoster, aliceCandidates, "CODER", { privateCode: true, userConsented: false }),
      { ownerUserId: "alice", rosterUpdatedAt: NOW, role: "CODER" },
    );
    const bobAllowance = rosterRouteAllowance(
      resolveForgeAutoRole(customRoster("bob", [{ kind: "AUTO", sourceClass: "MANAGED_FREE", enabled: true }], { mode: "NONE" }), freeCatalog, "CODER"),
      { ownerUserId: "bob", rosterUpdatedAt: NOW, role: "CODER" },
    );
    expect(aliceAllowance.userRoutes).toHaveLength(1);
    expect(bobAllowance.userRoutes).toEqual([]);

    await persistence.upsertWorkItem(workerItem("worker-alice", "sess-alice", aliceAllowance) as never);
    await persistence.upsertWorkItem(workerItem("worker-bob", "sess-bob", bobAllowance) as never);

    // Restart the persistence store — the recovered worker records must carry their own
    // owner's decision audit and route allowance, intact and unmerged.
    await persistence.close();
    persistence = new SqliteSessionPersistence({ dbPath });

    const aliceItem = await persistence.getWorkItem("worker-alice");
    const bobItem = await persistence.getWorkItem("worker-bob");
    const aliceWorker = SubagentRunWorkItemSchema.parse(aliceItem);
    const bobWorker = SubagentRunWorkItemSchema.parse(bobItem);

    expect(aliceWorker.rosterAllowance!.decision!.ownerUserId).toBe("alice");
    expect(aliceWorker.rosterAllowance!.userRoutes).toHaveLength(1);
    expect(aliceWorker.rosterAllowance!.userRoutes![0]).toMatchObject({
      sourceId: "alice-src",
      providerId: aliceStored.providerId,
      modelId: "alice-model-1",
      sourceClass: "USER_API",
      pinned: true,
    });
    // The persisted worker allowance never carried Alice's credential ref or endpoint.
    expect(JSON.stringify(aliceItem)).not.toContain("credentialRef");
    expect(JSON.stringify(aliceItem)).not.toContain("alice-endpoint.example");
    expect(JSON.stringify(aliceItem)).not.toContain(ALICE_KEY);

    expect(bobWorker.rosterAllowance!.decision!.ownerUserId).toBe("bob");
    expect(bobWorker.rosterAllowance!.userRoutes ?? []).toEqual([]);
    expect(bobWorker.rosterAllowance!.freeRoutes.length).toBeGreaterThan(0);
    expect(JSON.stringify(bobItem)).not.toContain(aliceStored.providerId);
  });
});
