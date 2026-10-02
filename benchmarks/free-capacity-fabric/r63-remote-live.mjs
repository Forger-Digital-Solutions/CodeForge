import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { ForgeZero, CapacityReservationLedger, createGenericFreeRecord } from "@codeforge/forge-zero";
import { createKiloFreeDirectAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry } from "@codeforge/model-registry";
import { createSessionPersistence, EventStore } from "@codeforge/sessions";
import { createEightBitRouteHealthAuthority, createFreeFabric } from "@codeforge/eight-bit";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { signAccessToken, hashRefreshToken, generateRefreshToken } from "@codeforge/cloud-auth";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { RemoteDirectHttpClient, RemoteDirectProviderAdapter, createRemoteDirectFabricAdmission,
  createAgentRuntime, createWorkspaceService, createWorkspaceEventAdapter, createAutonomousRunOrchestrator } from "@codeforge/server";

const startedAt = new Date().toISOString();
const evidenceDir = path.resolve("docs/evidence/free-capacity-fabric");
const policy = JSON.parse(await fs.readFile(path.join(evidenceDir, "R63-KILO-POLICY.json"), "utf8"));
const qualification = JSON.parse(await fs.readFile(path.join(evidenceDir, "R63-KILO-QUALIFICATION.json"), "utf8"));
if (policy.status !== "VERIFIED" || Date.parse(policy.receipt.nextReverifyAt) <= Date.now()
  || Date.now() - Date.parse(qualification.completedAt) > 86_400_000) throw new Error("Current live Domain A receipts are required");
const accountId = "dogfood-user";
const deviceId = "r63-remote-device";
const workspaceId = "r63-public-math";
const providerId = "kilo-free-direct";
const modelId = "kilo-auto/free";
const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r63-remote-"));
const persistence = createSessionPersistence({ dbPath: path.join(workspacePath, "..", `${path.basename(workspacePath)}.db`) });
await persistence.init();
const firewall = new ForgeZero();
firewall.setPrivacyMode("MAXIMUM_FREE");
const direct = createKiloFreeDirectAdapter();
const liveModel = (await direct.listModels()).find((model) => model.modelId === modelId && model.isFree && model.freeStatus === "verified_free");
if (!liveModel) throw new Error("Live anonymous Kilo catalog did not verify zero pricing");
const base = createGenericFreeRecord({ providerId, modelId, displayName: "Kilo Auto Free" });
firewall.register({ ...base, accessClass: "FREE_ROUTED", privacyClass: "permissive", freeStatusVerifiedAt: startedAt,
  capabilities: { ...base.capabilities, toolCalling: true, structuredOutput: true },
  costProfile: { ...base.costProfile, isFree: true, inputCostPerMillion: 0, outputCostPerMillion: 0, paidFallbackPossible: false, paidFallbackDisabled: true } });
const catalog = new InMemoryProviderCatalog();
catalog.register(direct);
const health = createEightBitRouteHealthAuthority();
const freeCloud = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), routeHealth: health });
freeCloud.setKiloPolicyReceipt(policy.receipt);
freeCloud.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: accountId });
await freeCloud.recordReceipt(qualification);
freeCloud.applyReceiptToFirewall(qualification);
const route = freeCloud.routesForUser(accountId).find((candidate) => candidate.modelId === modelId);
if (!route) throw new Error("Current admitted Domain A route missing");
const guard = createFreeFabric({ managedRoutes: () => [], userSources: [freeCloud], health });
const dataContext = { dataClass: "PUBLIC_CODE", userConsented: true };
const jwtSecret = (await import("node:crypto")).randomBytes(32).toString("base64url");
let cloud;
const roleMap = { CODER: "PRIMARY_CODING_AGENT", REVIEWER: "REVIEWER", PLANNER: "PLANNER", EXPLORER: "SUBAGENT", TOOL_AGENT: "SUBAGENT" };
const authorize = async (binding) => (await cloud.hostedWorkflowAuthority.list(binding.accountId)).some((workflow) => workflow.workerId === binding.deviceId && workflow.workspaceId === binding.workspaceId && workflow.status === "active");
cloud = new CodeForgeCloudServer({ db: new SQLiteCloudDatabase({ dbPath: ":memory:" }), jwtSecret, stripeConfig: null, logLevel: "silent", sessionPersistence: persistence,
  remoteDirectScopeAuthorization: (principal, scope) => authorize({ accountId: principal.accountId, ...scope }),
  remoteDirectAdmission: createRemoteDirectFabricAdmission({ fabric: guard,
    authorizeScope: async (binding) => !!roleMap[binding.role] && qualification.roleResults[binding.role]?.status === "QUALIFIED" && await authorize(binding),
    context: (binding) => ({ role: roleMap[binding.role], healthRole: binding.role, userIdentities: freeCloud.capacityIdentitiesFor(binding.accountId), dataContext }) }) });
const port = await cloud.start(0);
await cloud.db.createUser({ id: accountId, displayName: "R63 remote public fixture", primaryIdentity: "github:r63-local-test-identity" });
const identitySession = await cloud.db.createDeviceSession({ userId: accountId, deviceName: deviceId, refreshTokenHash: hashRefreshToken(generateRefreshToken()), expiresInSeconds: 3_600 });
const token = signAccessToken({ sub: accountId, sid: identitySession.id }, jwtSecret);
const workflow = await cloud.hostedWorkflowAuthority.create({ ownerUserId: accountId, workerId: deviceId, workspaceId, task: "Public math fixture remote inference" });
const provider = new RemoteDirectProviderAdapter(cloud.remoteDirectTransport, (context) => context.userId === accountId ? {
  accountId, deviceId, workspaceId, runId: context.metadata?.runId ?? context.turnId ?? workflow.id,
  routeId: route.routeId, quotaDomainId: route.capacityPoolId, role: context.metadata?.role ?? "CODER" } : undefined);
catalog.register(provider);
const client = new RemoteDirectHttpClient({ cloudUrl: `http://127.0.0.1:${port}`, getAccessToken: () => token, deviceId, workspaceId,
  routeAllowed: (assignment) => assignment.accountId === accountId && assignment.quotaDomainId === route.capacityPoolId && assignment.workspaceId === workspaceId });
const workerAbort = new AbortController();
await client.connect();
const worker = client.run(workerAbort.signal).catch((error) => { console.error(error.message); workerAbort.abort(); });
const execFile = promisify(callback);
await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "r63-public-remote-fixture", private: true, type: "module", scripts: { test: "node --test math.test.mjs" } }));
await fs.writeFile(path.join(workspacePath, "math.ts"), "export function add(a: number, b: number): number { return a - b; }\n");
await fs.writeFile(path.join(workspacePath, "math.test.mjs"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.ts';\ntest('positive addition', () => assert.equal(add(2, 3), 5));\ntest('negative addition', () => assert.equal(add(-2, -3), -5));\ntest('zero addition', () => assert.equal(add(7, 0), 7));\n");
for (const args of [["init"], ["config", "user.name", "CodeForge Public Fixture"], ["config", "user.email", "fixture@codeforge.invalid"], ["config", "commit.gpgsign", "false"], ["add", "."], ["commit", "-m", "Public remote fixture"]]) await execFile("git", args, { cwd: workspacePath, windowsHide: true });
const sessionId = workflow.sessionId;
const eventStore = new EventStore();
const fabric = createFreeFabric({ managedRoutes: () => [], userSources: [freeCloud], health, reservations: new CapacityReservationLedger({ routes: [], pools: [] }) });
const runtime = createAgentRuntime({ sessionId, eventStore, persistence, firewall, providerCatalog: catalog, workspacePath, userId: accountId, routeHealth: health, freeCloud, freeFabric: fabric,
  fabricContext: () => ({ userId: accountId, userIdentities: freeCloud.capacityIdentitiesFor(accountId), dataContext }) });
await runtime.init();
const orchestrator = createAutonomousRunOrchestrator({ workspaceService: createWorkspaceService({ persistence, worktreeParentDir: path.join(os.tmpdir(), "codeforge-r63-remote-worktrees") }), persistence, agentRuntime: runtime, subagentsR1Enabled: true });
try {
  const result = await orchestrator.startRun({ sessionId, workspacePath, topology: "normal", goal: "Fix add in math.ts to perform addition. Preserve the three existing Node tests and verify all pass. This is a public synthetic fixture with no confidential or personal code.", verificationCommands: ["npm test"], adapter: createWorkspaceEventAdapter({ sessionId, eventStore, persistence }), signal: AbortSignal.timeout(600_000) });
  const jobs = await persistence.getWorkItemsByKind("remote_direct_job");
  const output = { startedAt, finishedAt: new Date().toISOString(), status: result.status, transport: "REAL_LOOPBACK_HOSTED_HTTP", upstream: "LIVE_ANONYMOUS_KILO", identityBootstrap: "LOCAL_SIGNED_AUTHENTICATED_TEST_DEVICE_SESSION_NOT_BROWSER_LOGIN",
    providerId, modelId, quotaDomainId: route.capacityPoolId, independenceGroup: route.independenceKey, quotaOwnerClass: "EGRESS_IP", provesSecondDomain: false,
    provenanceReceipt: policy.receipt, qualificationAt: qualification.completedAt, costState: "UNKNOWN", workspacePath, result,
    transportReceipts: jobs.filter((job) => job.kind === "remote_direct_job").map((job) => ({ jobId: job.id, runId: job.runId, role: job.role, state: job.state, attempts: job.attempts, assignment: job.assignment, feedback: job.feedback, createdAt: job.createdAt, updatedAt: job.updatedAt })),
    workers: await persistence.getWorkItemsByKind("subagent_run"), verificationRecords: await persistence.getWorkItemsByKind("verification"),
    routingReceipts: await persistence.getWorkItemsByKind("eight_bit_decision_receipt"), mathTs: await fs.readFile(path.join(workspacePath, "math.ts"), "utf8") };
  await fs.writeFile(path.join(evidenceDir, "R63-REMOTE-LIVE-LOCAL.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ status: result.status, review: result.review, completion: result.completion, integration: result.integration, transportRequests: jobs.length }));
  if (result.status !== "completed") process.exitCode = 1;
} finally { workerAbort.abort(); await worker; await cloud.stop(); await persistence.close(); }
