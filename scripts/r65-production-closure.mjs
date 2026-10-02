import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runProductionCoding } from '../benchmarks/free-capacity-fabric/r65-production-coding.mjs';
import { SecretScanner } from '@codeforge/secrets';

const cloudUrl = 'https://codeforge-cloud-va.onrender.com';
const evidencePath = 'docs/evidence/free-capacity-fabric/R65-PRODUCTION-DISPATCH.json';
const report = { startedAt: new Date().toISOString(), status: 'AWAITING_NORMAL_GITHUB_SIGN_IN', credentialPersistence: 'MEMORY_ONLY', authentication: 'REAL_GITHUB_PKCE', checks: [] };
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
let accessToken;
let refreshToken;
let authUrl;
let redirectUri;
let finished = false;
const persist = () => writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
async function request(path, body, authenticated = true) {
  const response = await fetch(`${cloudUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated && accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  report.checks.push({ at: new Date().toISOString(), path, httpStatus: response.status });
  await persist();
  return { status: response.status, data };
}
const listener = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/begin') {
    res.writeHead(302, { location: authUrl, 'cache-control': 'no-store' }); res.end(); return;
  }
  if (url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<h1>CodeForge R65 production coding</h1><p>${report.status}</p><p>Credentials remain in memory. Evidence contains no tokens.</p>`); return;
  }
  if (url.pathname !== '/auth/callback' || finished) { res.writeHead(404); res.end(); return; }
  finished = true;
  res.writeHead(302, { location: '/status', 'cache-control': 'no-store' }); res.end();
  try {
    const code = url.searchParams.get('code');
    if (!code) throw new Error('AUTH_CALLBACK_FAILED');
    const exchange = await request('/v1/auth/exchange', { code, codeVerifier: verifier, redirectUri, deviceName: 'CodeForge R65 production closure' }, false);
    if (exchange.status !== 200 || !exchange.data.accessToken || !exchange.data.refreshToken || !exchange.data.user?.id) throw new Error('AUTH_EXCHANGE_FAILED');
    accessToken = exchange.data.accessToken; refreshToken = exchange.data.refreshToken;
    const prior = await readFile('docs/evidence/free-capacity-fabric/R65-PRODUCTION-REMOTE-CODING-ATTEMPT-2.json', 'utf8').then(JSON.parse).catch(() => undefined);
    if (prior?.result?.status === 'blocked' && prior.workflowId) {
      report.priorFixtureCleanup = (await request(`/v1/workflows/${encodeURIComponent(prior.workflowId)}/cancel`, {})).status;
    }
    report.status = 'PRODUCTION_CODING_RUNNING';
    const health = await request('/health/live', undefined, false);
    report.deployment = health.data.deployment;
    if (!health.data.remoteDirect?.dispatchConfigured) throw new Error('R65_PRODUCTION_DISPATCH_NOT_DEPLOYED');
    await persist();
    const result = await runProductionCoding({ cloudUrl, accessToken, userId: exchange.data.user.id, request });
    report.coding = result;
    report.status = result.status === 'completed' ? 'PASS' : 'CODING_NOT_COMPLETED';
  } catch (error) {
    report.status = 'FAIL';
    report.errorCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PRODUCTION_REQUEST_FAILED';
    report.diagnostic = new SecretScanner().redact(error instanceof Error ? error.stack ?? error.message : 'Unknown production error');
  } finally {
    if (refreshToken) report.logout = (await request('/v1/auth/logout', { refreshToken }, false).catch(() => ({ status: 0 }))).status;
    accessToken = undefined; refreshToken = undefined;
    report.finishedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ status: report.status, coding: report.coding, errorCode: report.errorCode, evidencePath }));
    clearTimeout(expiration);
    setTimeout(() => listener.close(), 30_000).unref();
  }
});
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
redirectUri = `http://127.0.0.1:${listener.address().port}/auth/callback`;
const start = await request('/v1/auth/start', { redirectUri, codeChallenge: challenge, deviceName: 'CodeForge R65 production closure' }, false);
if (start.status !== 200 || !start.data.authUrl) { listener.close(); throw new Error('AUTH_START_FAILED'); }
authUrl = start.data.authUrl; await persist();
console.log(JSON.stringify({ browserUrl: `http://127.0.0.1:${listener.address().port}/begin`, evidencePath }));
const expiration = setTimeout(async () => {
  if (!finished) { report.status = 'SIGN_IN_NOT_COMPLETED'; await persist(); listener.close(); }
}, 15 * 60_000);
