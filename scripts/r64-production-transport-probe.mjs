import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const cloud = "https://codeforge-cloud-va.onrender.com";
const evidencePath = "docs/evidence/free-capacity-fabric/R64-PRODUCTION-REMOTE-TRANSPORT.json";
const report = { startedAt: new Date().toISOString(), status: "AWAITING_NORMAL_GITHUB_SIGN_IN", inferenceCalls: 0,
  credentialPersistence: "MEMORY_ONLY", checks: [], assignment: "NOT_PROVEN", acknowledgement: "NOT_PROVEN",
  result: "NOT_PROVEN", feedback: "NOT_PROVEN", codingCompletion: "NOT_PROVEN" };
let accessToken;
let refreshToken;
let authStart;
let workflowId;
let redirectUri;
let finished = false;
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const persist = () => writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
async function request(path, body, authenticated = true) {
  const response = await fetch(`${cloud}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(authenticated && accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function check(name, path, body, expected, authenticated = true) {
  const response = await request(path, body, authenticated);
  report.checks.push({ name, httpStatus: response.status, expected, passed: response.status === expected });
  return response;
}
async function exercise(code) {
  const exchange = await check("normal_pkce_exchange", "/v1/auth/exchange", { code, codeVerifier: verifier, redirectUri,
    deviceName: "CodeForge R64 production transport validation" }, 200, false);
  if (!exchange.data.accessToken || !exchange.data.refreshToken) throw new Error("AUTH_EXCHANGE_FAILED");
  accessToken = exchange.data.accessToken;
  refreshToken = exchange.data.refreshToken;
  const health = await check("deployed_health", "/health/live", undefined, 200, false);
  report.deployment = health.data.deployment;
  report.transport = health.data.remoteDirect;
  const deviceId = `r64-probe-${randomBytes(8).toString("hex")}`;
  const workspaceId = `r64-public-transport-${randomBytes(8).toString("hex")}`;
  await check("unauthenticated_bootstrap", "/v1/remote-direct/sessions", { deviceId, workspaceId }, 401, false);
  await check("wildcard_scope_denied", "/v1/remote-direct/sessions", { deviceId, workspaceId: "*" }, 409);
  await check("unregistered_workspace_denied", "/v1/remote-direct/sessions", { deviceId, workspaceId }, 409);
  const workflow = await check("owner_workflow_scope_created", "/v1/workflows", { workerId: deviceId, workspaceId,
    task: "R64 public synthetic transport validation. No inference or source changes requested." }, 201);
  workflowId = workflow.data.id;
  if (!workflowId) throw new Error("WORKFLOW_SCOPE_FAILED");
  const bootstrap = await check("authenticated_owner_bootstrap", "/v1/remote-direct/sessions", { deviceId, workspaceId }, 201);
  const sessionId = bootstrap.data.identity?.sessionId;
  if (!sessionId) throw new Error("TRANSPORT_BOOTSTRAP_FAILED");
  report.sessionId = sessionId;
  const sessionPath = `/v1/remote-direct/sessions/${encodeURIComponent(sessionId)}`;
  const poll = await check("authenticated_poll", `${sessionPath}/poll`, {}, 200);
  report.assignmentCount = Array.isArray(poll.data) ? poll.data.length : null;
  await check("authenticated_heartbeat", `${sessionPath}/heartbeat`, {}, 200);
  await check("malformed_ack_denied", `${sessionPath}/jobs/unassigned/ack`, {}, 400);
  await check("malformed_result_denied", `${sessionPath}/jobs/unassigned/result`, {}, 400);
  await check("malformed_feedback_denied", `${sessionPath}/jobs/unassigned/feedback`, {}, 400);
  await check("session_revoke", `${sessionPath}/revoke`, {}, 200);
  await check("revoked_session_poll_denied", `${sessionPath}/poll`, {}, 409);
  await check("probe_workflow_cancel", `/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, {}, 200);
  workflowId = undefined;
  await check("probe_device_logout", "/v1/auth/logout", { refreshToken }, 200, false);
  refreshToken = undefined;
  await check("logged_out_access_denied", "/v1/account", undefined, 401);
  report.status = report.checks.every((entry) => entry.passed) ? "CONTROL_TRANSPORT_VERIFIED_EXECUTION_UNPROVEN" : "CHECK_FAILED";
  report.blockers = ["Production entrypoint has no configured Capacity Fabric remote dispatch composition.",
    "No independent Domain B Free account was authorized.", "No second real user was available for live cross-owner isolation."];
}
const listener = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1");
  if (path.pathname === "/begin") { res.writeHead(302, { location: authStart.authUrl, "cache-control": "no-store" }); res.end(); return; }
  if (path.pathname !== "/auth/callback" || finished) { res.writeHead(404); res.end(); return; }
  finished = true;
  try {
    const code = path.searchParams.get("code");
    if (!code) throw new Error("AUTH_CALLBACK_FAILED");
    await exercise(code);
  } catch (error) {
    report.status = "PROBE_FAILED";
    report.errorCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "REQUEST_FAILED";
  } finally {
    if (workflowId) await request(`/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, {}).catch(() => {});
    if (refreshToken) await request("/v1/auth/logout", { refreshToken }, false).catch(() => {});
    accessToken = undefined; refreshToken = undefined;
    report.finishedAt = new Date().toISOString();
    await persist();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<h1>CodeForge R64 transport validation</h1><p>${report.status}</p><p>Credentials stayed in memory. No inference was requested. The temporary validation session has been logged out.</p>`);
    console.log(JSON.stringify({ status: report.status, passed: report.checks.filter((entry) => entry.passed).length,
      failed: report.checks.filter((entry) => !entry.passed).length, evidencePath }));
    listener.close();
    clearTimeout(expiration);
  }
});
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
redirectUri = `http://127.0.0.1:${port}/auth/callback`;
const start = await request("/v1/auth/start", { redirectUri, codeChallenge: challenge,
  deviceName: "CodeForge R64 production transport validation" }, false);
if (start.status !== 200 || !start.data.authUrl) { listener.close(); throw new Error("AUTH_START_FAILED"); }
authStart = start.data;
await persist();
console.log(JSON.stringify({ browserUrl: `http://127.0.0.1:${port}/begin`, evidencePath }));
const expiration = setTimeout(async () => {
  if (!finished) { report.status = "SIGN_IN_NOT_COMPLETED"; await persist(); listener.close(); }
}, 15 * 60 * 1000);
