import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, createSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { ForgeZero } from "@codeforge/forge-zero";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWorkspaceEventAdapter } from "../src/workspace-event-adapter.js";
import {
  resolveForgeAutoRole,
  rosterRouteAllowance,
  validateForgeAutoRoster,
  type ForgeAutoRoster,
  type RosterPolicy,
  type RosterRouteAllowance,
  type RosterUserRoute,
} from "../src/forgeauto-roster.js";
import {
  UserIntelligenceRuntimeRegistry,
  UserIntelligenceSourceStore,
  userApiAdapterIdentity,
  userApiCredentialRef,
  userApiProviderId,
  type OwnerCredentialResolver,
  type UserIntelligenceSource,
} from "../src/user-intelligence.js";

/**
 * R55 wave 1 — owner-scoped USER_API sources execute only through the resolved roster
 * allowance, on the user's own OpenAI-compatible endpoint, with a credential that is
 * resolved at request time by the owning host and never persisted, emitted, or copied
 * into errors. The fixture HTTP endpoint records exactly what reaches the wire.
 */

const NOW = new Date().toISOString();
const ALICE_KEY = "alice-secret-key-0123456789abcdef";
const BOB_KEY = "bob-secret-key-0123456789abcdef";
// Single-slot rosters isolate the entitlement/source-class gate under test.
const SINGLE_SLOT: RosterPolicy = { minSlots: 1, maxSlots: 5, allowSingleModel: true };

interface FixtureCall {
  url: string;
  authorization: string | null;
  body: string;
}

/** Fixture OpenAI-compatible endpoint: records the wire request, answers SSE. */
function makeFetchFixture(opts: { includeUsage?: boolean } = {}) {
  const calls: FixtureCall[] = [];
  const includeUsage = opts.includeUsage !== false;
  const sse = [
    `data: {"id":"chatcmpl-fixture","choices":[{"index":0,"delta":{"content":"Task done."}}]}`,
    includeUsage
      ? `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`
      : `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
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

function sourceFixture(overrides: Partial<UserIntelligenceSource> = {}): UserIntelligenceSource {
  const ownerUserId = overrides.ownerUserId ?? "alice";
  const sourceId = overrides.sourceId ?? "alice-src-1";
  return {
    sourceId,
    ownerUserId,
    providerId: "caller-controlled-value",
    protocol: "OPENAI_COMPATIBLE",
    endpointUrl: "https://alice-endpoint.example/v1",
    modelId: "alice-model-1",
    familyId: "alice-family",
    version: "1.0.0",
    credentialRef: userApiCredentialRef(ownerUserId, sourceId),
    qualification: "QUALIFIED",
    qualifiedRoles: ["CODER"],
    dataPolicy: { privateCode: true },
    pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "OBSERVED", source: "user-declared" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function customRoster(ownerUserId: string, slots: ForgeAutoRoster["slots"]): ForgeAutoRoster {
  return { ownerUserId, entitlement: "CUSTOM", slots, lead: { mode: "NONE" }, updatedAt: NOW };
}

function userRouteFor(source: UserIntelligenceSource, pinned: boolean): RosterUserRoute {
  return {
    sourceId: source.sourceId,
    providerId: source.providerId,
    modelId: source.modelId,
    sourceClass: "USER_API",
    pinned,
    inputCostPerMillion: source.pricing.inputCostPerMillion,
    outputCostPerMillion: source.pricing.outputCostPerMillion,
    costConfidence: source.pricing.confidence,
    ...(source.pricing.source ? { priceSource: source.pricing.source } : {}),
  };
}

describe("R55 wave 1 — owner-scoped USER_API intelligence sources", () => {
  let ws: string;
  let persistence: ISessionPersistence;
  let eventStore: EventStore;
  let catalog: InMemoryProviderCatalog;
  let fixture: ReturnType<typeof makeFetchFixture>;
  let credentials: Map<string, string>;
  let resolver: OwnerCredentialResolver;
  let registry: UserIntelligenceRuntimeRegistry;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-user-intel-"));
    persistence = createSessionPersistence({ dbPath: ":memory:" });
    await persistence.init();
    eventStore = new EventStore();
    catalog = new InMemoryProviderCatalog();
    fixture = makeFetchFixture();
    credentials = new Map();
    resolver = { get: (ownerUserId, credentialRef) => (ownerUserId === "alice" ? credentials.get(credentialRef) : undefined) };
    registry = new UserIntelligenceRuntimeRegistry(persistence, catalog, resolver, { fetchFn: fixture.fetchFn });
    await persistence.upsertSession({
      id: "sess-user-intel",
      title: "User intelligence session",
      createdAt: NOW,
      updatedAt: NOW,
      status: "idle",
    });
  });

  afterEach(async () => {
    await persistence.close();
    await rm(ws, { recursive: true, force: true });
  });

  const makeRuntime = (sessionId = "sess-user-intel") => createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall: new ForgeZero(),
    providerCatalog: catalog,
    workspacePath: ws,
    userId: "alice",
  });

  const runUserRoute = async (allowance: RosterRouteAllowance, runId: string) => {
    const runtime = makeRuntime();
    await runtime.init();
    const adapter = createWorkspaceEventAdapter({ sessionId: "sess-user-intel", eventStore, persistence });
    return runtime.executeAgentRun({
      runId,
      agentId: "agent-user-1",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-user-intel",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      roleRouting: true,
      rosterAllowance: allowance,
      adapter,
      userId: "alice",
    });
  };

  it("stores metadata only — provider identity is derived, never caller-supplied", async () => {
    const stored = await registry.put("alice", sourceFixture());
    expect(stored.providerId).toBe(userApiProviderId("alice", "alice-src-1"));
    expect(stored.providerId).not.toBe("caller-controlled-value");

    const item = await persistence.getWorkItemsByKind("user_intelligence_source");
    expect(item).toHaveLength(1);
    expect(JSON.stringify(item[0])).not.toContain(ALICE_KEY);
    expect(JSON.stringify(item[0])).toContain(stored.credentialRef);

    // The roster projection is the only shape a roster payload may see — no credentialRef.
    const candidates = registry.rosterCandidates("alice");
    expect(candidates).toHaveLength(1);
    expect(JSON.stringify(candidates)).not.toContain("credentialRef");
    expect(JSON.stringify(candidates)).not.toContain(ALICE_KEY);
  });

  it("executes Alice's qualified source with Alice's key — and nowhere else", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());

    const roster = customRoster("alice", [
      { kind: "PINNED_VERSION", modelId: `alice-src-1/${stored.modelId}`, enabled: true },
    ]);
    expect(() => validateForgeAutoRoster(roster, registry.rosterCandidates("alice"), SINGLE_SLOT)).not.toThrow();
    const resolution = resolveForgeAutoRole(roster, registry.rosterCandidates("alice"), "CODER", { privateCode: true, userConsented: false });
    expect(resolution.status).toBe("READY");
    const allowance = rosterRouteAllowance(resolution);
    expect(allowance.userRoutes).toHaveLength(1);
    expect(allowance.userRoutes[0]).toMatchObject({ sourceId: "alice-src-1", providerId: stored.providerId, modelId: "alice-model-1", pinned: true });

    const result = await runUserRoute(allowance, "run-user-alice-1");
    expect(result.status).toBe("completed");

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.url).toBe("https://alice-endpoint.example/v1/chat/completions");
    expect(fixture.calls[0]!.authorization).toBe(`Bearer ${ALICE_KEY}`);
    expect(fixture.calls[0]!.body).toContain('"model":"alice-model-1"');

    // The key is a wire artifact only: absent from every durable record and emitted event.
    for (const kind of ["user_intelligence_source", "subagent_run", "agent_model_turn", "agent_run_journal", "shilling_entry", "agent_tool_execution"]) {
      for (const item of await persistence.getWorkItemsByKind(kind)) {
        expect(JSON.stringify(item)).not.toContain(ALICE_KEY);
      }
    }
    for (const event of eventStore.getAll()) {
      expect(JSON.stringify(event)).not.toContain(ALICE_KEY);
    }
    for (const event of await persistence.getEvents("sess-user-intel")) {
      expect(JSON.stringify(event)).not.toContain(ALICE_KEY);
    }
    expect(result.error ?? "").not.toContain(ALICE_KEY);
    expect(result.summary).not.toContain(ALICE_KEY);
  });

  it("computes observed user-provider spend from provider-reported usage and observed price evidence", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };

    const result = await runUserRoute(allowance, "run-user-priced");
    expect(result.status).toBe("completed");
    const priced = (await persistence.getWorkItemsByKind("shilling_entry"))
      .map((item) => (item as unknown as { entry: { sourceClass: string; userProviderSpendUsd: number | null; costConfidence: string; managedSpendUsd: number | null } }).entry)
      .find((entry) => entry.sourceClass === "USER_API");
    // 10 input × $1/M + 5 output × $2/M = $0.00002 — computed only from reported usage × declared rates.
    expect(priced).toBeDefined();
    expect(priced!.userProviderSpendUsd).toBeCloseTo(0.00002, 8);
    expect(priced!.managedSpendUsd).toBeNull();
    expect(priced!.costConfidence).toBe("OBSERVED");
  });

  it("records USER_API spend as null/UNKNOWN when price evidence is missing", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture({
      pricing: { inputCostPerMillion: null, outputCostPerMillion: null, currency: "USD", confidence: "UNKNOWN" },
    }));
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };

    const result = await runUserRoute(allowance, "run-user-unpriced");
    expect(result.status).toBe("completed");
    const entry = (await persistence.getWorkItemsByKind("shilling_entry"))
      .map((item) => (item as unknown as { entry: { sourceClass: string; userProviderSpendUsd: number | null; costConfidence: string } }).entry)
      .find((record) => record.sourceClass === "USER_API");
    expect(entry).toBeDefined();
    expect(entry!.userProviderSpendUsd).toBeNull();
    expect(entry!.costConfidence).toBe("UNKNOWN");
  });

  it("records USER_API spend as null/UNKNOWN when the provider reports no usage", async () => {
    const noUsage = makeFetchFixture({ includeUsage: false });
    const noUsageRegistry = new UserIntelligenceRuntimeRegistry(persistence, catalog, resolver, { fetchFn: noUsage.fetchFn });
    credentials.set(userApiCredentialRef("alice", "alice-src-2"), ALICE_KEY);
    const stored = await noUsageRegistry.put("alice", sourceFixture({ sourceId: "alice-src-2", endpointUrl: "https://alice-second.example/v1" }));
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };

    const result = await runUserRoute(allowance, "run-user-nousage");
    expect(result.status).toBe("completed");
    const entry = (await persistence.getWorkItemsByKind("shilling_entry"))
      .map((item) => (item as unknown as { entry: { sourceClass: string; userProviderSpendUsd: number | null; costConfidence: string } }).entry)
      .find((record) => record.sourceClass === "USER_API");
    expect(entry).toBeDefined();
    expect(entry!.userProviderSpendUsd).toBeNull();
    expect(entry!.costConfidence).toBe("UNKNOWN");
  });

  it("fails closed before any network when the credential ref does not resolve", async () => {
    // The source exists but no key resolves for its ref — qualification + availability gate.
    const stored = await registry.put("alice", sourceFixture());
    const candidates = registry.rosterCandidates("alice");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.available).toBe(false);
    expect(candidates[0]!.approved).toBe(false);

    // Even a stale allowance naming the route cannot dispatch: the adapter resolves the
    // credential lazily at request time and throws before fetch is ever called.
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };
    const result = await runUserRoute(allowance, "run-user-nokey");
    expect(result.status).not.toBe("completed");
    expect(fixture.calls).toHaveLength(0);
  });

  it("never invokes an unselected user adapter, even when it is registered and credentialed", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    credentials.set(userApiCredentialRef("alice", "alice-src-2"), BOB_KEY);
    const first = await registry.put("alice", sourceFixture());
    const second = await registry.put("alice", sourceFixture({ sourceId: "alice-src-2", endpointUrl: "https://alice-second.example/v1", modelId: "alice-model-2" }));

    // Allowance admits only the first source — the second adapter stays untouched.
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(first, true)] };
    const result = await runUserRoute(allowance, "run-user-onlyfirst");
    expect(result.status).toBe("completed");
    expect(fixture.calls.every((call) => call.url.startsWith("https://alice-endpoint.example/"))).toBe(true);
    expect(fixture.calls.some((call) => call.url.startsWith("https://alice-second.example/"))).toBe(false);

    // Explicit selection of the unadmitted second route is rejected before dispatch.
    const runtime = makeRuntime();
    await runtime.init();
    const blocked = await runtime.executeAgentRun({
      runId: "run-user-unselected",
      agentId: "agent-user-2",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-user-intel",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: second.providerId, modelId: second.modelId },
      roleRouting: true,
      rosterAllowance: allowance,
      userId: "alice",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("ROSTER_ROUTE_NOT_SELECTED");
    expect(fixture.calls.some((call) => call.url.startsWith("https://alice-second.example/"))).toBe(false);
  });

  it("isolates owners: Bob cannot read, select, or invoke Alice's source", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());

    // Read isolation: the record key is derived from (owner, sourceId) — Bob's lookup misses,
    // and listing is owner-filtered.
    await expect(registry.get("bob", "alice-src-1")).resolves.toBeUndefined();
    await expect(registry.list("bob")).resolves.toEqual([]);
    expect(registry.rosterCandidates("bob")).toEqual([]);

    // Select isolation: even handed Alice's live candidate list, Bob's roster can never
    // authorize it — candidate.ownerUserId !== roster.ownerUserId.
    const bobRoster = customRoster("bob", [
      { kind: "PINNED_VERSION", modelId: "alice-src-1/alice-model-1", enabled: true },
    ]);
    expect(() => validateForgeAutoRoster(bobRoster, registry.rosterCandidates("alice"), SINGLE_SLOT)).toThrow("ROSTER_MODEL_INELIGIBLE");
    expect(resolveForgeAutoRole(bobRoster, registry.rosterCandidates("alice"), "CODER", { privateCode: true, userConsented: false }).status).not.toBe("READY");

    // Invoke isolation: Bob's request naming Alice's provider route fails before network —
    // the marker check refuses any marked adapter outside an admitting allowance, and the
    // resolver never answers for bob anyway.
    const runtime = makeRuntime();
    await runtime.init();
    const blocked = await runtime.executeAgentRun({
      runId: "run-bob-invokes-alice",
      agentId: "agent-bob",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-user-intel",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: stored.providerId, modelId: stored.modelId },
      roleRouting: true,
      rosterAllowance: { freeRoutes: [], paidModelIds: [], userRoutes: [] },
      userId: "bob",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("ROSTER_ROUTE_NOT_SELECTED");
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects USER_API under FREE and PAID entitlement, accepts under CUSTOM", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());
    const candidates = registry.rosterCandidates("alice");
    const pin = { kind: "PINNED_VERSION" as const, modelId: "alice-src-1/alice-model-1", enabled: true };
    const auto = { kind: "AUTO" as const, sourceClass: "USER_API" as const, enabled: true };

    for (const entitlement of ["FREE", "PAID"] as const) {
      expect(() => validateForgeAutoRoster({ ownerUserId: "alice", entitlement, slots: [pin], lead: { mode: "NONE" }, updatedAt: NOW }, candidates, SINGLE_SLOT)).toThrow("ROSTER_MODEL_INELIGIBLE");
      expect(() => validateForgeAutoRoster({ ownerUserId: "alice", entitlement, slots: [auto], lead: { mode: "NONE" }, updatedAt: NOW }, candidates, SINGLE_SLOT)).toThrow("ROSTER_SOURCE_INELIGIBLE");
    }
    expect(() => validateForgeAutoRoster(customRoster("alice", [pin]), candidates, SINGLE_SLOT)).not.toThrow();
    expect(() => validateForgeAutoRoster(customRoster("alice", [auto]), candidates, SINGLE_SLOT)).not.toThrow();
    expect(stored.providerId.startsWith("user-api-")).toBe(true);
  });

  it("keeps unqualified and suspended sources listed but non-executable", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    await registry.put("alice", sourceFixture({ qualification: "UNQUALIFIED" }));
    const candidates = registry.rosterCandidates("alice");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.available).toBe(false);
    expect(resolveForgeAutoRole(
      customRoster("alice", [{ kind: "AUTO", sourceClass: "USER_API", enabled: true }]),
      candidates,
      "CODER",
      { privateCode: true, userConsented: false },
    ).status).toBe("NO_ELIGIBLE_ROLE_MODEL");
    expect(fixture.calls).toHaveLength(0);
  });

  it("fails closed on endpoint policy violations", async () => {
    const bad = [
      { endpointUrl: "http://insecure.example/v1" },
      { endpointUrl: "https://user@host.example/v1" },
      { endpointUrl: "https://host.example/v1?key=abc" },
      { endpointUrl: "https://host.example/v1#frag" },
      { endpointUrl: "https://host.example/../v1" },
      { endpointUrl: "https://localhost/v1" },
      { endpointUrl: "https://sub.localhost/v1" },
      { endpointUrl: "https://127.0.0.1/v1" },
      { endpointUrl: "https://10.0.0.5/v1" },
      { endpointUrl: "https://172.16.0.1/v1" },
      { endpointUrl: "https://192.168.1.1/v1" },
      { endpointUrl: "https://169.254.169.254/latest" },
      { endpointUrl: "https://100.64.0.1/v1" },
      { endpointUrl: "https://0.0.0.0/v1" },
      { endpointUrl: "https://[::1]/v1" },
      { endpointUrl: "https://[fe80::1]/v1" },
      { endpointUrl: "https://[fd00::1]/v1" },
      { endpointUrl: "https://[::ffff:127.0.0.1]/v1" },
      { endpointUrl: "https://host.example/%2e%2e/v1" },
      { endpointUrl: "https://host.example/v1\\..\\admin" },
      { protocol: "LOCAL" },
      { sourceId: "bad id!" },
      { qualification: "BOGUS" },
      { pricing: { inputCostPerMillion: -1, outputCostPerMillion: 0, currency: "USD", confidence: "UNKNOWN" } },
    ];
    for (const override of bad) {
      await expect(registry.put("alice", sourceFixture(override as Partial<UserIntelligenceSource>))).rejects.toThrow(/^USER_SOURCE_/);
    }
    // A plain public HTTPS endpoint remains admissible — the policy refuses local/cloud-
    // metadata addresses, not real cloud hosts.
    await expect(registry.put("alice", sourceFixture({ sourceId: "ok-endpoint" }))).resolves.toBeDefined();
  });

  it("rejects writes claiming a different owner", async () => {
    await expect(registry.put("alice", sourceFixture({ ownerUserId: "bob" }))).rejects.toThrow("USER_SOURCE_OWNER_MISMATCH");
    const store = new UserIntelligenceSourceStore(persistence);
    await expect(store.put("alice", sourceFixture({ ownerUserId: "alice", sourceId: "ok" }))).resolves.toBeDefined();
    await expect(store.get("alice", "ok")).resolves.toMatchObject({ sourceId: "ok" });
  });

  it("hashes unambiguous tuples — (ab,c) never collides with (a,bc) in ids, refs, or store keys", async () => {
    const idAb = userApiProviderId("ab", "c");
    const idA = userApiProviderId("a", "bc");
    expect(idAb).not.toBe(idA);
    expect(userApiCredentialRef("ab", "c")).not.toBe(userApiCredentialRef("a", "bc"));

    const store = new UserIntelligenceSourceStore(persistence);
    const ab = await store.put("ab", sourceFixture({ ownerUserId: "ab", sourceId: "c", endpointUrl: "https://ab.example/v1" }));
    const a = await store.put("a", sourceFixture({ ownerUserId: "a", sourceId: "bc", endpointUrl: "https://a.example/v1", credentialRef: userApiCredentialRef("a", "bc") }));
    // Distinct durable records under distinct keys — each readable only by its owner.
    expect(await store.get("ab", "c")).toMatchObject({ sourceId: "c" });
    expect(await store.get("a", "bc")).toMatchObject({ sourceId: "bc" });
    expect(await store.get("ab", "bc")).toBeUndefined();
    expect(await store.get("a", "c")).toBeUndefined();
    expect((await store.list("ab")).map((s) => s.sourceId)).toEqual(["c"]);
    expect((await store.list("a")).map((s) => s.sourceId)).toEqual(["bc"]);
    const items = await persistence.getWorkItemsByKind("user_intelligence_source");
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(ab.providerId).not.toBe(a.providerId);
  });

  it("stamps a frozen adapter identity and fails a copied allowance under another user before any network", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());
    const adapter = catalog.get(stored.providerId)!;
    const identity = userApiAdapterIdentity(adapter)!;
    expect(identity).toMatchObject({ ownerUserId: "alice", sourceId: "alice-src-1", qualification: "QUALIFIED" });
    expect(Object.isFrozen(identity)).toBe(true);

    // Bob's run carrying Alice's exact allowance: the stamped owner refuses before the wire.
    const copiedAllowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };
    const runtime = makeRuntime();
    await runtime.init();
    const blocked = await runtime.executeAgentRun({
      runId: "run-bob-copied",
      agentId: "agent-bob-2",
      role: "coder",
      goal: "Do the thing",
      workspaceId: "ws-user-intel",
      workspacePath: ws,
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      modelSelection: { providerId: stored.providerId, modelId: stored.modelId },
      roleRouting: true,
      rosterAllowance: copiedAllowance,
      userId: "bob",
    });
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("ROSTER_ROUTE_NOT_SELECTED");
    expect(fixture.calls).toHaveLength(0);
  });

  it("a SUSPENDED re-put invalidates an outstanding allowance immediately", async () => {
    credentials.set(userApiCredentialRef("alice", "alice-src-1"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture());
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };

    // Qualification flips after the allowance was issued — the live guard re-reads the
    // durable record on dispatch and fails closed.
    await registry.put("alice", sourceFixture({ qualification: "SUSPENDED" }));
    expect(userApiAdapterIdentity(catalog.get(stored.providerId))!.qualification).toBe("SUSPENDED");

    const result = await runUserRoute(allowance, "run-user-suspended");
    expect(result.status).toBe("failed");
    expect(fixture.calls).toHaveLength(0);
  });

  it("requires a bounded price source for any non-UNKNOWN pricing confidence", async () => {
    for (const confidence of ["AUTHORITATIVE", "OBSERVED", "ESTIMATED"] as const) {
      await expect(registry.put("alice", sourceFixture({
        sourceId: `no-src-${confidence.toLowerCase()}`,
        pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence },
      }))).rejects.toThrow("USER_SOURCE_PRICING_INVALID");
      await expect(registry.put("alice", sourceFixture({
        sourceId: `empty-src-${confidence.toLowerCase()}`,
        pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence, source: "   " },
      }))).rejects.toThrow("USER_SOURCE_PRICING_INVALID");
      await expect(registry.put("alice", sourceFixture({
        sourceId: `ok-${confidence.toLowerCase()}`,
        pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence, source: "user-declared" },
      }))).resolves.toBeDefined();
    }
    // UNKNOWN confidence may carry declared rates but never becomes numeric spend.
    await expect(registry.put("alice", sourceFixture({
      sourceId: "unknown-priced",
      pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "UNKNOWN" },
    }))).resolves.toBeDefined();
  });

  it("keeps runtime spend null when pricing is UNKNOWN even though rates were declared", async () => {
    credentials.set(userApiCredentialRef("alice", "unknown-priced"), ALICE_KEY);
    const stored = await registry.put("alice", sourceFixture({
      sourceId: "unknown-priced",
      pricing: { inputCostPerMillion: 1, outputCostPerMillion: 2, currency: "USD", confidence: "UNKNOWN" },
    }));
    const allowance = { freeRoutes: [], paidModelIds: [], userRoutes: [userRouteFor(stored, true)] };
    const result = await runUserRoute(allowance, "run-user-unknown-price");
    expect(result.status).toBe("completed");
    const entry = (await persistence.getWorkItemsByKind("shilling_entry"))
      .map((item) => (item as unknown as { entry: { sourceClass: string; userProviderSpendUsd: number | null; costConfidence: string } }).entry)
      .find((record) => record.sourceClass === "USER_API");
    expect(entry).toBeDefined();
    expect(entry!.userProviderSpendUsd).toBeNull();
    expect(entry!.costConfidence).toBe("UNKNOWN");
  });

  it("persists append-only decision receipts for the initial selection and a failover — with no secrets or bodies", async () => {
    // A fetch fixture that fails the first source's endpoint with a retryable 500 and
    // serves the second — the AUTO user pool must rotate inside the allowance.
    const routed = makeFetchFixture();
    const fetchFn: typeof fetch = async (url, init) => {
      if (String(url).startsWith("https://fail-first.example/")) {
        return new Response("upstream exploded", { status: 500 });
      }
      return routed.fetchFn(url, init);
    };
    const failoverRegistry = new UserIntelligenceRuntimeRegistry(persistence, catalog, resolver, { fetchFn });
    credentials.set(userApiCredentialRef("alice", "fail-src"), ALICE_KEY);
    credentials.set(userApiCredentialRef("alice", "good-src"), ALICE_KEY);
    const failing = await failoverRegistry.put("alice", sourceFixture({ sourceId: "fail-src", endpointUrl: "https://fail-first.example/v1" }));
    const good = await failoverRegistry.put("alice", sourceFixture({ sourceId: "good-src", endpointUrl: "https://good-second.example/v1", modelId: "good-model" }));

    const decision = {
      ownerUserId: "alice",
      rosterUpdatedAt: NOW,
      role: "CODER" as const,
      candidates: [failing, good].map((source) => ({
        modelId: `${source.sourceId}/${source.modelId}`,
        providerId: source.providerId,
        providerModelId: source.modelId,
        familyId: source.familyId,
        version: source.version,
        sourceClass: "USER_API" as const,
        lifecycle: "ACTIVE" as const,
      })),
    };
    const allowance = {
      freeRoutes: [],
      paidModelIds: [],
      userRoutes: [userRouteFor(failing, false), userRouteFor(good, false)],
      decision,
    };
    const result = await runUserRoute(allowance as RosterRouteAllowance, "run-user-receipts");
    expect(result.status).toBe("completed");

    const receipts = await persistence.getWorkItemsByKind("forgeauto_decision_receipt");
    // Initial selection + the failover — append-only, one per routing decision.
    expect(receipts.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(receipts);
    for (const forbidden of [ALICE_KEY, "credentialRef", "fail-first.example", "good-second.example", "Do the thing", "Task done"]) {
      expect(serialized).not.toContain(forbidden);
    }
    const decoded = receipts.map((item) => (item as unknown as { decision: { selected: { providerId: string }; fallbackFrom?: string; role: string; ownerUserId: string; rosterUpdatedAt: string } }).decision);
    expect(decoded[0]!.selected.providerId).toBe(failing.providerId);
    const failoverReceipt = decoded.find((entry) => entry.fallbackFrom !== undefined);
    expect(failoverReceipt).toBeDefined();
    expect(failoverReceipt!.fallbackFrom).toBe(`${failing.providerId}/${failing.modelId}`);
    expect(failoverReceipt!.selected.providerId).toBe(good.providerId);
    expect(decoded.every((entry) => entry.ownerUserId === "alice" && entry.rosterUpdatedAt === NOW && entry.role === "CODER")).toBe(true);
  });
});
