import { writeFile } from 'node:fs/promises';
const cloudUrl = 'https://codeforge-cloud-va.onrender.com';
const endpoints = [];
for (const path of ['/health/live', '/health/ready', '/v1/remote-direct/sessions']) {
  const response = await fetch(`${cloudUrl}${path}`, { signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  endpoints.push({ observedAt: new Date().toISOString(), path, httpStatus: response.status, body });
}
const output = { generatedAt: new Date().toISOString(), cloudUrl, endpoints,
  status: endpoints[0].httpStatus === 200 && endpoints[1].httpStatus === 200 && endpoints[2].httpStatus === 401 ? 'PASS' : 'FAIL' };
const path = process.argv[2] ?? 'docs/evidence/free-capacity-fabric/R65-PRODUCTION-FINAL-HEALTH.json';
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ status: output.status, revision: endpoints[0].body.deployment?.commit, remoteDirect: endpoints[0].body.remoteDirect, readiness: endpoints[1].body.status }));
if (output.status !== 'PASS') process.exitCode = 1;
