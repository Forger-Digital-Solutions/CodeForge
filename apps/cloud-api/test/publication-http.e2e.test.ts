import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { signAccessToken } from "@codeforge/cloud-auth";
import { CodeForgeCloudServer } from "../src/server.js";
import { publicationRefFor } from "../src/git-transport.js";
import {
  TEST_APP_CONFIG,
  cleanupHarness,
  createGitFixture,
  createHarness,
  listRemoteRefs,
  seedAccount,
  startFakeGitHub,
  tempDir,
} from "./helpers/publication-harness.js";

const JWT_SECRET = "cf11-http-ownership-jwt-secret-32-characters";

afterEach(async () => cleanupHarness());

describe("CF-11 authenticated publication HTTP ownership", () => {
  it("makes cross-user and unknown publication IDs indistinguishable before every privileged side effect", async () => {
    const fixture = await createGitFixture();
    const github = await startFakeGitHub(fixture.certifiedHead);
    const db = new SQLiteCloudDatabase({ dbPath: ":memory:" });
    const harness = await createHarness({ db, fixture, github });
    const server = new CodeForgeCloudServer({
      db,
      jwtSecret: JWT_SECRET,
      gitHubAppConfig: TEST_APP_CONFIG,
      publicationArtifactDir: await tempDir("cf11-http-server-artifacts-"),
      stripeConfig: null,
    });
    Object.defineProperty(server, "publicationService", { value: harness.service });

    const userA = await seedAccount(db, { owner: "shared-name", name: "repository", repositoryId: 71001, installationId: 72001 });
    const userB = await seedAccount(db, { owner: "shared-name", name: "repository", repositoryId: 71002, installationId: 72002 });
    const tokenA = signAccessToken({ sub: userA.userId, sid: "session-a" }, JWT_SECRET);
    const tokenB = signAccessToken({ sub: userB.userId, sid: "session-b" }, JWT_SECRET);
    const port = await server.start(0);
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
    const createBody = {
      deliveryId: `delivery-${crypto.randomUUID()}`,
      repositoryId: userA.repositoryId,
      targetBranch: fixture.targetBranch,
      baseSha: fixture.targetSha,
      targetSha: fixture.targetSha,
      certifiedHead: fixture.certifiedHead,
      certifiedTree: fixture.certifiedTree,
      artifactSha256: fixture.bundleSha256,
      artifactBytes: fixture.bundle.byteLength,
    };

    try {
      const unauthenticated = await fetch(`${baseUrl}/v1/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toMatchObject({ code: "UNAUTHENTICATED" });

      const confusedRepository = await fetch(`${baseUrl}/v1/publications`, {
        method: "POST",
        headers: { ...auth(tokenA), "Content-Type": "application/json" },
        body: JSON.stringify({ ...createBody, repositoryId: userB.repositoryId, deliveryId: `delivery-${crypto.randomUUID()}` }),
      });
      expect(confusedRepository.status).toBe(403);
      expect(await confusedRepository.json()).toMatchObject({ code: "REPOSITORY_NOT_AUTHORIZED" });

      const ownerLookup = await fetch(`${baseUrl}/v1/github-app/repositories?repositoryId=${userA.repositoryId}`, { headers: auth(tokenA) });
      expect(ownerLookup.status).toBe(200);
      expect(await ownerLookup.json()).toMatchObject({ repositoryId: userA.repositoryId, authorized: true });
      const nonOwnerLookup = await fetch(`${baseUrl}/v1/github-app/repositories?repositoryId=${userA.repositoryId}`, { headers: auth(tokenB) });
      expect(nonOwnerLookup.status).toBe(200);
      expect(await nonOwnerLookup.json()).toMatchObject({ repositoryId: userA.repositoryId, authorized: false });

      const createdResponse = await fetch(`${baseUrl}/v1/publications`, {
        method: "POST",
        headers: { ...auth(tokenA), "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: string; state: string };
      expect(created.state).toBe("awaiting_artifact");

      const unknownId = crypto.randomUUID();
      const cases = [
        { suffix: "", method: "GET", body: undefined },
        { suffix: "/artifact", method: "POST", body: Buffer.from(fixture.bundle) },
        { suffix: "/execute", method: "POST", body: undefined },
        { suffix: "/retry", method: "POST", body: undefined },
      ] as const;
      const before = await db.getPublicationById(created.id);
      for (const testCase of cases) {
        const denied = await fetch(`${baseUrl}/v1/publications/${created.id}${testCase.suffix}`, {
          method: testCase.method,
          headers: auth(tokenB),
          ...(testCase.body ? { body: testCase.body } : {}),
        });
        const unknown = await fetch(`${baseUrl}/v1/publications/${unknownId}${testCase.suffix}`, {
          method: testCase.method,
          headers: auth(tokenB),
          ...(testCase.body ? { body: testCase.body } : {}),
        });
        expect(denied.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(await denied.json()).toEqual(await unknown.json());
        expect(await db.getPublicationById(created.id)).toEqual(before);
        expect(harness.mintCalls).toHaveLength(0);
        expect(github.requests).toHaveLength(0);
        expect(await listRemoteRefs(fixture)).not.toContain(publicationRefFor(created.id));
      }

      const missingArtifact = await fetch(`${baseUrl}/v1/publications/${created.id}/execute`, { method: "POST", headers: auth(tokenA) });
      expect(missingArtifact.status).toBe(400);
      expect(await missingArtifact.json()).toMatchObject({ code: "ARTIFACT_MISSING", retryable: false });

      const upload = await fetch(`${baseUrl}/v1/publications/${created.id}/artifact`, {
        method: "POST",
        headers: { ...auth(tokenA), "Content-Type": "application/octet-stream", "Content-Length": String(fixture.bundle.byteLength) },
        body: fixture.bundle,
      });
      expect(upload.status).toBe(200);
      expect(await upload.json()).toMatchObject({ state: "artifact_uploaded" });

      const execute = await fetch(`${baseUrl}/v1/publications/${created.id}/execute`, { method: "POST", headers: auth(tokenA) });
      expect(execute.status).toBe(200);
      const completedText = await execute.text();
      expect(JSON.parse(completedText)).toMatchObject({ state: "completed", pushRef: publicationRefFor(created.id) });
      expect(completedText).not.toContain("ghs_");
      expect(completedText).not.toContain("PRIVATE KEY");
      expect(completedText).not.toContain("askpass");
      expect(harness.mintCalls).toHaveLength(1);
      expect(github.creates).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
