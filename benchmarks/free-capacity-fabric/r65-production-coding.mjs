import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, CapacityReservationLedger } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createKiloFreeDirectAdapter } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, reverifyKiloPolicy } from "@codeforge/model-registry";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric } from "@codeforge/eight-bit";
import { createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator,
  RemoteDirectHttpClient, RemoteDirectCloudProviderAdapter } from "@codeforge/server";
const execFile = promisify(execFileCallback);

export async function runProductionCoding({ cloudUrl, accessToken, userId, request }) {
  const startedAt = new Date().toISOString();
  const policy = await reverifyKiloPolicy(startedAt);
  if (policy.status !== "VERIFIED") throw new Error("KILO_POLICY_UNVERIFIED");
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r65-remote-coding-"));
  const persistence = createSessionPersistence({ dbPath: path.join(workspacePath, "..", `${path.basename(workspacePath)}.db`) });
  await persistence.init();
  const firewall = new ForgeZero();
  firewall.setPrivacyMode("MAXIMUM_FREE");
  const providerId = "kilo-free-direct", modelId = "kilo-auto/free";
  const direct = createKiloFreeDirectAdapter();
  const listed = (await direct.listModels()).find((model) => model.modelId === modelId && model.isFree && model.freeStatus === "verified_free");
  if (!listed) throw new Error("KILO_PRICE_UNVERIFIED");
  firewall.register({ providerId, modelId, displayName: listed.displayName, tier: "free", accessClass: "FREE_ROUTED", privacyClass: "permissive",
    freeStatus: "verified_free", freeStatusVerifiedAt: startedAt, capabilities: listed.capabilities, contextWindow: listed.contextWindow,
    isRemote: true, isCloudHosted: true, verificationSource: "live anonymous Kilo catalog",
    costProfile: { isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, freeTierVerifiedAt: startedAt, paidFallbackPossible: false, paidFallbackDisabled: true },
    health: { status: "available", lastCheckedAt: startedAt } });
  const catalog = new InMemoryProviderCatalog();
  const health = createEightBitRouteHealthAuthority();
  const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
  freeCloud.setKiloPolicyReceipt(policy.receipt);
  freeCloud.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: userId });
  const qualification = JSON.parse(await fs.readFile("docs/evidence/free-capacity-fabric/R64-LIVE-QUALIFICATION.json", "utf8"));
  await freeCloud.recordReceipt(qualification);
  freeCloud.applyReceiptToFirewall(qualification);
  const deviceId = `r65-coding-device-${Date.now()}`, workspaceId = `r65-public-fixture-${Date.now()}`;
  const created = await request("/v1/workflows", { workerId: deviceId, workspaceId, publicCodeConsent: true, task: "Fix public synthetic addition fixture through authenticated remote Free inference." });
  if (created.status !== 201 || !created.data.id) throw new Error("WORKFLOW_CREATE_FAILED");
  const workflowId = created.data.id;
  catalog.register(new RemoteDirectCloudProviderAdapter({ cloudUrl, getAccessToken: () => accessToken, workflowId, ownerUserId: userId }));
  const frames = [];
  const cloudFetch = async (url, init) => {
    const response = await fetch(url, init);
    const data = await response.clone().json().catch(() => ({}));
    const pathname = new URL(url).pathname;
    frames.push({ at: new Date().toISOString(), path: pathname, status: response.status,
      ...(pathname.endsWith("/poll") && Array.isArray(data) ? { assignments: data.map((item) => ({ jobId: item.jobId, assignmentId: item.signed?.assignment?.requestId, runId: item.signed?.assignment?.runId, sessionId: item.signed?.assignment?.sessionId, workspaceId: item.signed?.assignment?.workspaceId })) } : {}) });
    return response;
  };
  const client = new RemoteDirectHttpClient({ cloudUrl, getAccessToken: () => accessToken, deviceId, workspaceId, cloudFetch,
    routeAllowed: (assignment) => assignment.accountId === userId && assignment.workspaceId === workspaceId && assignment.runId === workflowId && assignment.provider === providerId && assignment.model === modelId });
  const workerController = new AbortController();
  const worker = client.run(workerController.signal);
  const eventStore = new EventStore();
  const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [freeCloud], health, reservations: new CapacityReservationLedger({ routes: [], pools: [] }) });
  await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "r65-public-remote-fixture", private: true, type: "module", scripts: { test: "node --test math.test.mjs" } }));
  await fs.writeFile(path.join(workspacePath, "math.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
  await fs.writeFile(path.join(workspacePath, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.ts';\ntest('positive addition', () => assert.equal(add(2, 3), 5));\ntest('negative addition', () => assert.equal(add(-2, -3), -5));\ntest('zero addition', () => assert.equal(add(7, 0), 7));\n");
  for (const args of [["init"], ["config", "user.name", "CodeForge Public Fixture"], ["config", "user.email", "fixture@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "Public synthetic failing addition fixture"]]) await execFile("git", args, { cwd: workspacePath, windowsHide: true });
  const sessionId = workflowId;
  await persistence.upsertSession({ id: sessionId, title: "R65 production remote coding", createdAt: startedAt, updatedAt: startedAt, status: "idle" });
  const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath, userId, routeHealth: health, freeCloud, freeFabric: fabric,
    fabricContext: () => ({ userId, userIdentities: freeCloud.capacityIdentitiesFor(userId), dataContext: { dataClass: "PUBLIC_CODE", userConsented: true } }) });
  await runtime.init();
  try {
    const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(os.tmpdir(), "codeforge-r65-remote-worktrees") }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
    const result = await orchestrator.startRun({ sessionId, workspacePath, topology: "normal", goal: "Fix add in math.ts to perform addition. Preserve all three existing tests and verify them. This is a public synthetic fixture.", verificationCommands: ["npm test"], adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }), signal: AbortSignal.timeout(600_000) });
    const output = { startedAt, finishedAt: new Date().toISOString(), workflowId, workspaceId, deviceId, sessionId, workspacePath, providerId, modelId,
      topology: "Cloud authenticates, admits and persists inference assignments. Remote worker performs anonymous cloud inference. Governed local runtime executes proposed tools, independent Reviewer, ForgeVerify, completion and integration.",
      result, frames, source: await fs.readFile(path.join(workspacePath, "math.ts"), "utf8"), verification: await persistence.getWorkItemsByKind("verification"), workers: await persistence.getWorkItemsByKind("subagent_run"), costState: "ZERO_PRICE_PROVENANCE_NO_PROVIDER_BILL_RECEIPT", paidFallback: 0, BYOKFallback: 0 };
    await fs.writeFile("docs/evidence/free-capacity-fabric/R65-PRODUCTION-REMOTE-CODING.json", `${JSON.stringify(output, null, 2)}\n`);
    return { status: result.status, workflowId, assignments: frames.flatMap((frame) => frame.assignments ?? []).length };
  } finally {
    workerController.abort(); await worker.catch(() => {});
    await request(`/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, {}).catch(() => {});
    await runtime.dispose(); await persistence.close();
  }
}
