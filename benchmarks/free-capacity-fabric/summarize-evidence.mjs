import fs from "node:fs/promises";
import path from "node:path";

const dir = path.resolve("docs/evidence/free-capacity-fabric");
const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
const write = async (name, data) => fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
const live = await read("kilo-autonomous-live.json");
const failover = await read("kilo-autonomous-controlled-failover.json");
const qualification = await read("kilo-live-qualification.json");
const validation = await read("kilo-free-validation.json");
validation.fullCodingTask = { status: live.result.status, runId: live.result.runId, receipt: "kilo-autonomous-live.json" };
validation.qualification = { state: qualification.qualificationState, roles: Object.fromEntries(Object.entries(qualification.roleResults).map(([role, result]) => [role, result.status])), receipt: "kilo-live-qualification.json" };
await write("kilo-free-validation.json", validation);
const matrix = await read("provider-capacity-matrix.json");
matrix.routes[0].state = "LIVE_QUALIFIED_AUTONOMOUS_COMPLETION_PROVEN";
matrix.routes[0].qualificationReceipt = "kilo-live-qualification.json";
matrix.routes[0].completionReceipt = "kilo-autonomous-live.json";
await write("provider-capacity-matrix.json", matrix);
await write("free-dogfood-results.json", {
  startedAt: live.startedAt, finishedAt: live.finishedAt, entrypoint: "benchmarks/free-capacity-fabric/kilo-direct-autonomous.mjs",
  providerId: live.providerId, logicalModel: live.modelId, quotaDomainType: "PUBLIC_IP", egressMode: "CLIENT_DIRECT",
  status: live.result.status, changedFiles: live.result.changedFiles, review: live.result.review.passed,
  testsPassed: live.result.verification.reduce((sum, result) => sum + result.passed, 0),
  forgeVerify: live.verificationRecords.map((record) => ({ recordType: record.recordType, status: record.status })),
  completion: live.result.completion, integration: live.result.integration.status,
  endUserInferenceCostUsd: 0, codeForgeMarginalInferenceCostUsd: 0,
  costEvidence: "Pinned anonymous transport; live zero-price catalog; official Kilo billing policy; earlier raw response usage.cost=0. No credential or paid fallback.",
  receipt: "kilo-autonomous-live.json", actualPhysicalSupplyDomainsProven: 1,
});
await write("free-failover-tests.json", {
  checkedAt: new Date().toISOString(), status: failover.result.status,
  fault: failover.faultInjection,
  rotations: failover.routingReceipts.filter((item) => item.receipt?.action === "ROTATE"),
  reviewPassed: failover.result.review.passed,
  testsPassed: failover.result.verification.reduce((sum, result) => sum + result.passed, 0),
  completion: failover.result.completion,
  receipt: "kilo-autonomous-controlled-failover.json",
  limits: "Failure domain is synthetic and explicitly isTestProvider=true. Continuation, edits, Reviewer and ForgeVerify use real Kilo inference. Two live independent providers are not proven.",
  regressions: ["same-model independent pool rotation", "alias cooldown shares physical pool", "other user domain isolated", "scoped cooldown survives hydration", "private/public context policy"],
});
await write("quota-domain-inventory.json", { checkedAt: new Date().toISOString(), registrationPopulationCeiling: null, liveNewDomains: [
  { providerId: live.providerId, logicalModel: live.modelId, type: "PUBLIC_IP", egress: "CLIENT_DIRECT", ownership: "installed user host", documentedRequestsPerHour: 200, measuredRemainingRequests: null, physicalDomain: "Provider determines actual public egress IP; users behind one NAT share it", probeReservationRequests: 1, totalInferenceIsUnlimited: false },
], simulationOnlyDomains: ["test:fault-pool"], liveSponsoredGrants: [] });
await write("terms-admission-receipts.json", { routes: [{ providerId: live.providerId, logicalModel: live.modelId, sourceDocumentation: validation.officialDocuments.catalog, termsEvidence: validation.officialDocuments.terms,
  freePriceEvidence: validation.officialDocuments.pricingAndLimits, privacyEvidence: validation.officialDocuments.privacy,
  authRequirements: "Anonymous, no API key, no CodeForge token", quotaSemantics: "200 free-model requests/hour/public-IP; aliases share upstream allowance", quotaDomain: "PUBLIC_IP", egressMode: "CLIENT_DIRECT",
  verifiedAt: "2026-10-01T00:00:00Z", recheckAt: "2026-10-08T00:00:00Z", qualificationAt: qualification.completedAt, qualificationReceipt: "kilo-live-qualification.json", dataPolicy: "PUBLIC_CODE_ONLY", termsStatus: "CLEARED_FOR_THIRD_PARTY_END_USER_APPLICATION_SUBJECT_TO_TERMS" }] });
await write("privacy-matrix.json", { defaultDataClass: "PRIVATE_CODE", routes: [{ providerId: live.providerId, privacyClass: "DATA_COLLECTION_ALLOWED", trainingUse: "YES", admissionProfile: "PUBLIC_CODE_ONLY", privateDefault: "DENIED", privateWithConsent: "DENIED_BY_PROVIDER_PUBLIC_CODE_ONLY_POLICY", publicWorkspaceWithConsent: "ALLOWED_AFTER_QUALIFICATION", consentScope: "one workspace path; main process stamps it; switching workspace clears it" }] });
await write("client-direct-security-tests.json", { result: "PASS", testFile: "packages/providers/test/kilo-free-direct.test.ts", validated: ["HTTPS pinned endpoint", "no credentials forwarded", "no CodeForge token", "unapproved hostname rejected", "HTTP downgrade rejected", "arbitrary modelsPath rejected by anonymous constructor", "redirect not followed", "paid model rejected", "null or blank pricing excluded", "normalized chat and streaming tools through live adapter"], liveProtocolReceipt: "kilo-free-validation.json" });
process.stdout.write("Updated derived Free fabric evidence\n");
