import { writeFile } from "node:fs/promises";

const intendedRevision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(intendedRevision ?? "")) throw new Error("INTENDED_REVISION_REQUIRED");
const responses = [];
for (const path of ["/health/live", "/health/ready", "/v1/remote-direct/sessions"]) {
  const response = await fetch(`https://codeforge-cloud-va.onrender.com${path}`, { signal: AbortSignal.timeout(30000),
    ...(path.includes("sessions") ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}) });
  responses.push({ path, httpStatus: response.status, body: await response.json() });
}
const live = responses.find((entry) => entry.path === "/health/live");
const ready = responses.find((entry) => entry.path === "/health/ready");
const remote = responses.find((entry) => entry.path.includes("sessions"));
const result = { observedAt: new Date().toISOString(), intendedRevision, reportedRevision: live.body.deployment?.commit ?? null,
  revisionMatches: live.body.deployment?.commit === intendedRevision,
  serviceIdMatches: live.body.deployment?.serviceId === "srv-dam6f83m8hqs73clo5ig",
  livenessPassed: live.httpStatus === 200, readinessPassed: ready.httpStatus === 200,
  authenticatedRemoteEndpointAvailable: remote.httpStatus === 401,
  remoteDispatchConfigured: live.body.remoteDirect?.dispatchConfigured ?? false, responses };
await writeFile("docs/evidence/free-capacity-fabric/R64-PRODUCTION-HEALTH.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (!result.revisionMatches || !result.livenessPassed || !result.readinessPassed || !result.authenticatedRemoteEndpointAvailable) process.exitCode = 1;
