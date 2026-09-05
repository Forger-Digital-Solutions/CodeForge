import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createSessionPersistence, type SessionPersistence } from "@codeforge/sessions";
import { createWorkspaceService } from "../src/workspace-service.js";
import { createDeliveryService } from "../src/delivery-service.js";
import { createRemotePublicationService } from "../src/remote-publication-service.js";
import { GitHubPullRequestClient, type RemoteRepositoryIdentity } from "../src/github-pr-client.js";

const execFile = promisify(execFileCallback);
const owned: string[] = [];
const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();
const repo: RemoteRepositoryIdentity = { provider: "github", owner: "codeforge", name: "fixture", canonical: "github.com/codeforge/fixture" };

interface FakeGitHub { url: string; creates: number; lookups: number; close: () => Promise<void>; }
async function fakeGitHub(sha: string): Promise<FakeGitHub> {
  let creates = 0; let lookups = 0; let saved: { number: number; head: string; base: string } | undefined;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer cf11-synthetic-token") { res.writeHead(401).end(); return; }
    const url = new URL(req.url ?? "/", "http://fixture");
    if (req.method === "GET" && url.pathname.endsWith("/pulls")) {
      lookups++; const head = url.searchParams.get("head")?.split(":")[1]; const base = url.searchParams.get("base");
      const body = saved && saved.head === head && saved.base === base ? [{ number: saved.number, node_id: "node-1", html_url: `https://example.test/pull/${saved.number}`, state: "open", head: { ref: saved.head, sha }, base: { ref: saved.base } }] : [];
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body)); return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/pulls")) {
      let body = ""; req.on("data", (chunk) => { body += chunk; }); req.on("end", () => {
        creates++; const input = JSON.parse(body) as { head: string; base: string };
        saved ??= { number: 41, head: input.head, base: input.base };
        res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ number: saved.number, node_id: "node-1", html_url: `https://example.test/pull/${saved.number}`, state: "open", head: { ref: saved.head, sha }, base: { ref: saved.base } }));
      }); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, get creates() { return creates; }, get lookups() { return lookups; }, close: async () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function harness(persistence?: SessionPersistence) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf11-repo-")); const worktrees = await fs.mkdtemp(path.join(os.tmpdir(), "cf11-worktrees-")); const bare = await fs.mkdtemp(path.join(os.tmpdir(), "cf11-bare-")); owned.push(root, worktrees, bare);
  await execFile("git", ["init", "-b", "main"], { cwd: root }); await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root }); await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test")); await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/client.test.mjs" } })); await fs.writeFile(path.join(root, "AGENTS.md"), "- node --test test/client.test.mjs\n");
  await fs.writeFile(path.join(root, "src", "client.mjs"), "export const value = 1;\n"); await fs.writeFile(path.join(root, "test", "client.test.mjs"), "import test from 'node:test'; test('ok', () => {});\n"); await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "base"], { cwd: root }); const base = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "src", "client.mjs"), "export const value = 2;\n"); await fs.writeFile(path.join(root, "test", "client.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/client.mjs'; test('ok', () => assert.equal(value, 2));\n"); await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "source"], { cwd: root }); const source = await git(root, ["rev-parse", "HEAD"]);
  await execFile("git", ["init", "--bare"], { cwd: bare }); await execFile("git", ["remote", "add", "origin", bare], { cwd: root }); await execFile("git", ["push", "origin", `${base}:refs/heads/main`], { cwd: root });
  const state = persistence ?? createSessionPersistence(); const now = new Date().toISOString(); state.upsertSession({ id: "cf11", title: "CF-11", status: "running", createdAt: now, updatedAt: now }); const workspaces = createWorkspaceService({ persistence: state, worktreeParentDir: worktrees }); const workspace = await workspaces.registerLocalWorkspace(root);
  const mission = { id: "mission-cf11", sessionId: "cf11", workspaceId: workspace.id, status: "completed", finalRevision: source, baseRevision: base, acceptanceCriteria: [{ id: "ac", mandatory: true, status: "proven" }] };
  const delivery = createDeliveryService({ persistence: state, workspaceService: workspaces, reviewer: async () => ({ verdict: "pass", findings: [] }), findMission: () => mission as never }); const ready = await delivery.createDelivery({ missionId: mission.id, deliveryId: "delivery-cf11" });
  return { root, bare, state, workspaces, delivery, ready };
}

afterEach(async () => { while (owned.length) await fs.rm(owned.pop()!, { recursive: true, force: true }); });

describe("CF-11 controlled remote delivery", () => {
  it("publishes exactly the certified SHA to a real bare remote and creates one PR through HTTP", async () => {
    const h = await harness(); expect(h.ready.status).toBe("ready"); const fake = await fakeGitHub(h.ready.deliveryRevision!);
    const service = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url) });
    const created = await service.createPublication(h.ready.id); const authorized = service.authorize(created.id, "user-1"); const result = await service.resume(authorized.id);
    expect(result.status).toBe("remote_pr_ready"); expect(result.receipt?.publishedSha).toBe(h.ready.deliveryRevision); expect(result.pr?.number).toBe(41); expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${result.remoteBranch}`])).toContain(h.ready.deliveryRevision!); expect(await git(h.root, ["ls-remote", "origin", "refs/heads/main"])).toContain(await git(h.root, ["rev-parse", `${h.ready.commits[0]!.sha!}^`])); expect(fake.creates).toBe(1); expect(JSON.stringify(result)).not.toContain("cf11-synthetic-token"); await fake.close(); h.state.close();
  });

  it("reconciles both crash windows without duplicate push or pull request", async () => {
    const h = await harness(); const fake = await fakeGitHub(h.ready.deliveryRevision!); let stopAfterPush = true;
    const first = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url), afterPush: () => { if (stopAfterPush) throw new Error("PROCESS_TERMINATED"); } });
    const publication = await first.createPublication(h.ready.id); first.authorize(publication.id, "user-1"); await expect(first.resume(publication.id)).rejects.toThrow("PROCESS_TERMINATED"); const branch = first.getPublication(publication.id)!.remoteBranch; expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${branch}`])).toContain(h.ready.deliveryRevision!);
    stopAfterPush = false; let stopAfterPr = true; const second = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url), afterPullRequestCreated: () => { if (stopAfterPr) throw new Error("PROCESS_TERMINATED"); } });
    await expect(second.resume(publication.id)).rejects.toThrow("PROCESS_TERMINATED"); expect(fake.creates).toBe(1);
    stopAfterPr = false; const third = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url) }); const result = await third.resume(publication.id);
    expect(result.status).toBe("remote_pr_ready"); expect(fake.creates).toBe(1); expect(fake.lookups).toBeGreaterThan(1); await fake.close(); h.state.close();
  });

  it("fails closed before branch mutation when the remote target advances", async () => {
    const h = await harness(); const fake = await fakeGitHub(h.ready.deliveryRevision!); await fs.writeFile(path.join(h.root, "advanced.txt"), "remote advance\n"); await execFile("git", ["add", "."], { cwd: h.root }); await execFile("git", ["commit", "-m", "advance local actor"], { cwd: h.root }); const advanced = await git(h.root, ["rev-parse", "HEAD"]); await execFile("git", ["push", "origin", `${advanced}:refs/heads/main`], { cwd: h.root });
    const service = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url) }); const p = await service.createPublication(h.ready.id); service.authorize(p.id, "user-1"); const result = await service.resume(p.id);
    expect(result.status).toBe("remote_diverged"); expect(result.error).toBe("REMOTE_TARGET_DIVERGED"); expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${result.remoteBranch}`])).toBe(""); expect(fake.creates).toBe(0); await fake.close(); h.state.close();
  });

  it("rejects unexpected remote branch history without force-pushing or creating a PR", async () => {
    const h = await harness(); const fake = await fakeGitHub(h.ready.deliveryRevision!);
    const service = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, fake.url) }); const publication = await service.createPublication(h.ready.id);
    const unexpected = await git(h.root, ["rev-parse", `${h.ready.commits[0]!.sha!}^`]); await execFile("git", ["push", "origin", `${unexpected}:refs/heads/${publication.remoteBranch}`], { cwd: h.root }); service.authorize(publication.id, "user-1"); const result = await service.resume(publication.id);
    expect(result.status).toBe("remote_diverged"); expect(result.error).toBe("REMOTE_BRANCH_DIVERGED"); expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${publication.remoteBranch}`])).toContain(unexpected); expect(fake.creates).toBe(0); await fake.close(); h.state.close();
  });

  it("requires explicit authorization and cancellation before push leaves the remote untouched", async () => {
    const h = await harness(); const service = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo, pullRequests: new GitHubPullRequestClient(() => "cf11-synthetic-token", fetch, "http://127.0.0.1:1") }); const publication = await service.createPublication(h.ready.id);
    expect((await service.resume(publication.id)).status).toBe("authorization_required"); expect(service.cancel(publication.id)).toBe(true); expect(service.cancel(publication.id)).toBe(false); expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${publication.remoteBranch}`])).toBe(""); h.state.close();
  });

  it("fails before any Git remote mutation when no publication credential authority is configured", async () => {
    const h = await harness();
    const service = createRemotePublicationService({ persistence: h.state, workspaceService: h.workspaces, getDelivery: (id) => h.delivery.getDelivery(id), resolveRepository: () => repo });
    const publication = await service.createPublication(h.ready.id);
    service.authorize(publication.id, "user-1");
    const result = await service.resume(publication.id);
    expect(result.status).toBe("blocked");
    expect(result.error).toBe("REMOTE_AUTH_FAILED");
    expect(await git(h.root, ["ls-remote", "origin", `refs/heads/${result.remoteBranch}`])).toBe("");
    h.state.close();
  });
});
