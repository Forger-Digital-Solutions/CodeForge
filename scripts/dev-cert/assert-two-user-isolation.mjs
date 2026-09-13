/**
 * Drives the production Cloud HTTP surface through the local IdP double for two fixed identities.
 * It proves bearer-bound account and allowance isolation while using only the deterministic devpool
 * fixture; it is not evidence of a real managed provider or upstream free capacity.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

const CLOUD_URL = process.env.DEV_CLOUD_URL ?? "http://127.0.0.1:3221";
const IDP_URL = process.env.DEV_IDP_URL ?? "http://127.0.0.1:3341";

function base64Url(value) {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function requireJson(response, label) {
  const text = await response.text();
  assert.equal(response.ok, true, `${label}: HTTP ${response.status} ${text}`);
  return JSON.parse(text);
}

async function login(identity, loopbackPort) {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const redirectUri = `http://127.0.0.1:${loopbackPort}/auth/callback`;
  const started = await requireJson(await fetch(`${CLOUD_URL}/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUri, codeChallenge: challenge, deviceName: `dev-cert-${identity}` }),
  }), `start ${identity}`);

  const authorize = new URL(started.authUrl);
  const approve = new URL("/approve", IDP_URL);
  for (const [key, value] of authorize.searchParams.entries()) approve.searchParams.set(key, value);
  approve.searchParams.set("identity", identity);
  const approved = await fetch(approve, { redirect: "manual" });
  assert.equal(approved.status, 302, `approve ${identity}: HTTP ${approved.status}`);
  const cloudCallback = approved.headers.get("location");
  assert.ok(cloudCallback, `approve ${identity}: missing Cloud callback`);

  const callback = await fetch(cloudCallback, { redirect: "manual" });
  const callbackBody = await callback.text();
  assert.equal(callback.status, 302, `callback ${identity}: HTTP ${callback.status} ${callbackBody}`);
  const loopback = callback.headers.get("location");
  assert.ok(loopback, `callback ${identity}: missing loopback callback`);
  const desktopCode = new URL(loopback).searchParams.get("code");
  assert.ok(desktopCode, `callback ${identity}: missing desktop code`);

  return requireJson(await fetch(`${CLOUD_URL}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: desktopCode, codeVerifier: verifier, redirectUri, deviceName: `dev-cert-${identity}` }),
  }), `exchange ${identity}`);
}

async function authenticated(path, accessToken) {
  return requireJson(await fetch(`${CLOUD_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }), path);
}

async function runFixtureInference(accessToken) {
  const response = await fetch(`${CLOUD_URL}/v1/hosted/inference`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      modelId: "auto",
      taskType: "coding",
      messages: [{ role: "user", content: "Report a deterministic fixture status." }],
    }),
  });
  if (response.status !== 200) {
    throw new Error(`fixture inference: HTTP ${response.status} ${await response.text()}`);
  }
  const stream = await response.text();
  assert.match(stream, /assistant\.message\.completed/);
  assert.match(stream, /turn\.completed/);
}

const userA = await login("cert-user-a", 47811);
const userB = await login("cert-user-b", 47812);
const [accountA, accountB, beforeA, beforeB] = await Promise.all([
  authenticated("/v1/account", userA.accessToken),
  authenticated("/v1/account", userB.accessToken),
  authenticated("/v1/usage", userA.accessToken),
  authenticated("/v1/usage", userB.accessToken),
]);

assert.equal(accountA.identity.login, "cert-user-a");
assert.equal(accountB.identity.login, "cert-user-b");
assert.notEqual(accountA.user.id, accountB.user.id);
assert.equal(beforeA.freeAllowance.periodStart, beforeB.freeAllowance.periodStart);
assert.equal(beforeA.freeAllowance.periodEnd, beforeB.freeAllowance.periodEnd);

await runFixtureInference(userA.accessToken);
const [afterA, afterB] = await Promise.all([
  authenticated("/v1/usage", userA.accessToken),
  authenticated("/v1/usage", userB.accessToken),
]);

assert.equal(afterA.recentEvents.length, beforeA.recentEvents.length + 1);
assert.equal(afterB.recentEvents.length, beforeB.recentEvents.length);
assert.ok(afterA.freeAllowance.remainingCredits < beforeA.freeAllowance.remainingCredits);
assert.equal(afterB.freeAllowance.remainingCredits, beforeB.freeAllowance.remainingCredits);

console.log(JSON.stringify({
  status: "pass",
  mode: "deterministic_fixture_only",
  identities: [accountA.identity.login, accountB.identity.login],
  isolatedUsageDelta: { userAEvents: 1, userBEvents: 0 },
  allowanceWindow: { start: afterA.freeAllowance.periodStart, end: afterA.freeAllowance.periodEnd },
}));
