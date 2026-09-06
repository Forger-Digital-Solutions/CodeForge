import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { EventStore, createSessionPersistence, type SessionPersistence } from "@codeforge/sessions";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog } from "@codeforge/providers";
import { ERROR_CODES } from "@codeforge/agent";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createDeliveryService } from "../src/delivery-service.js";
import { DELIVERY_ERRORS, deliveryDigest } from "../src/delivery-state.js";
import { MissionProvider, reviewerPass } from "./helpers/mission-fixture.js";

const execFile = promisify(execFileCallback);
const owned: string[] = [];
const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

interface Fixture {
  root: string;
  worktrees: string;
  base: string;
  source: string;
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf10c-repo-"));
  const worktrees = await fs.mkdtemp(path.join(os.tmpdir(), "cf10c-worktrees-"));
  owned.push(root, worktrees);
  await execFile("git", ["init", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root });
  await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/client.test.mjs" } }));
  await fs.writeFile(path.join(root, "AGENTS.md"), "# local policy\n- node --test test/client.test.mjs\n");
  await fs.writeFile(path.join(root, "src", "client.mjs"), "export function retries() { return 3; }\n");
  await fs.writeFile(path.join(root, "test", "client.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { retries } from '../src/client.mjs'; test('default', () => assert.equal(retries(), 3));\n");
  await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "base"], { cwd: root });
  const base = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "src", "client.mjs"), "export function retries(limit = 3) { return limit; }\n");
  await fs.writeFile(path.join(root, "test", "client.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { retries } from '../src/client.mjs'; test('default', () => assert.equal(retries(), 3)); test('configurable', () => assert.equal(retries(7), 7));\n");
  await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "certified source"], { cwd: root });
  return { root, worktrees, base, source: await git(root, ["rev-parse", "HEAD"]) };
}

async function deliveryHarness(f: Fixture, options: {
  source?: string;
  persistence?: SessionPersistence;
  sessionId?: string;
  deliveryId?: string;
  getAgentRuntime?: ReturnType<typeof createDeliveryService>["options"]["getAgentRuntime"];
  reviewer?: (delivery: never) => Promise<{ verdict: "pass" | "blocked" | "code_repair_required"; findings: string[] }>;
  onEvent?: Parameters<typeof createDeliveryService>[0]["onEvent"];
} = {}) {
  const persistence = options.persistence ?? createSessionPersistence();
  const sessionId = options.sessionId ?? "cf10c";
  const now = new Date().toISOString();
  persistence.upsertSession({ id: sessionId, title: "CF-10C", status: "running", createdAt: now, updatedAt: now });
  const workspaces = createWorkspaceService({ persistence, worktreeParentDir: f.worktrees });
  const workspace = await workspaces.registerLocalWorkspace(f.root);
  const mission = { id: `mission-${sessionId}`, sessionId, workspaceId: workspace.id, status: "completed", finalRevision: options.source ?? f.source, baseRevision: f.base, acceptanceCriteria: [{ id: "AC-1", mandatory: true, status: "proven" }] };
  const delivery = createDeliveryService({ workspaceService: workspaces, persistence, findMission: () => mission as never, ...(options.getAgentRuntime ? { getAgentRuntime: options.getAgentRuntime } : {}), ...(options.reviewer ? { reviewer: options.reviewer as never } : {}), ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
  return { persistence, workspaces, workspace, mission, delivery };
}

async function commit(root: string, title: string): Promise<string> {
  await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", title], { cwd: root });
  return git(root, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  while (owned.length) await fs.rm(owned.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("CF-10C adversarial delivery certification", () => {
  it.each([
    ["API token", "src/token.mjs", "export const token = 'sk-FakeDeliveryToken123456';\n", "sk_key"],
    ["private key", "src/key.pem", "-----BEGIN PRIVATE KEY-----\nFAKE-ONLY\n-----END PRIVATE KEY-----\n", "private_key"],
    ["cloud credential", "src/cloud.mjs", "export const key = 'AKIA1234567890ABCDEF';\n", "aws_access_key"],
    ["new-file secret", "new-secret.mjs", "export const bearer = 'Bearer nonfunctional_delivery_token_123';\n", "bearer"],
    ["diff-only secret", "src/client.mjs", "export function retries(limit = 3) { return limit; }\nexport const bearer = 'Bearer nonfunctional_delivery_token_123';\n", "bearer"],
  ])("blocks %s through the real delivery secret gate without creating a package", async (_name, relative, content, findingType) => {
    const f = await fixture();
    await fs.mkdir(path.dirname(path.join(f.root, relative)), { recursive: true });
    await fs.writeFile(path.join(f.root, relative), content);
    const source = await commit(f.root, "synthetic secret input");
    const events: string[] = [];
    const h = await deliveryHarness(f, { source, onEvent: (event) => events.push(event.type) });
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    expect(result.status).toBe("blocked");
    expect(result.error).toBe(DELIVERY_ERRORS.DELIVERY_SECRET_DETECTED);
    expect(result.secretFindings?.some((finding) => finding.type === findingType)).toBe(true);
    expect(events).toContain("delivery.secret.detected");
    expect(result.reviewPackage).toBeUndefined();
    expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(source);
    await h.persistence.close();
  });

  it("permits a non-secret high-entropy fixture through the same gate", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "src", "fixture.mjs"), "export const fixtureId = 'd9e8c7b6a5f40123456789abcdef0123456789abcdef';\n");
    const source = await commit(f.root, "non secret fixture");
    const h = await deliveryHarness(f, { source });
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    expect(result.status, result.error).toBe("ready");
    expect(result.secretFindings).toBeUndefined();
    await h.persistence.close();
  });

  it("records a real policy-derived verification command failure and blocks before review", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "AGENTS.md"), "- node --test test/fail.test.mjs\n");
    await fs.writeFile(path.join(f.root, "test", "fail.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1, 2));\n");
    const source = await commit(f.root, "failing delivery verification");
    const h = await deliveryHarness(f, { source });
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    expect(result.status).toBe("blocked");
    expect(result.error).toBe(DELIVERY_ERRORS.DELIVERY_VERIFICATION_FAILED);
    expect(result.verification).toContainEqual(expect.objectContaining({ command: "node --test test/fail.test.mjs", exitCode: 1 }));
    expect(result.reviewPackage).toBeUndefined();
    expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(source);
    await h.persistence.close();
  });

  it("creates the same logical commit plan for repeated certified input and changes it for changed input", async () => {
    const f = await fixture();
    const first = await deliveryHarness(f, { sessionId: "determinism-one" });
    const one = await first.delivery.createDelivery({ missionId: first.mission.id, deliveryId: "delivery-determinism-one" });
    const second = await deliveryHarness(f, { sessionId: "determinism-two" });
    const two = await second.delivery.createDelivery({ missionId: second.mission.id, deliveryId: "delivery-determinism-two" });
    expect(one.commitPlan).toEqual(two.commitPlan);
    expect(one.commits.map(({ sha: _sha, ...commit }) => commit)).toEqual(two.commits.map(({ sha: _sha, ...commit }) => commit));
    await fs.writeFile(path.join(f.root, "docs.md"), "materially different source\n");
    const changedSource = await commit(f.root, "different delivery input");
    const third = await deliveryHarness(f, { source: changedSource, sessionId: "determinism-three" });
    const three = await third.delivery.createDelivery({ missionId: third.mission.id, deliveryId: "delivery-determinism-three" });
    expect(three.commitPlan).not.toEqual(one.commitPlan);
    first.persistence.close(); second.persistence.close(); third.persistence.close();
  }, 60_000);

  it("fails closed when a controlled pre-finalization mutation makes the delivered tree differ", async () => {
    const f = await fixture();
    let h: Awaited<ReturnType<typeof deliveryHarness>>;
    h = await deliveryHarness(f, { onEvent: async (event) => {
      if (event.type !== "delivery.packaging.started") return;
      const active = await h.delivery.getDelivery(event.deliveryId)!;
      const child = h.workspaces.getWorkspace(active.deliveryWorkspaceId!)!;
      writeFileSync(path.join(child.rootPath, "src", "client.mjs"), "export function retries() { return 999; }\n");
    } });
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    expect(result.status).toBe("blocked");
    expect(result.error).toBe(DELIVERY_ERRORS.DELIVERY_TREE_MISMATCH);
    expect(result.sourceTree).not.toBe(result.deliveryTree);
    expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(f.source);
    await h.persistence.close();
  });

  it("preserves dirty staged user work in the main checkout while packaging in an isolated delivery worktree", async () => {
    const f = await fixture();
    const userPath = path.join(f.root, "user-draft.txt");
    await fs.writeFile(userPath, "unrelated user work\n"); await execFile("git", ["add", "user-draft.txt"], { cwd: f.root });
    const statusBefore = await git(f.root, ["status", "--porcelain=v1"]); const hashBefore = await git(f.root, ["hash-object", "user-draft.txt"]); const stashesBefore = await git(f.root, ["stash", "list"]);
    const h = await deliveryHarness(f);
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    const child = h.workspaces.getWorkspace(result.deliveryWorkspaceId!)!;
    expect(result.status).toBe("ready");
    expect(await git(f.root, ["status", "--porcelain=v1"])).toBe(statusBefore);
    expect(await git(f.root, ["hash-object", "user-draft.txt"])).toBe(hashBefore);
    expect(await git(f.root, ["stash", "list"])).toBe(stashesBefore);
    expect(child.rootPath.startsWith(path.resolve(f.root) + path.sep)).toBe(false);
    expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(f.source);
    await h.persistence.close();
  });

  it("delivers deletion, rename, and binary content with equivalent final tree semantics", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "obsolete.txt"), "remove me\n");
    await fs.writeFile(path.join(f.root, "rename-old.txt"), "rename me\n");
    await commit(f.root, "add change classes");
    const changeBase = await git(f.root, ["rev-parse", "HEAD"]);
    await fs.rm(path.join(f.root, "obsolete.txt"));
    await fs.rename(path.join(f.root, "rename-old.txt"), path.join(f.root, "rename-new.txt"));
    const binary = Buffer.from([0, 255, 1, 2, 250, 4, 0, 128]);
    await fs.writeFile(path.join(f.root, "asset.bin"), binary);
    const source = await commit(f.root, "delete rename binary");
    const h = await deliveryHarness(f, { source }); h.mission.baseRevision = changeBase;
    const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    const child = h.workspaces.getWorkspace(result.deliveryWorkspaceId!)!;
    expect(result.status, result.error).toBe("ready");
    expect(result.analysis?.deleted).toContain("obsolete.txt");
    expect(result.analysis?.renamed).toContainEqual({ from: "rename-old.txt", to: "rename-new.txt" });
    await expect(fs.stat(path.join(child.rootPath, "obsolete.txt"))).rejects.toThrow();
    expect(await git(child.rootPath, ["show", "HEAD:rename-new.txt"])).toBe(await git(f.root, ["show", `${source}:rename-new.txt`]));
    expect(await fs.readFile(path.join(child.rootPath, "asset.bin"))).toEqual(binary);
    expect(result.sourceTree).toBe(result.deliveryTree);
    await h.persistence.close();
  });

  it("denies traversal, absolute-path, and sibling-worktree writes through an AgentRuntime using a real delivery workspace", async () => {
    const f = await fixture();
    const h = await deliveryHarness(f); const result = await h.delivery.createDelivery({ missionId: h.mission.id });
    const child = h.workspaces.getWorkspace(result.deliveryWorkspaceId!)!;
    const sibling = await h.workspaces.createWorktree({ parentWorkspaceId: h.workspace.id, base: "head", runId: "cf10c-sibling", label: "sibling" });
    const external = path.join(os.tmpdir(), `cf10c-outside-${Date.now()}.txt`); owned.push(external);
    const targets = ["../../outside.txt", external, path.join(sibling.rootPath, "sibling.txt")]; let targetIndex = 0;
    const provider = new MissionProvider((context) => context.role === "coder" && context.call === 1 ? { write: { path: targets[targetIndex++]!, content: "forbidden" } } : { text: "done" });
    const catalog = new InMemoryProviderCatalog(); catalog.register(provider); const firewall = new ForgeZero(); firewall.register(createGenericFreeRecord());
    const runtime = createAgentRuntime({ sessionId: "cf10c-path", eventStore: new EventStore(), persistence: h.persistence, firewall, providerCatalog: catalog, workspacePath: child.rootPath });
    const childHead = await git(child.rootPath, ["rev-parse", "HEAD"]); const siblingHead = await git(sibling.rootPath, ["rev-parse", "HEAD"]);
    for (const index of [0, 1, 2]) {
      const run = await runtime.executeAgentRun({ runId: `cf10c-path-${index}`, agentId: "coder", role: "coder", goal: `attempt escape ${index}`, workspaceId: child.id, workspacePath: child.rootPath, permissions: { read: true, search: true, write: true, executeCommand: false, network: false } });
      expect(run.toolExecutions.some((entry) => (entry.error ?? "").match(new RegExp(`${ERROR_CODES.TOOL_PATH_ESCAPE}|${ERROR_CODES.TOOL_WORKSPACE_ESCAPE}`)))).toBe(true);
    }
    await expect(fs.stat(external)).rejects.toThrow(); await expect(fs.stat(path.join(sibling.rootPath, "sibling.txt"))).rejects.toThrow();
    expect(await git(child.rootPath, ["rev-parse", "HEAD"])).toBe(childHead); expect(await git(child.rootPath, ["status", "--porcelain"])).toBe(""); expect(await git(sibling.rootPath, ["rev-parse", "HEAD"])).toBe(siblingHead);
    await h.persistence.close();
  });

  it("does not replay terminal commits, leases, or reviewer execution after durable restart", async () => {
    const f = await fixture(); const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf10c-state-")); owned.push(stateDir); const dbPath = path.join(stateDir, "delivery.sqlite");
    const durable = createSessionPersistence({ dbPath }); let reviewerCalls = 0;
    const first = await deliveryHarness(f, { persistence: durable, sessionId: "terminal", reviewer: async () => { reviewerCalls++; return { verdict: "pass", findings: [] }; } });
    const ready = await first.delivery.createDelivery({ missionId: first.mission.id, deliveryId: "delivery-terminal" }); const child = first.workspaces.getWorkspace(ready.deliveryWorkspaceId!)!;
    const evidence = { commits: ready.commits.map((item) => item.sha), tree: ready.deliveryTree, review: JSON.stringify(ready.reviewPackage), head: await git(child.rootPath, ["rev-parse", "HEAD"]) };
    await durable.close();
    const recoveredPersistence = createSessionPersistence({ dbPath }); const recovered = await deliveryHarness(f, { persistence: recoveredPersistence, sessionId: "terminal", reviewer: async () => { reviewerCalls++; return { verdict: "pass", findings: [] }; } });
    const after = await recovered.delivery.resumeDelivery("delivery-terminal"); const recoveredChild = recovered.workspaces.getWorkspace(after.deliveryWorkspaceId!)!;
    expect(after.status).toBe("ready"); expect(after.commits.map((item) => item.sha)).toEqual(evidence.commits); expect(after.deliveryTree).toBe(evidence.tree); expect(JSON.stringify(after.reviewPackage)).toBe(evidence.review); expect(await git(recoveredChild.rootPath, ["rev-parse", "HEAD"])).toBe(evidence.head); expect(recovered.workspaces.getLeasesForWorkspace(recoveredChild.id)).toEqual([]); expect(reviewerCalls).toBe(1);
    await recoveredPersistence.close();
  });

  it("recovers one real first commit and completes the remaining commit, verification, and AgentRuntime review exactly once", async () => {
    const f = await fixture(); const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf10c-combined-state-")); owned.push(stateDir); const dbPath = path.join(stateDir, "delivery.sqlite");
    const durable = createSessionPersistence({ dbPath }); const firstProvider = new MissionProvider(() => reviewerPass()); const firstCatalog = new InMemoryProviderCatalog(); firstCatalog.register(firstProvider); const firstFirewall = new ForgeZero(); firstFirewall.register(createGenericFreeRecord());
    const firstRuntime = createAgentRuntime({ sessionId: "combined", eventStore: new EventStore(), persistence: durable, firewall: firstFirewall, providerCatalog: firstCatalog, workspacePath: f.root });
    let crashed = false;
    const crashing = new Proxy(durable, { get(target, property) { const value = Reflect.get(target, property) as unknown; if (typeof value !== "function") return value; return (...args: unknown[]) => { if (property === "appendEvent" && (args[0] as { type?: string }).type === "delivery.commit.created" && !crashed) { crashed = true; throw new Error("PROCESS_TERMINATED"); } if (crashed && ["upsertWorkItem", "appendEvent"].includes(String(property))) throw new Error("PROCESS_TERMINATED"); return (value as (...items: unknown[]) => unknown).apply(target, args); }; } });
    const started = await deliveryHarness(f, { persistence: crashing as never, sessionId: "combined", getAgentRuntime: () => firstRuntime });
    await expect(started.delivery.createDelivery({ missionId: started.mission.id, deliveryId: "delivery-combined" })).rejects.toThrow("PROCESS_TERMINATED");
    await durable.close();
    const recoveredPersistence = createSessionPersistence({ dbPath }); const recoveredProvider = new MissionProvider((context) => context.role === "reviewer" ? reviewerPass("recovered approval") : { text: "done" }); const recoveredCatalog = new InMemoryProviderCatalog(); recoveredCatalog.register(recoveredProvider); const recoveredFirewall = new ForgeZero(); recoveredFirewall.register(createGenericFreeRecord());
    const recoveredRuntime = createAgentRuntime({ sessionId: "combined", eventStore: new EventStore(), persistence: recoveredPersistence, firewall: recoveredFirewall, providerCatalog: recoveredCatalog, workspacePath: f.root });
    const recovered = await deliveryHarness(f, { persistence: recoveredPersistence, sessionId: "combined", getAgentRuntime: () => recoveredRuntime });
    const before = await recovered.delivery.getDelivery("delivery-combined")!; const firstSha = before.commits[0]!.sha!;
    const combinedEvidence = { repository: f.root, targetRef: await git(f.root, ["branch", "--show-current"]), baseline: f.base, changeset: f.source, policyDigest: before.policySnapshot!.digest, commitPlanDigest: deliveryDigest(before.commitPlan), branch: before.deliveryBranch, worktreeId: before.deliveryWorkspaceId };
    const result = await recovered.delivery.resumeDelivery("delivery-combined"); const child = recovered.workspaces.getWorkspace(result.deliveryWorkspaceId!)!;
    expect(result.status, result.error).toBe("ready"); expect(result.commits).toHaveLength(2); expect(result.commits[0]!.sha).toBe(firstSha); expect(await git(child.rootPath, ["rev-list", "--count", `${f.base}..HEAD`])).toBe("2"); expect(result.verification).toContainEqual(expect.objectContaining({ command: "node --test test/client.test.mjs", exitCode: 0 })); expect(result.reviewerRunId).toBe("delivery-combined:delivery-review"); expect(recoveredProvider.captured.filter((request) => request.role === "reviewer")).toHaveLength(1); expect(result.sourceTree).toBe(result.deliveryTree); expect(await git(f.root, ["rev-parse", "HEAD"])).toBe(f.source); expect(recovered.workspaces.getLeasesForWorkspace(child.id)).toEqual([]); expect(firstProvider.captured.filter((request) => request.role === "reviewer")).toHaveLength(0);
    expect(combinedEvidence.repository).toBe(f.root); expect(combinedEvidence.targetRef).toBe("main"); expect(result.sourceRevision).toBe(combinedEvidence.changeset); expect(result.targetRevision).toBe(combinedEvidence.changeset); expect(result.policySnapshot?.digest).toBe(combinedEvidence.policyDigest); expect(deliveryDigest(result.commitPlan)).toBe(combinedEvidence.commitPlanDigest); expect(result.deliveryBranch).toBe(combinedEvidence.branch); expect(result.deliveryWorkspaceId).toBe(combinedEvidence.worktreeId); expect(child.rootPath.startsWith(path.resolve(f.root) + path.sep)).toBe(false); expect(await git(f.root, ["remote"])).toBe("");
    await recoveredPersistence.close();
  });
});
