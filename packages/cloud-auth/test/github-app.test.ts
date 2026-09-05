import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { GitHubAppAuthorizationService } from "../src/github-app-authorization.js";
import { GitHubAppClient } from "../src/github-app.js";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))); });

describe("GitHub App installation token broker", () => {
  it("verifies the selected repository and mints a repository-restricted ephemeral token", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
    const server = http.createServer((request, response) => {
      expect(request.headers.authorization).toMatch(/^Bearer ey/);
      if (request.url === "/app/installations/8") response.end(JSON.stringify({ id: 8, account: { id: 7, login: "codeforge", type: "Organization" }, repository_selection: "selected", permissions: { contents: "write", pull_requests: "write" } }));
      else if (request.url === "/app/installations/8/repositories?per_page=100&page=1") response.end(JSON.stringify({ repositories: [{ id: 9, node_id: "R_9", name: "fixture", private: true, owner: { login: "codeforge" } }] }));
      else if (request.url === "/app/installations/8/access_tokens" && request.method === "POST") { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { expect(JSON.parse(body)).toEqual({ repository_ids: [9], permissions: { contents: "write", pull_requests: "write" } }); response.end(JSON.stringify({ token: "cloud-only-token", expires_at: new Date(Date.now() + 60_000).toISOString(), permissions: { contents: "write", pull_requests: "write" } })); }); }
      else response.writeHead(404).end();
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as { port: number };
    const client = new GitHubAppClient({ appId: "123", privateKeyPem: privateKey, apiBase: `http://127.0.0.1:${address.port}` });
    await expect(client.mintRepositoryToken(8, { id: 9, nodeId: "R_9", owner: "codeforge", name: "fixture", private: true })).resolves.toMatchObject({ repositoryId: 9, permissions: { contents: "write", pull_requests: "write" } });
  });

  it("binds random callback state to one user and one use, expires it, keys grants by repository id, and honors revocation", async () => {
    const db = new SQLiteCloudDatabase({ dbPath: ":memory:" });
    await db.init();
    const userA = await db.createUser({ displayName: "User A", primaryIdentity: `github:${crypto.randomUUID()}` });
    const userB = await db.createUser({ displayName: "User B", primaryIdentity: `github:${crypto.randomUUID()}` });
    const client = {
      getInstallation: async (id: number) => ({ id, account: { id: 77, login: "same-name", type: "Organization" as const }, repositorySelection: "selected" as const, permissions: { contents: "write" as const, pull_requests: "write" as const } }),
      listInstallationRepositories: async () => [{ id: 9001, owner: "same-name", name: "repository", private: true }],
    } as unknown as GitHubAppClient;
    const service = new GitHubAppAuthorizationService({ db, appConfig: { appId: "123", privateKeyPem: "unused-test-key" }, client });

    const first = await service.startAuthorization(userA.id, "device-a");
    const second = await service.startAuthorization(userA.id, "device-a");
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.state).not.toBe(first.state);
    expect(first.installationUrl).toContain(encodeURIComponent(first.state));

    await expect(service.handleCallback({ state: first.state, installationId: 88, expectedUserId: userB.id, deviceSessionId: "device-a" })).rejects.toThrow("AUTHORIZATION_USER_MISMATCH");
    await expect(service.handleCallback({ state: first.state, installationId: 88, expectedUserId: userA.id, deviceSessionId: "device-a" })).rejects.toThrow("AUTHORIZATION_STATE_REPLAYED");

    const authorized = await service.handleCallback({ state: second.state, installationId: 88, expectedUserId: userA.id, deviceSessionId: "device-a" });
    expect(authorized.repositories).toHaveLength(1);
    await expect(service.handleCallback({ state: second.state, installationId: 88, expectedUserId: userA.id, deviceSessionId: "device-a" })).rejects.toThrow("AUTHORIZATION_STATE_REPLAYED");
    await expect(service.resolveRepositoryAuthorization(userA.id, 9001)).resolves.toMatchObject({ authorization: { repositoryId: 9001 } });
    await expect(service.resolveRepositoryAuthorization(userA.id, 9002)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");
    await expect(service.resolveRepositoryAuthorization(userB.id, 9001)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");

    await service.revokeInstallation(authorized.installation.id);
    await expect(service.resolveRepositoryAuthorization(userA.id, 9001)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");

    const expiring = new GitHubAppAuthorizationService({ db, appConfig: { appId: "123", privateKeyPem: "unused-test-key" }, client, stateTtlSeconds: -1 });
    const expired = await expiring.startAuthorization(userA.id);
    await expect(expiring.handleCallback({ state: expired.state, installationId: 89, expectedUserId: userA.id })).rejects.toThrow("AUTHORIZATION_STATE_EXPIRED");
    await db.close();
  });
});
