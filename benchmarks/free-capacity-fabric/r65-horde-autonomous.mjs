import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createAiHordeCommunityAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, reverifyHordePolicy } from "@codeforge/model-registry";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric, runRoleAwareQualification } from "@codeforge/eight-bit";
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from "@codeforge/server";

const execFile = promisify(execFileCallback);
const evidenceDir = path.resolve("docs/evidence/free-capacity-fabric");
const startedAt = new Date().toISOString();
if (process.argv.includes("--inject-domain-failure")) throw new Error("R65 live evidence cannot use a synthetic second domain");
const policy = await reverifyHordePolicy(startedAt);
await fs.writeFile(path.join(evidenceDir, "R65-HORDE-POLICY.json"), JSON.stringify(policy, null, 2) + "\n");
if (policy.status !== "VERIFIED") {
  await fs.writeFile(path.join(evidenceDir, "R65-DOMAIN-B-LIVE.json"), JSON.stringify({ status: "BLOCKED_POLICY_REVERIFICATION", startedAt, policyStatus: policy.status, source: policy.source,
    liveInferenceCalls: 0, costState: "UNKNOWN", tools: false, edits: false, tests: false, Reviewer: false, ForgeVerify: false, completionGate: false }, null, 2) + "\n");
  process.exitCode = 1;
} else {
const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-horde-autonomous-"));
const persistence = createSessionPersistence({ dbPath: path.join(workspacePath, "..", `${path.basename(workspacePath)}.db`) });
await persistence.init();
const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const providerId = "ai-horde";
const providerCatalog = new InMemoryProviderCatalog();
const health = createEightBitRouteHealthAuthority();
let freeCloud;
const adapter = createAiHordeCommunityAdapter({ onResponse: (obs) => freeCloud?.onProviderResponse(obs) });
providerCatalog.register(adapter);
// Prefer the live-validated coding model; the anonymous community pool rotates, so fall back
// to any remaining text model rather than pinning a name that went offline. Community capacity
// blips (503 = no worker online this instant) are retried a bounded number of times.
const PREFERRED = ["google/gemma-4-31b", "aphrodite/DeepSeek-V4.1-Flash"];
let listed;
for (let attempt = 1; attempt <= 4; attempt++) {
  try { listed = await adapter.listModels(); break; }
  catch (e) {
    process.stdout.write(`listModels attempt ${attempt} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
    if (attempt === 4) throw e;
    await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
  }
}
const free = listed.filter((model) => model.isFree && model.freeStatus === "verified_free");
const modelId = PREFERRED.find((id) => free.some((model) => model.modelId === id)) ?? free[0]?.modelId;
if (!modelId) throw new Error("Live community catalog served no verified-free text model");
const base = createGenericFreeRecord({ providerId, modelId, displayName: `AI Horde ${modelId}` });
firewall.register({ ...base, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...base.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...base.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
freeCloud = new FreeCloudService({ firewall, providerCatalog, registry: new NormalizedModelRegistry(), routeHealth: health });
freeCloud.setHordePolicyReceipt(policy.receipt);
freeCloud.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "COMMUNITY_ANONYMOUS_FREE", authState: "ok", ownerUserId: "dogfood-user" });
const safeModel = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
const qualificationPath = path.join(evidenceDir, `R65-HORDE-QUALIFICATION-${safeModel}.json`);
let qualification;
try { qualification = JSON.parse(await fs.readFile(qualificationPath, "utf8")); } catch { /* A missing receipt requires real probes. */ }
try { qualification ??= JSON.parse(await fs.readFile(path.join(evidenceDir, "R65-HORDE-QUALIFICATION.json"), "utf8")); } catch { /* legacy shared name */ }
if (qualification && qualification.modelId !== modelId) qualification = undefined;
if (!qualification || Date.now() - Date.parse(qualification.completedAt) > 86_400_000) {
  process.stdout.write("Running real bounded role qualification\n");
  qualification = await runRoleAwareQualification(firewall.getModel(providerId, modelId), adapter, { signal: AbortSignal.timeout(900_000) });
  await fs.writeFile(qualificationPath, JSON.stringify(qualification, null, 2) + "\n");
}
await freeCloud.recordReceipt(qualification);
await fs.writeFile(qualificationPath, JSON.stringify({ ...qualification, r65QualificationSource: qualification.completedAt < startedAt ? "CURRENT_INHERITED_ROLE_RECEIPT" : "R65_LIVE_PROBES" }, null, 2) + "\n");
freeCloud.applyReceiptToFirewall(qualification);
// The community pool's only honest capacity meter is the provider-reported concurrency —
// without the account probe the route stays CAPACITY_UNMEASURED and admits nothing.
await freeCloud.probeRouteCapacity(providerId, modelId);
process.stdout.write(JSON.stringify({ qualification: qualification.qualificationState, roles: Object.fromEntries(Object.entries(qualification.roleResults).map(([role, result]) => [role, result.status])), routes: freeCloud.productionCapacityRoutes().filter((route) => route.providerId === providerId).map(({ healthy, roles, healthGate, windows }) => ({ healthy, roles, healthGate, windows: windows.length })) }) + "\n");
const eventStore = new EventStore();
// Same split the production server wires: shared-pool supply flows through managedRoutes,
// per-user pools through userSources. COMMUNITY_ANONYMOUS_FREE is a SHARED_OWNER_POOL — it
// must never appear under a user identity.
const fabric = createFreeFabric({ managedRoutes: () => freeCloud.productionCapacityRoutes().filter((route) => route.capacityPoolScope !== "PER_USER_POOL"), userSources: [freeCloud], health,
  reservations: new CapacityReservationLedger({ routes: [], pools: [] }) });
await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "public-free-fixture", private: true, type: "module", scripts: { test: "node --test math.test.mjs" } }, null, 2));
await fs.writeFile(path.join(workspacePath, "math.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
await fs.writeFile(path.join(workspacePath, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.ts';\ntest('positive addition', () => assert.equal(add(2, 3), 5));\ntest('negative addition', () => assert.equal(add(-2, -3), -5));\ntest('zero addition', () => assert.equal(add(7, 0), 7));\n");
for (const args of [["init"], ["config", "user.name", "CodeForge Public Fixture"], ["config", "user.email", "fixture@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "Public synthetic failing addition fixture"]]) await execFile("git", args, { cwd: workspacePath, windowsHide: true });
const sessionId = `horde-autonomous-${Date.now()}`;
await persistence.upsertSession({ id: sessionId, title: "Public Free autonomous fixture", createdAt: startedAt, updatedAt: startedAt, status: "idle" });
const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog,
  workspacePath, userId: "dogfood-user", routeHealth: health, freeCloud, freeFabric: fabric,
  fabricContext: () => ({ userId: "dogfood-user", userIdentities: freeCloud.capacityIdentitiesFor("dogfood-user"), dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }) });
await runtime.init();
const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(os.tmpdir(), "codeforge-free-worktrees") }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
const result = await orchestrator.startRun({ sessionId, workspacePath, topology: "normal", goal: "Fix add in math.ts to perform addition. Preserve the three existing Node tests and verify all pass. This is a public synthetic fixture with no confidential or personal code.", verificationCommands: ["npm test"], adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }), signal: AbortSignal.timeout(900_000) });
const output = { startedAt, finishedAt: new Date().toISOString(), workspacePath, providerId, modelId, qualificationAt: qualification.completedAt, result,
  userTestIdentity: "dogfood-user", credentialClass: "ANONYMOUS_DIRECT", quotaOwnerClass: "GLOBAL_COMMUNITY",
  provenanceReceipt: policy.receipt, costState: "UNKNOWN", independenceGroup: freeCloud.productionCapacityRoutes().find((route) => route.providerId === providerId && route.modelId === modelId)?.independenceKey,
  faultInjection: { enabled: false, requests: 0, domain: null, provesSecondLiveIndependentDomain: false },
  mathTs: await fs.readFile(path.join(workspacePath, "math.ts"), "utf8"),
  workers: await persistence.getWorkItemsByKind("subagent_run"),
  modelTurns: await persistence.getWorkItemsByKind("agent_model_turn"),
  verificationRecords: await persistence.getWorkItemsByKind("verification"),
  routingReceipts: await persistence.getWorkItemsByKind("eight_bit_decision_receipt"),
  healthSnapshots: health.snapshot(),
  outcomes: eventStore.getAll().filter((event) => event.type === "run.outcome").map((event) => event.payload) };
await fs.writeFile(path.join(evidenceDir, "R65-DOMAIN-B-LIVE.json"), JSON.stringify(output, null, 2) + "\n");
process.stdout.write(JSON.stringify({ workspacePath, status: result.status, review: result.review, completion: result.completion, integration: result.integration, counters: result.counters }) + "\n");
await persistence.close();
if (result.status !== "completed") process.exitCode = 1;
}
