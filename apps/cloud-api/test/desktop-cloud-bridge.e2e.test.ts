import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { GitHubAppError, signAccessToken } from "@codeforge/cloud-auth";
import { createSessionPersistence, type SessionPersistence } from "@codeforge/sessions";
import {
  CloudPublicationClient,
  createCloudPublicationBridge,
  createWorkspaceService,
  type ChangeDelivery,
  type CloudPublicationBridge,
} from "@codeforge/server";
import { CodeForgeCloudServer } from "../src/server.js";
import { MAX_PUBLICATION_ARTIFACT_BYTES } from "../src/artifact-store.js";
import { publicationRefFor } from "../src/git-transport.js";
import {
  SYNTHETIC_INSTALLATION_TOKEN,
  TEST_APP_CONFIG,
  advanceRemoteTarget,
  cleanupHarness,
  createGitFixture,
  createHarness,
  git,
  remoteRef,
  seedAccount,
  startFakeGitHub,
  tempDir,
  type GitFixture,
} from "./helpers/publication-harness.js";

const JWT_SECRET = "cf11-desktop-bridge-jwt-secret-32-characters";
type UploadMode = "normal" | "tamper" | "truncate" | "oversize" | "invalid_bundle";

const servers: CodeForgeCloudServer[] = [];
const persistenceStores: SessionPersistence[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => undefined)));
  while (persistenceStores.length) persistenceStores.pop()!.close();
  await cleanupHarness();
});

interface DesktopHarness {
  fixture: GitFixture;
  db: SQLiteCloudDatabase;
  bridge: CloudPublicationBridge;
  delivery: ChangeDelivery;
  responses: string[];
  requests: Array<{ url: string; body: Uint8Array | string | undefined }>;
  mintCount: () => number;
  githubCreates: () => number;
  installationRowId: string;
  userId: string;
}

async function desktopHarness(options: { mode?: UploadMode; failMintOnce?: boolean; revokeAfterUpload?: boolean } = {}): Promise<DesktopHarness> {
  const mode = options.mode ?? "normal";
  const fixture = await createGitFixture();
  await git(fixture.sourceRepo, ["remote", "add", "origin", "https://github.com/codeforge/fixture.git"]);
  const github = await startFakeGitHub(fixture.certifiedHead);
  const db = new SQLiteCloudDatabase({ dbPath: ":memory:" });
  let mintCount = 0;
  const harness = await createHarness({
    db,
    fixture,
    github,
    ...(options.failMintOnce
      ? {
          mintToken: async (_installationId: number, repository: { id: number }) => {
            mintCount++;
            if (mintCount === 1) throw new GitHubAppError("GITHUB_TEMPORARY_FAILURE", "synthetic transient failure");
            return {
              token: SYNTHETIC_INSTALLATION_TOKEN,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              repositoryId: repository.id,
              permissions: { contents: "write", pull_requests: "write" } as const,
            };
          },
        }
      : {}),
  });
  const account = await seedAccount(db, { owner: "codeforge", name: "fixture", repositoryId: 81001, installationId: 82001 });
  const server = new CodeForgeCloudServer({ db, jwtSecret: JWT_SECRET, gitHubAppConfig: TEST_APP_CONFIG, stripeConfig: null });
  Object.defineProperty(server, "publicationService", { value: harness.service });
  const port = await server.start(0);
  servers.push(server);

  const persistence = createSessionPersistence({ dbPath: ":memory:" });
  persistenceStores.push(persistence);
  const now = new Date().toISOString();
  persistence.upsertSession({ id: "desktop-session", title: "CF-11 Desktop", status: "running", createdAt: now, updatedAt: now });
  const workspaceService = createWorkspaceService({ persistence, worktreeParentDir: await tempDir("cf11-desktop-worktrees-") });
  const workspace = await workspaceService.registerLocalWorkspace(fixture.sourceRepo);
  const delivery: ChangeDelivery = {
    kind: "change_delivery",
    id: `delivery-${crypto.randomUUID()}`,
    sessionId: "desktop-session",
    missionId: "cf11-mission",
    workspaceId: workspace.id,
    deliveryWorkspaceId: workspace.id,
    sourceRevision: fixture.targetSha,
    targetRevision: fixture.certifiedHead,
    deliveryRevision: fixture.certifiedHead,
    deliveryTree: fixture.certifiedTree,
    status: "ready",
    commits: [{ id: "delivery-commit", title: "certified delivery", paths: ["file.txt"], sha: fixture.certifiedHead }],
    verification: [],
    createdAt: now,
    updatedAt: now,
  };
  const responses: string[] = [];
  const requests: DesktopHarness["requests"] = [];
  const invalidBundle = Buffer.from("not a git bundle\n", "utf8");
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = input.toString();
    let nextInit = init;
    let capturedBody: Uint8Array | string | undefined;
    if (typeof init.body === "string") capturedBody = init.body;
    else if (init.body instanceof Uint8Array) capturedBody = new Uint8Array(init.body);

    if (url.endsWith("/v1/publications") && init.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (mode === "oversize") body.artifactBytes = MAX_PUBLICATION_ARTIFACT_BYTES + 1;
      if (mode === "invalid_bundle") {
        body.artifactBytes = invalidBundle.byteLength;
        body.artifactSha256 = crypto.createHash("sha256").update(invalidBundle).digest("hex");
      }
      capturedBody = JSON.stringify(body);
      nextInit = { ...init, body: capturedBody };
    } else if (/\/v1\/publications\/[^/]+\/artifact$/.test(url) && init.method === "POST" && init.body instanceof Uint8Array) {
      let body = Buffer.from(init.body);
      if (mode === "tamper") { body = Buffer.from(body); body[0] = body[0]! ^ 1; }
      if (mode === "truncate") body = body.subarray(0, body.byteLength - 1);
      if (mode === "invalid_bundle") body = invalidBundle;
      const headers = new Headers(init.headers);
      headers.set("Content-Length", String(body.byteLength));
      capturedBody = new Uint8Array(body);
      nextInit = { ...init, headers, body: body as unknown as BodyInit };
    }
    requests.push({ url, body: capturedBody });
    const response = await fetch(input, nextInit);
    responses.push(await response.clone().text());
    if (options.revokeAfterUpload && /\/artifact$/.test(url) && response.ok) {
      await db.updateGitHubInstallationStatus(account.installationRowId, "revoked");
    }
    return response;
  };
  const token = signAccessToken({ sub: account.userId, sid: "desktop-device" }, JWT_SECRET);
  const client = new CloudPublicationClient({
    cloudApiUrl: `http://127.0.0.1:${port}`,
    getAuthToken: () => token,
    workspaceService,
    getDelivery: (id) => id === delivery.id ? delivery : undefined,
    fetchFn,
  });
  const bridge = createCloudPublicationBridge({ persistence, getDelivery: (id) => id === delivery.id ? delivery : undefined, client });
  return {
    fixture,
    db,
    bridge,
    delivery,
    responses,
    requests,
    mintCount: () => options.failMintOnce ? mintCount : harness.mintCalls.length,
    githubCreates: () => github.creates,
    installationRowId: account.installationRowId,
    userId: account.userId,
  };
}

describe("CF-11 production Desktop Cloud bridge", () => {
  it("builds and streams the certified artifact, trusts Cloud completion, and receives no repository credential", async () => {
    const h = await desktopHarness();
    expect(await h.bridge.describeAuthorization(h.delivery.id)).toMatchObject({ authorized: true, repositoryId: 81001 });
    const sourceStatus = await git(h.fixture.sourceRepo, ["status", "--porcelain=v2"]);
    const result = await h.bridge.publish(h.delivery.id);
    expect(result.status).toBe("completed");
    expect(result.cloudPublicationId).toBeTruthy();
    expect(await remoteRef(h.fixture, publicationRefFor(result.cloudPublicationId!))).toBe(h.fixture.certifiedHead);
    expect(await remoteRef(h.fixture, `refs/heads/${h.fixture.targetBranch}`)).toBe(h.fixture.targetSha);
    expect(await git(h.fixture.sourceRepo, ["status", "--porcelain=v2"])).toBe(sourceStatus);
    const createRequest = h.requests.find((item) => item.url.endsWith("/v1/publications"));
    const uploadRequest = h.requests.find((item) => /\/artifact$/.test(item.url));
    const createBody = JSON.parse(String(createRequest?.body)) as { artifactBytes: number; artifactSha256: string };
    const uploaded = Buffer.from(uploadRequest?.body as Uint8Array);
    expect(createBody.artifactBytes).toBe(uploaded.byteLength);
    expect(createBody.artifactSha256).toBe(crypto.createHash("sha256").update(uploaded).digest("hex"));
    const desktopVisible = JSON.stringify({ responses: h.responses, record: result });
    expect(desktopVisible).not.toContain(SYNTHETIC_INSTALLATION_TOKEN);
    expect(desktopVisible).not.toContain("PRIVATE KEY");
    expect(desktopVisible).not.toContain("askpass");
    expect(desktopVisible).not.toMatch(/https:\/\/[^/]*:[^@/]*@/);
    expect(h.mintCount()).toBe(1);
    expect(h.githubCreates()).toBe(1);
  });

  it.each([
    ["tamper", "ARTIFACT_DIGEST_MISMATCH"],
    ["truncate", "ARTIFACT_LENGTH_MISMATCH"],
    ["oversize", "ARTIFACT_TOO_LARGE"],
  ] as const)("rejects %s through the Desktop bridge without finalizing or executing", async (mode, code) => {
    const h = await desktopHarness({ mode });
    const result = await h.bridge.publish(h.delivery.id);
    expect(result.error).toBe(code);
    expect(result.status).not.toBe("completed");
    const publication = await h.db.getPublicationByDeliveryId(h.userId, h.delivery.id);
    if (publication) expect(publication).toMatchObject({ artifactState: "pending", state: "awaiting_artifact" });
    expect(h.mintCount()).toBe(0);
    expect(h.githubCreates()).toBe(0);
  });

  it("surfaces target divergence and authorization revocation before a managed push or PR", async () => {
    const diverged = await desktopHarness();
    const advanced = await advanceRemoteTarget(diverged.fixture);
    const divergence = await diverged.bridge.publish(diverged.delivery.id);
    expect(divergence.status).toBe("target_diverged");
    expect(divergence.error).toBe("PROMOTION_TARGET_DIVERGED");
    expect(await remoteRef(diverged.fixture, `refs/heads/${diverged.fixture.targetBranch}`)).toBe(advanced);
    expect(await remoteRef(diverged.fixture, publicationRefFor(divergence.cloudPublicationId!))).toBeUndefined();
    expect(diverged.githubCreates()).toBe(0);

    const revoked = await desktopHarness({ revokeAfterUpload: true });
    const revocation = await revoked.bridge.publish(revoked.delivery.id);
    expect(revocation.status).toBe("authorization_revoked");
    expect(revocation.error).toBe("INSTALLATION_REVOKED");
    expect(revoked.mintCount()).toBe(0);
    expect(revoked.githubCreates()).toBe(0);
  });

  it("uses only Cloud retry for retryable failure and preserves permanent terminal failure", async () => {
    const retryable = await desktopHarness({ failMintOnce: true });
    const first = await retryable.bridge.publish(retryable.delivery.id);
    expect(first.status).toBe("failed_retryable");
    expect(first.error).toBe("GITHUB_TEMPORARY_FAILURE");
    const recovered = await retryable.bridge.retry(retryable.delivery.id);
    expect(recovered.status).toBe("completed");
    expect(retryable.mintCount()).toBe(2);
    expect(retryable.githubCreates()).toBe(1);

    const permanent = await desktopHarness({ mode: "invalid_bundle" });
    const failed = await permanent.bridge.publish(permanent.delivery.id);
    expect(failed.status).toBe("failed_permanent");
    expect(failed.error).toBe("ARTIFACT_INVALID_BUNDLE");
    const requestCount = permanent.requests.length;
    expect(await permanent.bridge.retry(permanent.delivery.id)).toEqual(failed);
    expect(permanent.requests).toHaveLength(requestCount);
    expect(permanent.mintCount()).toBe(0);
    expect(permanent.githubCreates()).toBe(0);
  });
});
