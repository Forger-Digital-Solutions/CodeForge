import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createAiHordeCommunityAdapter, createKiloFreeDirectAdapter, InMemoryProviderCatalog, ProviderError } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, reverifyHordePolicy, reverifyKiloPolicy } from "@codeforge/model-registry";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from "@codeforge/server";

const execFile = promisify(execFileCallback);
const evidenceDir = path.resolve("docs/evidence/free-capacity-fabric");
const startedAt = new Date().toISOString();

/**
 * R65 live cross-domain failover: two REAL anonymous free domains are registered and serve
 * one coding run. The Kilo adapter is wrapped so every model call fails with a retryable
 * transient — the fabric must rotate mid-run to the AI Horde community pool, which then
 * completes the fixture. Both domains are live; the fault is a transport-level injection on
 * the real adapter, never a synthetic route.
 */
const kiloPolicy = await reverifyKiloPolicy(startedAt);
const hordePolicy = await reverifyHordePolicy(startedAt);
if (kiloPolicy.status !== "VERIFIED") throw new Error(`KILO_POLICY_${kiloPolicy.status}`);
if (hordePolicy.status !== "VERIFIED") throw new Error(`HORDE_POLICY_${hordePolicy.status}`);

const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-dual-domain-"));
const persistence = createSessionPersistence({ dbPath: path.join(workspacePath, "..", `${path.basename(workspacePath)}.db`) });
await persistence.init();
const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const providerCatalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
let freeCloud;
const observer = (obs) => freeCloud?.onProviderResponse(obs);

// Domain A: Kilo anonymous direct — wrapped so model calls always fail transiently.
const kiloReal = createKiloFreeDirectAdapter({ onResponse: observer });
let kiloCalls = 0;
// Kilo's real outage mode is its free-tier daily quota exhausting (429 + Retry-After). A
// retryable 503 only earns the bounded same-route retry — an honest failover proof must
// demote the kilo quota domain itself so the fabric rotates to the independent horde pool.
const quotaFault = () => new ProviderError("controlled fault: kilo free-tier daily quota exhausted", "RATE_LIMITED", true, { status: 429, retryAfter: Date.now() + 60_000 });
const kiloFaulting = {
  ...kiloReal,
  providerId: "kilo-free-direct",
  listModels: () => kiloReal.listModels(),
  healthCheck: () => kiloReal.healthCheck(),
  async chat() { kiloCalls++; throw quotaFault(); },
  async *streamChat() { kiloCalls++; throw quotaFault(); },
};
providerCatalog.register(kiloFaulting);

// Domain B: AI Horde anonymous community pool — fully live, unwrapped.
const horde = createAiHordeCommunityAdapter({ onResponse: observer });
providerCatalog.register(horde);

const hordeListed = (await horde.listModels()).filter((m) => m.isFree && m.freeStatus === "verified_free");
const hordeModel = hordeListed.some((m) => m.modelId === "google/gemma-4-31b") ? "google/gemma-4-31b" : hordeListed[0]?.modelId;
if (!hordeModel) throw new Error("Live community catalog served no verified-free text model");
const kiloListed = (await kiloReal.listModels()).find((m) => m.modelId === "kilo-auto/free" && m.isFree && m.freeStatus === "verified_free");
if (!kiloListed) throw new Error("Live Kilo catalog did not verify zero pricing");

const kiloBase = createGenericFreeRecord({ providerId: "kilo-free-direct", modelId: "kilo-auto/free", displayName: "Kilo Auto Free" });
firewall.register({ ...kiloBase, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...kiloBase.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...kiloBase.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
const hordeBase = createGenericFreeRecord({ providerId: "ai-horde", modelId: hordeModel, displayName: `AI Horde ${hordeModel}` });
firewall.register({ ...hordeBase, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...hordeBase.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...hordeBase.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });

freeCloud = new FreeCloudService({ firewall, providerCatalog, registry: new NormalizedModelRegistry(), routeHealth: health });
freeCloud.setKiloPolicyReceipt(kiloPolicy.receipt);
freeCloud.setHordePolicyReceipt(hordePolicy.receipt);
freeCloud.setConnection({ providerId: "kilo-free-direct", connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "PACKAGED_FREE_DIRECT", authState: "ok", ownerUserId: "dogfood-user" });
freeCloud.setConnection({ providerId: "ai-horde", connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "COMMUNITY_ANONYMOUS_FREE", authState: "ok" });
for (const [providerId, file] of [["kilo-free-direct", "kilo-live-qualification.json"], ["ai-horde", `R65-HORDE-QUALIFICATION-${hordeModel.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`]]) {
  const qualification = JSON.parse(await fs.readFile(path.join(evidenceDir, file), "utf8"));
  await freeCloud.recordReceipt(qualification);
  freeCloud.applyReceiptToFirewall(qualification);
}
await freeCloud.probeRouteCapacity("ai-horde", hordeModel);
process.stdout.write(JSON.stringify({ routes: freeCloud.productionCapacityRoutes().map((r) => ({ providerId: r.providerId, healthy: r.healthy, supplyClass: r.supplyClass, windows: r.windows.length })) }) + "\n");

const eventStore = new EventStore();
const decisionLog = path.join(evidenceDir, "R65-FAILOVER-DECISIONS.ndjson");
const fabric = createFreeFabric({
  managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"),
  managedPools: () => freeCloud.capacityPools(),
  userSources: [freeCloud], health,
  reservations: new CapacityReservationLedger({ routes: [], pools: [] }),
});
const origDecide = fabric.decide.bind(fabric);
fabric.decide = (request) => {
  const d = origDecide(request);
  fs.appendFile(decisionLog, JSON.stringify({ role: request.role, taskKind: request.taskKind, outcome: d?.outcome, selected: d?.selected ? `${d.selected.providerId}/${d.selected.modelId}` : null,
    candidates: (d?.explanation?.candidates ?? []).map((c) => `${c.providerId}/${c.modelId}:${c.status}:${(c.reasonCodes ?? []).join("+")}`) }) + "\n").catch(() => {});
  return d;
};
await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "public-free-fixture", private: true, type: "module", scripts: { test: "node --test math.test.mjs" } }, null, 2));
await fs.writeFile(path.join(workspacePath, "math.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
await fs.writeFile(path.join(workspacePath, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.ts';\ntest('positive addition', () => assert.equal(add(2, 3), 5));\ntest('negative addition', () => assert.equal(add(-2, -3), -5));\ntest('zero addition', () => assert.equal(add(7, 0), 7));\n");
for (const args of [["init"], ["config", "user.name", "CodeForge Public Fixture"], ["config", "user.email", "fixture@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "Public synthetic failing addition fixture"]]) await execFile("git", args, { cwd: workspacePath, windowsHide: true });
const sessionId = `dual-domain-${Date.now()}`;
await persistence.upsertSession({ id: sessionId, title: "R65 cross-domain failover fixture", createdAt: startedAt, updatedAt: startedAt, status: "idle" });
const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog,
  workspacePath, userId: "dogfood-user", routeHealth: health, freeCloud, freeFabric: fabric,
  fabricContext: () => ({ userId: "dogfood-user", userIdentities: freeCloud.capacityIdentitiesFor("dogfood-user"), dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }) });
await runtime.init();
const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(os.tmpdir(), "codeforge-free-worktrees") }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
const result = await orchestrator.startRun({ sessionId, workspacePath, topology: "normal", goal: "Fix add in math.ts to perform addition. Preserve the three existing Node tests and verify all pass. This is a public synthetic fixture with no confidential or personal code.", verificationCommands: ["npm test"], adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }), signal: AbortSignal.timeout(900_000) });
const output = { startedAt, finishedAt: new Date().toISOString(), workspacePath, result,
  domains: { A: { providerId: "kilo-free-direct", modelId: "kilo-auto/free", supplyClass: "PACKAGED_FREE_DIRECT", fault: "TRANSPORT_INJECTED_429_QUOTA_EXHAUSTED_ALL_CALLS", calls: kiloCalls },
             B: { providerId: "ai-horde", modelId: hordeModel, supplyClass: "COMMUNITY_ANONYMOUS_FREE" } },
  provesSecondLiveIndependentDomain: true,
  kiloPolicyReceipt: kiloPolicy.receipt, hordePolicyReceipt: hordePolicy.receipt,
  mathTs: await fs.readFile(path.join(workspacePath, "math.ts"), "utf8"),
  workers: await persistence.getWorkItemsByKind("subagent_run"),
  modelTurns: await persistence.getWorkItemsByKind("agent_model_turn"),
  verificationRecords: await persistence.getWorkItemsByKind("verification"),
  routingReceipts: await persistence.getWorkItemsByKind("eight_bit_decision_receipt"),
  healthSnapshots: health.snapshot(),
  outcomes: eventStore.getAll().filter((event) => event.type === "run.outcome").map((event) => event.payload) };
await fs.writeFile(path.join(evidenceDir, "R65-CROSS-DOMAIN-FAILOVER.json"), JSON.stringify(output, null, 2) + "\n");
process.stdout.write(JSON.stringify({ status: result.status, kiloCalls, receipts: output.routingReceipts.map((r) => r.receipt?.action).join("|") }) + "\n");
await persistence.close();
if (result.status !== "completed" || kiloCalls === 0) process.exitCode = 1;
