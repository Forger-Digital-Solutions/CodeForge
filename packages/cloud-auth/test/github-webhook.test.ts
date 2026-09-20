import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQLiteCloudDatabase } from "@codeforge/cloud-db";
import { GitHubAppAuthorizationService } from "../src/github-app-authorization.js";
import type { GitHubAppClient } from "../src/github-app.js";
import { GitHubWebhookService, verifyGitHubWebhookSignature, GITHUB_WEBHOOK_ERRORS } from "../src/github-webhook.js";

/**
 * R22 M7 — GitHub App webhook ingestion: HMAC verification, atomic delivery dedup, and
 * access-invalidation semantics proven against the real sqlite-backed database.
 */

const SECRET = "whsec_test_github_42";

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

async function harness(repositories: Array<{ id: number; owner: string; name: string; private: boolean }> = [
  { id: 9001, owner: "acme", name: "widget", private: true },
  { id: 9002, owner: "acme", name: "gizmo", private: false },
]) {
  const db = new SQLiteCloudDatabase({ dbPath: ":memory:" });
  await db.init();
  const user = await db.createUser({ displayName: "Owner", primaryIdentity: `github:${crypto.randomUUID()}` });
  const client = {
    getInstallation: async (id: number) => ({ id, account: { id: 77, login: "acme", type: "Organization" as const }, repositorySelection: "selected" as const, permissions: {} }),
    listInstallationRepositories: async () => repositories,
  } as unknown as GitHubAppClient;
  const authorization = new GitHubAppAuthorizationService({ db, appConfig: { appId: "123", privateKeyPem: "unused" }, client });
  const webhook = new GitHubWebhookService({ db, webhookSecret: SECRET, authorization });

  // Establish a live installation with two authorized repositories through the real flow.
  const { state } = await authorization.startAuthorization(user.id);
  const callback = await authorization.handleCallback({ state, installationId: 88, expectedUserId: user.id });
  return { db, user, webhook, authorization, installation: callback.installation };
}

describe("GitHub webhook signature verification", () => {
  it("accepts a correctly-signed body and rejects tampered/missing signatures", async () => {
    const body = JSON.stringify({ zen: "testing" });
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), sign(body))).toBe(true);
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), sign(body + " "))).toBe(false);
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), sign(body, "wrong-secret"))).toBe(false);
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), undefined)).toBe(false);
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), "sha256=nothex")).toBe(false);
    expect(verifyGitHubWebhookSignature(SECRET, Buffer.from(body), `sha1=${sign(body).slice(7)}`)).toBe(false);
  });
});

describe("GitHub webhook ingestion", () => {
  it("rejects unsigned deliveries before any state mutation", async () => {
    const { db, webhook, authorization, user } = await harness();
    await expect(webhook.handleDelivery({
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: JSON.stringify({ action: "deleted", installation: { id: 88 } }),
    })).rejects.toMatchObject({ code: GITHUB_WEBHOOK_ERRORS.SIGNATURE_MISSING });
    // Grant is untouched — a forged "deleted" webhook must never revoke access.
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9001)).resolves.toBeTruthy();
    await db.close();
  });

  it("rejects a validly-shaped signature computed with the wrong secret", async () => {
    const { db, webhook } = await harness();
    const body = JSON.stringify({ action: "deleted", installation: { id: 88 } });
    await expect(webhook.handleDelivery({
      signatureHeader: sign(body, "attacker-secret"),
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: body,
    })).rejects.toMatchObject({ code: GITHUB_WEBHOOK_ERRORS.SIGNATURE_INVALID });
    await db.close();
  });

  it("installation.deleted revokes the installation and every grant under it", async () => {
    const { db, webhook, authorization, user } = await harness();
    const body = JSON.stringify({ action: "deleted", installation: { id: 88 } });
    const result = await webhook.handleDelivery({
      signatureHeader: sign(body),
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: body,
    });
    expect(result.action).toBe("installation_revoked");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9001)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9002)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");
    await db.close();
  });

  it("installation.suspend denies grants without destroying them; unsuspend resyncs", async () => {
    const { db, webhook, authorization, user } = await harness();
    const suspendBody = JSON.stringify({ action: "suspend", installation: { id: 88 } });
    const suspendResult = await webhook.handleDelivery({
      signatureHeader: sign(suspendBody),
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: suspendBody,
    });
    expect(suspendResult.action).toBe("installation_suspended");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9001)).rejects.toThrow("INSTALLATION_REVOKED");

    const unsuspendBody = JSON.stringify({ action: "unsuspend", installation: { id: 88 } });
    const unsuspendResult = await webhook.handleDelivery({
      signatureHeader: sign(unsuspendBody),
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: unsuspendBody,
    });
    expect(unsuspendResult.action).toBe("installation_resynced");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9001)).resolves.toBeTruthy();
    await db.close();
  });

  it("installation_repositories.removed deletes only the named grants of that installation", async () => {
    const { db, webhook, authorization, user } = await harness();
    const body = JSON.stringify({ action: "removed", installation: { id: 88 }, repositories_removed: [{ id: 9001 }] });
    const result = await webhook.handleDelivery({
      signatureHeader: sign(body),
      deliveryId: crypto.randomUUID(),
      event: "installation_repositories",
      rawBody: body,
    });
    expect(result.action).toBe("repositories_removed");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9001)).rejects.toThrow("REPOSITORY_NOT_AUTHORIZED");
    // The sibling grant survives — removal is scoped, never a blanket revocation.
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9002)).resolves.toBeTruthy();
    await db.close();
  });

  it("deduplicates on X-GitHub-Delivery — a replayed deletion applies zero extra mutations", async () => {
    const { db, webhook, authorization, user } = await harness();
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ action: "removed", installation: { id: 88 }, repositories_removed: [{ id: 9001 }] });
    const first = await webhook.handleDelivery({ signatureHeader: sign(body), deliveryId, event: "installation_repositories", rawBody: body });
    expect(first.action).toBe("repositories_removed");

    // Re-deliver the identical payload: dedup fires before dispatch.
    const second = await webhook.handleDelivery({ signatureHeader: sign(body), deliveryId, event: "installation_repositories", rawBody: body });
    expect(second.action).toBe("duplicate_skipped");

    // A *different* delivery id with the same payload is a new event (idempotent handler).
    const third = await webhook.handleDelivery({ signatureHeader: sign(body), deliveryId: crypto.randomUUID(), event: "installation_repositories", rawBody: body });
    expect(third.action).toBe("repositories_removed");
    await expect(authorization.resolveRepositoryAuthorization(user.id, 9002)).resolves.toBeTruthy();
    await db.close();
  });

  it("unknown events and ping are ignored but recorded; unknown installations are ignored", async () => {
    const { db, webhook } = await harness();
    const pingBody = JSON.stringify({ zen: "Keep it simple" });
    const ping = await webhook.handleDelivery({ signatureHeader: sign(pingBody), deliveryId: crypto.randomUUID(), event: "ping", rawBody: pingBody });
    expect(ping.action).toBe("ignored");

    const starBody = JSON.stringify({ action: "created", repository: { id: 1 } });
    const star = await webhook.handleDelivery({ signatureHeader: sign(starBody), deliveryId: crypto.randomUUID(), event: "star", rawBody: starBody });
    expect(star.action).toBe("ignored");

    // Validly signed event for an installation we never authorized — no crash, no grants.
    const foreignBody = JSON.stringify({ action: "deleted", installation: { id: 999999 } });
    const foreign = await webhook.handleDelivery({ signatureHeader: sign(foreignBody), deliveryId: crypto.randomUUID(), event: "installation", rawBody: foreignBody });
    expect(foreign.action).toBe("ignored");
    await db.close();
  });

  it("dedup survives a restart — a delivery claimed before a crash is still claimed after", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf-webhook-restart-")), "webhooks.db");
    const deliveryId = crypto.randomUUID();
    const body = JSON.stringify({ zen: "restart-dedup" });

    const build = async () => {
      const db = new SQLiteCloudDatabase({ dbPath });
      await db.init();
      const client = {
        getInstallation: async (id: number) => ({ id, account: { id: 1, login: "acme", type: "Organization" as const }, repositorySelection: "all" as const, permissions: {} }),
        listInstallationRepositories: async () => [],
      } as unknown as GitHubAppClient;
      const authorization = new GitHubAppAuthorizationService({ db, appConfig: { appId: "1", privateKeyPem: "unused" }, client });
      return { db, webhook: new GitHubWebhookService({ db, webhookSecret: SECRET, authorization }) };
    };

    const first = await build();
    const r1 = await first.webhook.handleDelivery({ signatureHeader: sign(body), deliveryId, event: "ping", rawBody: body });
    expect(r1.action).toBe("ignored");
    await first.db.close();

    // Process "restarts": the dedup ledger is durable, not in-memory.
    const second = await build();
    const r2 = await second.webhook.handleDelivery({ signatureHeader: sign(body), deliveryId, event: "ping", rawBody: body });
    expect(r2.action).toBe("duplicate_skipped");
    await second.db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    const { db, webhook } = await harness();
    const bad = "not json {{{";
    await expect(webhook.handleDelivery({
      signatureHeader: sign(bad),
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: bad,
    })).rejects.toMatchObject({ code: GITHUB_WEBHOOK_ERRORS.PAYLOAD_INVALID });

    const huge = Buffer.alloc(1_100_000, 0x41);
    await expect(webhook.handleDelivery({
      signatureHeader: `sha256=${crypto.createHmac("sha256", SECRET).update(huge).digest("hex")}`,
      deliveryId: crypto.randomUUID(),
      event: "installation",
      rawBody: huge,
    })).rejects.toMatchObject({ code: GITHUB_WEBHOOK_ERRORS.PAYLOAD_TOO_LARGE });
    await db.close();
  });
});
