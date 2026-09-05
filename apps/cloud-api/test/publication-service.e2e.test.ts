import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { publicationRefFor } from "../src/git-transport.js";
import { cleanupHarness, createAndUpload, createGitFixture, createHarness, advanceRemoteTarget, bytes, listRemoteRefs, remoteRef, seedAccount, startFakeGitHub } from "./helpers/publication-harness.js";

afterEach(async () => cleanupHarness());

describe("CF-11B Cloud publication executor", () => {
  it("publishes the exact certified commit to a managed ref and creates one PR", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const harness = await createHarness({ fixture, github });
    const account = await seedAccount(harness.db);
    const publication = await createAndUpload(harness, account, fixture);

    const result = await harness.service.execute(account.userId, publication.id);

    expect(result.state).toBe("completed");
    expect(result.receipt).toMatchObject({ publishedCommit: fixture.certifiedHead, publishedTree: fixture.certifiedTree, pullRequestNumber: 4242 });
    expect(await remoteRef(fixture, publicationRefFor(publication.id))).toBe(fixture.certifiedHead);
    expect(github.creates).toBe(1);
    expect(harness.mintCalls).toEqual([{ installationId: account.installationId, repositoryId: account.repositoryId }]);
    expect(github.requests.some((request) => request.authorization !== `Bearer ${"ghs_cf11bSyntheticInstallationToken000000000000"}`)).toBe(false);
  });

  it("rejects a tampered artifact before token minting, push, or PR creation", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const harness = await createHarness({ fixture, github });
    const account = await seedAccount(harness.db);
    const publication = await harness.service.createPublication(account.userId, {
      deliveryId: `delivery-${crypto.randomUUID()}`,
      repositoryId: account.repositoryId,
      targetBranch: fixture.targetBranch,
      baseSha: fixture.targetSha,
      targetSha: fixture.targetSha,
      certifiedHead: fixture.certifiedHead,
      certifiedTree: fixture.certifiedTree,
      artifactSha256: fixture.bundleSha256,
      artifactBytes: fixture.bundle.byteLength,
    });
    const tampered = Buffer.from(fixture.bundle);
    tampered[tampered.length - 1] ^= 0x01;

    await expect(harness.service.uploadArtifact(account.userId, publication.id, bytes(tampered))).rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
    expect(harness.mintCalls).toEqual([]);
    expect(await listRemoteRefs(fixture)).toEqual([`refs/heads/${fixture.targetBranch}`]);
    expect(github.creates).toBe(0);
  });

  it("fails closed when authorization is revoked after upload", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const harness = await createHarness({ fixture, github });
    const account = await seedAccount(harness.db);
    const publication = await createAndUpload(harness, account, fixture);
    const grant = (await harness.db.getGitHubRepositoryAuthorization(account.repositoryId))!;
    await harness.db.updateGitHubRepositoryAuthorizationState(grant.id, "revoked");

    const result = await harness.service.execute(account.userId, publication.id);

    expect(result.state).toBe("authorization_revoked");
    expect(harness.mintCalls).toEqual([]);
    expect(await listRemoteRefs(fixture)).toEqual([`refs/heads/${fixture.targetBranch}`]);
    expect(github.creates).toBe(0);
  });

  it("rejects a repository identifier that is authorized only for another Cloud user", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const harness = await createHarness({ fixture, github });
    const account = await seedAccount(harness.db);
    const otherUser = await harness.db.createUser({ displayName: "Other user", primaryIdentity: `github:${crypto.randomUUID()}` });

    await expect(harness.service.createPublication(otherUser.id, {
      deliveryId: `delivery-${crypto.randomUUID()}`,
      repositoryId: account.repositoryId,
      targetBranch: fixture.targetBranch,
      baseSha: fixture.targetSha,
      targetSha: fixture.targetSha,
      certifiedHead: fixture.certifiedHead,
      certifiedTree: fixture.certifiedTree,
      artifactSha256: fixture.bundleSha256,
      artifactBytes: fixture.bundle.byteLength,
    })).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");

    expect(harness.mintCalls).toEqual([]);
    expect(await listRemoteRefs(fixture)).toEqual([`refs/heads/${fixture.targetBranch}`]);
    expect(github.creates).toBe(0);
  });

  it("detects remote target divergence immediately before the managed push", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const harness = await createHarness({ fixture, github });
    const account = await seedAccount(harness.db);
    const publication = await createAndUpload(harness, account, fixture);
    await advanceRemoteTarget(fixture);

    const result = await harness.service.execute(account.userId, publication.id);

    expect(result).toMatchObject({ state: "target_diverged", errorCode: "PROMOTION_TARGET_DIVERGED" });
    expect(await remoteRef(fixture, publicationRefFor(publication.id))).toBeUndefined();
    expect(github.creates).toBe(0);
  });

  it("reconciles a real managed ref after an interruption immediately after push", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    let interrupted = true;
    const first = await createHarness({
      fixture,
      github,
      onBoundary: (boundary) => { if (boundary === "pushed" && interrupted) throw new Error("simulated process interruption"); },
    });
    const account = await seedAccount(first.db);
    const publication = await createAndUpload(first, account, fixture);

    const interruptedResult = await first.service.execute(account.userId, publication.id);
    expect(interruptedResult.state).toBe("failed_retryable");
    expect(await remoteRef(fixture, publicationRefFor(publication.id))).toBe(fixture.certifiedHead);

    interrupted = false;
    const resumed = await createHarness({ fixture, github, db: first.db, artifactDir: first.artifactDir, workerId: "recovery-worker" });
    const result = await resumed.service.retry(account.userId, publication.id);
    expect(result.state).toBe("completed");
    expect(github.creates).toBe(1);
  });

  it("reconciles a PR accepted before Cloud received its response", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    github.failAfterCreate = true;
    const first = await createHarness({ fixture, github });
    const account = await seedAccount(first.db);
    const publication = await createAndUpload(first, account, fixture);

    expect((await first.service.execute(account.userId, publication.id)).state).toBe("failed_retryable");
    expect(github.creates).toBe(1);

    github.failAfterCreate = false;
    const resumed = await createHarness({ fixture, github, db: first.db, artifactDir: first.artifactDir, workerId: "pr-recovery-worker" });
    const result = await resumed.service.retry(account.userId, publication.id);
    expect(result.state).toBe("completed");
    expect(result.pullRequestNumber).toBe(4242);
    expect(github.creates).toBe(1);
  });

  it("fences a stale lease owner and converges two executors on one remote publication", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const first = await createHarness({ fixture, github, workerId: "worker-a" });
    const account = await seedAccount(first.db);
    const publication = await createAndUpload(first, account, fixture);
    const second = await createHarness({ fixture, github, db: first.db, artifactDir: first.artifactDir, workerId: "worker-b" });

    const [one, two] = await Promise.allSettled([
      first.service.execute(account.userId, publication.id),
      second.service.execute(account.userId, publication.id),
    ]);
    expect([one.status, two.status]).toContain("fulfilled");
    expect(await first.service.getStatus(account.userId, publication.id)).toMatchObject({ state: "completed", pullRequestNumber: 4242 });
    expect(await remoteRef(fixture, publicationRefFor(publication.id))).toBe(fixture.certifiedHead);
    expect(github.creates).toBe(1);

    const stale = await first.db.acquirePublicationLease({ publicationId: publication.id, owner: "stale-owner", leaseDurationMs: 1 });
    expect(stale).toBeUndefined();
  });
});
