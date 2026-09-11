import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodeForgeCloudServer } from "../src/index.js";
import { loginToCloud, createMockGitHubFetch } from "../../../tests/helpers/cloud-login.js";

// R1 legal remediation spec §23-31, §54: cloud account deletion (LEG-P0-02 / GDPR Art. 17).
describe("DELETE /v1/account — GDPR erasure", () => {
  let server: CodeForgeCloudServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new CodeForgeCloudServer({
      jwtSecret: "test-jwt-secret-32-character-long",
      fetchFn: createMockGitHubFetch(),
      stripeConfig: { secretKey: "sk_test_1", webhookSecret: "whsec_1", proPriceId: "price_pro", creditPackPriceId: "price_credits" },
    });
    const port = await server.start(0);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("rejects an unauthenticated deletion request", async () => {
    const res = await fetch(`${baseUrl}/v1/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects deletion without the explicit confirmation field, and the account survives", async () => {
    const tokens = await loginToCloud(baseUrl, { loopbackPort: 21001 });
    const res = await fetch(`${baseUrl}/v1/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const account = await fetch(`${baseUrl}/v1/account`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    expect(account.status).toBe(200);
  });

  it("userId comes only from the verified token — there is no field to target a different account", async () => {
    const alice = await loginToCloud(baseUrl, { loopbackPort: 21002 });
    // A bystander created directly at the DB layer (this codebase's established pattern for a
    // "second user" fixture — see apps/cloud-api/test/publication-service.e2e.test.ts), so its
    // survival can be checked independent of the GitHub-login mock, which always resolves to one
    // fixed profile and therefore cannot itself mint two distinct logged-in identities.
    const bob = await server.db.createUser({ displayName: "Bob Bystander", primaryIdentity: `github:bob-${Date.now()}` });

    const del = await fetch(`${baseUrl}/v1/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${alice.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT", userId: bob.id }), // extraneous field must be ignored, not honored
    });
    expect(del.status).toBe(200);
    const receipt = await del.json();
    expect(receipt.userId).toBe(alice.user.id);
    expect(receipt.userId).not.toBe(bob.id);

    expect(await server.db.getUserById(alice.user.id)).toBeUndefined();
    expect(await server.db.getUserById(bob.id)).toBeDefined();
  });

  it("deletes the account, its hosted workflow sessions, and is safely idempotent on retry", async () => {
    const tokens = await loginToCloud(baseUrl, { loopbackPort: 21003 });
    const auth = { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" };

    const workflow = await (
      await fetch(`${baseUrl}/v1/workflows`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ workerId: "worker-1", workspaceId: "ws-1", task: "test task" }),
      })
    ).json();
    expect(workflow.id).toBeDefined();

    const del1 = await fetch(`${baseUrl}/v1/account`, { method: "DELETE", headers: auth, body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }) });
    expect(del1.status).toBe(200);
    const receipt1 = await del1.json();
    expect(receipt1.deletionRequestId).toBeDefined();
    expect(receipt1.sessionsDeleted).toBe(1);
    expect(receipt1.categoriesProcessed).toEqual(expect.arrayContaining(["USER_CONTENT", "AUTH_DATA", "SESSION_CONTENT"]));
    expect(receipt1.retainedCategories).toEqual(expect.arrayContaining(["SECURITY_AUDIT", "BILLING_RECORD"]));
    // The receipt must never carry an inventory of what was deleted (R1 spec §85) — no message
    // bodies, no task titles, no raw row dumps.
    expect(JSON.stringify(receipt1)).not.toContain("test task");

    // The workflow is gone: fetching it now (still within the same still-cryptographically-valid
    // access token's lifetime) reports not-found rather than returning stale content.
    const wfAfter = await fetch(`${baseUrl}/v1/workflows/${workflow.id}`, { headers: auth });
    expect(wfAfter.status).toBe(404);

    // Retry: an already-issued access token remains cryptographically valid for its remaining
    // lifetime even though the account is gone (a documented, bounded limitation — see server.ts).
    // The retried deletion call itself must be a safe no-op, not an error or a crash.
    const del2 = await fetch(`${baseUrl}/v1/account`, { method: "DELETE", headers: auth, body: JSON.stringify({ confirmation: "DELETE_MY_ACCOUNT" }) });
    expect(del2.status).toBe(200);
    const receipt2 = await del2.json();
    expect(receipt2.sessionsDeleted).toBe(0);
  });
});
