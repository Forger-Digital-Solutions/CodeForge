import crypto from "node:crypto";
import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SQLiteCloudDatabase, type ICloudDatabase } from "@codeforge/cloud-db";
import { GitHubAppAuthorizationService } from "@codeforge/cloud-auth";
import { PublicationService, type PublicationServiceConfig } from "../../src/publication-service.js";
import { GitTransportService } from "../../src/git-transport.js";
import { GitHubPRClient } from "../../src/github-pr-client.js";
import { PublicationArtifactStore } from "../../src/artifact-store.js";

const execFile = promisify(execFileCallback);

export const TEST_APP_CONFIG = {
  appId: "12345",
  // Generated per process. Never a real credential.
  privateKeyPem: crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey,
};

/** Deterministic synthetic installation token used everywhere a real one would appear. */
export const SYNTHETIC_INSTALLATION_TOKEN = "ghs_cf11bSyntheticInstallationToken000000000000";

const owned: string[] = [];
const servers: http.Server[] = [];

export async function cleanupHarness(): Promise<void> {
  while (owned.length) await fs.rm(owned.pop()!, { recursive: true, force: true }).catch(() => undefined);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

export async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  owned.push(dir);
  return dir;
}

const GIT_ENV = { PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "CodeForge", GIT_AUTHOR_EMAIL: "codeforge@example.test", GIT_COMMITTER_NAME: "CodeForge", GIT_COMMITTER_EMAIL: "codeforge@example.test" };

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

export interface GitFixture {
  sourceRepo: string;
  bareRemote: string;
  targetBranch: string;
  targetSha: string;
  certifiedHead: string;
  certifiedTree: string;
  bundle: Buffer;
  bundleSha256: string;
}

/**
 * Builds a real Git world: a source repository with a base commit and a certified delivery commit,
 * a controlled bare remote holding the base commit on the target branch, and a real Git bundle.
 */
export async function createGitFixture(options: { targetBranch?: string } = {}): Promise<GitFixture> {
  const targetBranch = options.targetBranch ?? "main";
  const root = await tempDir("cf11b-source-");
  const sourceRepo = path.join(root, "repo");
  await fs.mkdir(sourceRepo);
  await git(sourceRepo, ["init", "-b", targetBranch]);
  await fs.writeFile(path.join(sourceRepo, "file.txt"), "base\n");
  await git(sourceRepo, ["add", "-f", "."]);
  await git(sourceRepo, ["commit", "-m", "base"]);
  const targetSha = await git(sourceRepo, ["rev-parse", "HEAD"]);

  const bareRemote = path.join(root, "remote.git");
  await git(root, ["init", "--bare", bareRemote]);
  await git(sourceRepo, ["push", bareRemote, `HEAD:refs/heads/${targetBranch}`]);

  await fs.writeFile(path.join(sourceRepo, "file.txt"), "certified delivery\n");
  await git(sourceRepo, ["add", "-f", "."]);
  await git(sourceRepo, ["commit", "-m", "certified delivery"]);
  const certifiedHead = await git(sourceRepo, ["rev-parse", "HEAD"]);
  const certifiedTree = await git(sourceRepo, ["rev-parse", "HEAD^{tree}"]);

  const bundlePath = path.join(root, "delivery.bundle");
  await git(sourceRepo, ["bundle", "create", bundlePath, "HEAD"]);
  const bundle = await fs.readFile(bundlePath);

  return {
    sourceRepo,
    bareRemote,
    targetBranch,
    targetSha,
    certifiedHead,
    certifiedTree,
    bundle,
    bundleSha256: crypto.createHash("sha256").update(bundle).digest("hex"),
  };
}

/** Advances the controlled remote's target branch, simulating a merge after certification. */
export async function advanceRemoteTarget(fixture: GitFixture): Promise<string> {
  const clone = await tempDir("cf11b-advance-");
  await git(clone, ["clone", "--branch", fixture.targetBranch, fixture.bareRemote, "work"]);
  const work = path.join(clone, "work");
  await fs.writeFile(path.join(work, "other.txt"), "someone else merged\n");
  await git(work, ["add", "-f", "."]);
  await git(work, ["commit", "-m", "concurrent merge"]);
  await git(work, ["push", "origin", `HEAD:refs/heads/${fixture.targetBranch}`]);
  return git(work, ["rev-parse", "HEAD"]);
}

export async function remoteRef(fixture: GitFixture, ref: string): Promise<string | undefined> {
  const out = await git(fixture.bareRemote, ["for-each-ref", "--format=%(objectname) %(refname)", ref]);
  const line = out.split(/\r?\n/).find(Boolean);
  return line?.split(/\s+/)[0];
}

export async function listRemoteRefs(fixture: GitFixture): Promise<string[]> {
  const out = await git(fixture.bareRemote, ["for-each-ref", "--format=%(refname)"]);
  return out.split(/\r?\n/).filter(Boolean);
}

export interface FakeGitHubPullRequests {
  apiBase: string;
  creates: number;
  lookups: number;
  requests: Array<{ method: string; url: string; authorization?: string }>;
  reset: () => void;
  /** Makes the next create respond 201 but never return — simulating a crash after acceptance. */
  failAfterCreate: boolean;
  close: () => Promise<void>;
}

/** A fake GitHub pull-request API. Rejects any request that does not carry the expected token. */
export async function startFakeGitHub(headSha: string): Promise<FakeGitHubPullRequests> {
  const state = { creates: 0, lookups: 0, failAfterCreate: false, saved: undefined as undefined | { number: number; head: string; base: string } };
  const requests: FakeGitHubPullRequests["requests"] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    requests.push({ method: req.method ?? "", url: url.pathname + url.search, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${SYNTHETIC_INSTALLATION_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/pulls")) {
      state.lookups++;
      const head = url.searchParams.get("head")?.split(":")[1];
      const body = state.saved && state.saved.head === head
        ? [{ number: state.saved.number, node_id: "PR_kwDO", html_url: `https://github.test/pull/${state.saved.number}`, state: "open", head: { ref: state.saved.head, sha: headSha }, base: { ref: state.saved.base } }]
        : [];
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/pulls")) {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const input = JSON.parse(raw) as { head: string; base: string };
        if (state.saved && state.saved.head === input.head) {
          res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "A pull request already exists" }));
          return;
        }
        state.creates++;
        state.saved = { number: 4242, head: input.head, base: input.base };
        if (state.failAfterCreate) {
          // GitHub accepted the PR, but the response never reaches Cloud.
          req.socket.destroy();
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ number: state.saved.number, node_id: "PR_kwDO", html_url: `https://github.test/pull/${state.saved.number}`, state: "open", head: { ref: state.saved.head, sha: headSha }, base: { ref: state.saved.base } }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    apiBase: `http://127.0.0.1:${port}`,
    get creates() { return state.creates; },
    get lookups() { return state.lookups; },
    get failAfterCreate() { return state.failAfterCreate; },
    set failAfterCreate(value: boolean) { state.failAfterCreate = value; },
    requests,
    reset: () => { state.creates = 0; state.lookups = 0; state.saved = undefined; },
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export interface HarnessAccount {
  userId: string;
  installationRowId: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
}

export async function seedAccount(db: ICloudDatabase, options: { owner?: string; name?: string; repositoryId?: number; installationId?: number } = {}): Promise<HarnessAccount> {
  const user = await db.createUser({ displayName: "CF-11B User", primaryIdentity: `github:${crypto.randomUUID()}` });
  const installationId = options.installationId ?? Math.floor(Math.random() * 1_000_000) + 1;
  const installation = await db.createGitHubInstallation({
    installationId,
    githubAccountId: installationId + 1,
    accountLogin: options.owner ?? "codeforge",
    accountType: "Organization",
    codeForgeUserId: user.id,
    repositorySelection: "selected",
  });
  const repositoryId = options.repositoryId ?? Math.floor(Math.random() * 1_000_000) + 1;
  await db.createGitHubRepositoryAuthorization({
    installationId: installation.id,
    repositoryId,
    owner: options.owner ?? "codeforge",
    name: options.name ?? "fixture",
    fullName: `${options.owner ?? "codeforge"}/${options.name ?? "fixture"}`,
    private: true,
  });
  return { userId: user.id, installationRowId: installation.id, installationId, repositoryId, owner: options.owner ?? "codeforge", name: options.name ?? "fixture" };
}

export interface HarnessOptions {
  db?: ICloudDatabase;
  fixture: GitFixture;
  github: FakeGitHubPullRequests;
  artifactDir?: string;
  leaseDurationMs?: number;
  workerId?: string;
  onBoundary?: PublicationServiceConfig["onBoundary"];
  mintToken?: PublicationServiceConfig["tokenBroker"]["mintRepositoryToken"];
}

export interface Harness {
  db: ICloudDatabase;
  service: PublicationService;
  artifactStore: PublicationArtifactStore;
  artifactDir: string;
  mintCalls: Array<{ installationId: number; repositoryId: number }>;
}

/**
 * A complete Cloud publication stack over a real SQLite database, a real Git transport pointed at
 * a controlled bare remote, and a fake GitHub PR API. Only the GitHub App token mint is
 * substituted — minting a real token would require a real GitHub App.
 */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const db = options.db ?? new SQLiteCloudDatabase({ dbPath: ":memory:" });
  await db.init();
  const artifactDir = options.artifactDir ?? (await tempDir("cf11b-artifacts-"));
  const artifactStore = new PublicationArtifactStore({ rootDir: artifactDir });
  await artifactStore.init();
  const mintCalls: Harness["mintCalls"] = [];

  const service = new PublicationService({
    db,
    authorization: new GitHubAppAuthorizationService({ db, appConfig: TEST_APP_CONFIG }),
    appConfig: TEST_APP_CONFIG,
    artifactStore,
    transport: new GitTransportService({ allowLocalRemotes: true }),
    pullRequests: new GitHubPRClient({ apiBase: options.github.apiBase }),
    tokenBroker: {
      mintRepositoryToken: options.mintToken ?? (async (installationId: number, repository: { id: number }) => {
        mintCalls.push({ installationId, repositoryId: repository.id });
        return { token: SYNTHETIC_INSTALLATION_TOKEN, expiresAt: new Date(Date.now() + 600_000).toISOString(), repositoryId: repository.id, permissions: { contents: "write", pull_requests: "write" } as const };
      }),
    },
    // The push target is derived here from durable identity, exactly as production derives it from
    // the GitHub host — a client never supplies it.
    resolveRemoteUrl: () => options.fixture.bareRemote,
    ...(options.leaseDurationMs !== undefined ? { leaseDurationMs: options.leaseDurationMs } : {}),
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.onBoundary ? { onBoundary: options.onBoundary } : {}),
  });

  return { db, service, artifactStore, artifactDir, mintCalls };
}

export async function* bytes(buffer: Uint8Array, chunkSize = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.byteLength));
  }
}

export async function createAndUpload(harness: Harness, account: HarnessAccount, fixture: GitFixture, overrides: Partial<{ deliveryId: string; artifactBytes: number; artifactSha256: string; targetSha: string; certifiedHead: string; certifiedTree: string; bundle: Uint8Array }> = {}) {
  const publication = await harness.service.createPublication(account.userId, {
    deliveryId: overrides.deliveryId ?? `delivery-${crypto.randomUUID()}`,
    repositoryId: account.repositoryId,
    targetBranch: fixture.targetBranch,
    baseSha: fixture.targetSha,
    targetSha: overrides.targetSha ?? fixture.targetSha,
    certifiedHead: overrides.certifiedHead ?? fixture.certifiedHead,
    certifiedTree: overrides.certifiedTree ?? fixture.certifiedTree,
    artifactSha256: overrides.artifactSha256 ?? fixture.bundleSha256,
    artifactBytes: overrides.artifactBytes ?? fixture.bundle.byteLength,
  });
  await harness.service.uploadArtifact(account.userId, publication.id, bytes(overrides.bundle ?? fixture.bundle));
  return publication;
}
