import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ICloudDatabase } from "../src/interface.js";
import { PostgresCloudDatabase } from "../src/postgres.js";
import { SQLiteCloudDatabase } from "../src/sqlite.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const databases: ICloudDatabase[] = [];

afterEach(async () => {
  while (databases.length) await databases.pop()!.close();
});

async function publication(createDatabase: () => ICloudDatabase) {
  const db = createDatabase();
  databases.push(db);
  await db.init();
  const user = await db.createUser({ displayName: "Publication user", primaryIdentity: `github:${randomUUID()}` });
  const installationId = Math.floor(Math.random() * 1_000_000_000) + 1;
  const installation = await db.createGitHubInstallation({
    installationId,
    githubAccountId: installationId + 1,
    accountLogin: "codeforge",
    accountType: "Organization",
    codeForgeUserId: user.id,
    repositorySelection: "selected",
  });
  const record = await db.createPublication({
    deliveryId: `delivery-${randomUUID()}`,
    userId: user.id,
    repositoryId: installationId + 2,
    installationId: installation.id,
    targetBranch: "main",
    baseSha: SHA,
    targetSha: SHA,
    certifiedHead: SHA,
    certifiedTree: SHA,
    artifactSha256: DIGEST,
    artifactBytes: 1,
  });
  expect(await db.markPublicationArtifactStored({ publicationId: record.id, artifactKey: `${record.id}.bundle` })).toBe(true);
  return { db, record };
}

const postgresUrl = process.env.CODEFORGE_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
const backends: Array<{ name: string; create: () => ICloudDatabase }> = [
  { name: "SQLite", create: () => new SQLiteCloudDatabase({ dbPath: ":memory:" }) },
  ...(postgresUrl?.startsWith("postgres")
    ? [{ name: "PostgreSQL", create: () => new PostgresCloudDatabase({ connectionString: postgresUrl }) }]
    : []),
];

describe.each(backends)("CF-11B $name publication lease conformance", ({ create }) => {
  it("excludes competing owners, fences every stale write after takeover, and enforces terminal immutability", async () => {
    const { db, record } = await publication(create);
    const live = await db.acquirePublicationLease({ publicationId: record.id, owner: "worker-live", leaseDurationMs: 60_000 });
    expect(live).toMatchObject({ owner: "worker-live", fence: 1 });
    expect(await db.acquirePublicationLease({ publicationId: record.id, owner: "worker-blocked", leaseDurationMs: 60_000 })).toBeUndefined();
    expect(await db.releasePublicationLease({ publicationId: record.id, owner: "worker-live", fence: live!.fence })).toBe(true);

    const first = await db.acquirePublicationLease({ publicationId: record.id, owner: "worker-a", leaseDurationMs: -1 });
    expect(first).toMatchObject({ owner: "worker-a", fence: 2 });
    const second = await db.acquirePublicationLease({ publicationId: record.id, owner: "worker-b", leaseDurationMs: 60_000 });
    expect(second).toMatchObject({ owner: "worker-b", fence: 3 });
    expect(await db.renewPublicationLease({ publicationId: record.id, owner: "worker-a", fence: first!.fence, leaseDurationMs: 60_000 })).toBe(false);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-a", fence: first!.fence, state: "validating" })).toBe(false);
    expect(await db.recordPublicationPush({ publicationId: record.id, owner: "worker-a", fence: first!.fence, pushRef: `refs/heads/codeforge/publication/${record.id}` })).toBe(false);
    expect(await db.recordPublicationPullRequest({ publicationId: record.id, owner: "worker-a", fence: first!.fence, pullRequestNumber: 1, pullRequestUrl: "https://github.test/codeforge/fixture/pull/1" })).toBe(false);
    expect(await db.completePublication({ publicationId: record.id, owner: "worker-a", fence: first!.fence })).toBe(false);
    expect(await db.releasePublicationLease({ publicationId: record.id, owner: "worker-a", fence: first!.fence })).toBe(false);

    expect(await db.renewPublicationLease({ publicationId: record.id, owner: "worker-b", fence: second!.fence, leaseDurationMs: 60_000 })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "validating" })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "pushing" })).toBe(false);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "validated" })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "authorizing" })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "checking_target" })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "pushing" })).toBe(true);
    expect(await db.recordPublicationPush({ publicationId: record.id, owner: "worker-b", fence: second!.fence, pushRef: `refs/heads/codeforge/publication/${record.id}` })).toBe(true);
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "creating_pr" })).toBe(true);
    expect(await db.recordPublicationPullRequest({ publicationId: record.id, owner: "worker-b", fence: second!.fence, pullRequestNumber: 42, pullRequestUrl: "https://github.test/codeforge/fixture/pull/42" })).toBe(true);
    expect(await db.completePublication({ publicationId: record.id, owner: "worker-b", fence: second!.fence })).toBe(true);

    expect(await db.acquirePublicationLease({ publicationId: record.id, owner: "worker-c", leaseDurationMs: 60_000 })).toBeUndefined();
    expect(await db.updatePublicationState({ publicationId: record.id, owner: "worker-b", fence: second!.fence, state: "failed_retryable" })).toBe(false);
    expect(await db.recordPublicationPush({ publicationId: record.id, owner: "worker-b", fence: second!.fence, pushRef: `refs/heads/codeforge/publication/${record.id}` })).toBe(false);
    expect(await db.recordPublicationPullRequest({ publicationId: record.id, owner: "worker-b", fence: second!.fence, pullRequestNumber: 99, pullRequestUrl: "https://github.test/codeforge/fixture/pull/99" })).toBe(false);
    expect(await db.completePublication({ publicationId: record.id, owner: "worker-b", fence: second!.fence })).toBe(false);
    expect((await db.getPublicationById(record.id))?.state).toBe("completed");
  });
});
