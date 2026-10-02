import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = "docs/evidence/free-capacity-fabric/";
const at = new Date().toISOString();
const save = (name, data) => writeFile(`${root}R64-${name}.json`, `${JSON.stringify({ generatedAt: at, ...data }, null, 2)}\n`);
const start = JSON.parse(await readFile(`${root}R64-START-STATE.json`, "utf8"));
const preserved = await Promise.all(start.preservedFiles.map(async (entry) => ({ ...entry,
  currentSha256: createHash("sha256").update(await readFile(entry.path)).digest("hex") })));
await save("PRESERVED-USER-WORK", { unchanged: preserved.every((entry) => entry.sha256 === entry.currentSha256), files: preserved });
await save("PROVIDER-READINESS", { humanResponse: "I don’t have an eligible Free account", inferenceProbesUsingExistingKeys: 0,
  candidates: [
    { provider: "Puter", classification: "UNKNOWN", quotaOwner: "PUTER_USER", connectionWorkflow: "Provider supports browser sign-in; no safe CodeForge Free connection is enabled.",
      storageMode: "NOT_IMPLEMENTED_FOR_FREE", automatedFreeVerification: false, automaticDomainAdmission: false, qualification: "BLOCKED",
      blocker: "Published monthly allowance metadata does not distinguish Free from purchased allowance or establish an enforceable Free-only spend boundary.",
      sources: ["https://docs.puter.com/Objects/monthlyusage/", "https://developer.puter.com/pricing/"] },
    { provider: "Cerebras", classification: "TRIAL_OFFER_UNVERIFIED_ACCOUNT", quotaOwner: "ACCOUNT_OR_PROJECT", connectionWorkflow: "Existing key entry supports encrypted storage, but key validity alone cannot establish a durable Free account.",
      storageMode: "ENCRYPTED_LOCAL_KEY_PATH", automatedFreeVerification: false, automaticDomainAdmission: false, qualification: "BLOCKED",
      blocker: "Current public offer is $5 trial credit. No authoritative durable Free account receipt was obtained.", sources: ["https://www.cerebras.ai/inference"] },
    { provider: "Cloudflare Workers AI", classification: "UNKNOWN", quotaOwner: "CLOUDFLARE_ACCOUNT", connectionWorkflow: "No registered CodeForge OAuth client with the necessary account and AI scopes is configured.",
      storageMode: "ENCRYPTED_LOCAL_KEY_PATH", automatedFreeVerification: false, automaticDomainAdmission: false, qualification: "BLOCKED",
      blocker: "Existing account subscription request returned HTTP 403. Workers Free plan, ownership and hard stop are unverified; account verifier and dedicated Free connection remain unfinished.",
      sources: ["https://developers.cloudflare.com/workers-ai/platform/pricing/", "https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/"] },
    { provider: "OpenRouter", classification: "EXISTING_ACCOUNT_PAID", quotaOwner: "USER_ACCOUNT", connectionWorkflow: "Settings → Free Capacity → Connect OpenRouter Free → browser OAuth PKCE → loopback callback",
      storageMode: "ENCRYPTED_LOCAL_OAUTH", automatedFreeVerification: true, automaticDomainAdmission: true, qualification: "AUTOMATIC_AFTER_VERIFIED_FREE_AUTHORIZATION",
      blocker: "Read-only current-key response is_free_tier=false. User has no eligible Free account to authorize. Existing key denied with no inference.",
      sources: ["https://openrouter.ai/docs/guides/overview/auth/oauth", "https://openrouter.ai/docs/api_reference/limits"] },
    { provider: "Groq", classification: "UNKNOWN", quotaOwner: "ORGANIZATION", connectionWorkflow: "Existing key entry supports encrypted storage; a dedicated Free organization verifier remains unfinished.",
      storageMode: "ENCRYPTED_LOCAL_KEY_PATH", automatedFreeVerification: false, automaticDomainAdmission: false, qualification: "BLOCKED",
      blocker: "No authoritative organization ownership, billing tier and current quota receipt was obtained. A shared environment key is not an independently owned user domain.",
      sources: ["https://console.groq.com/docs/rate-limits"] },
  ] });
await save("DOMAIN-B", { status: "BLOCKED", admitted: false, provider: null, liveCoding: "NOT_RUN", reason: "No eligible independently owned Free account was authorized. Paid and unknown existing credentials remain denied." });
await save("CROSS-DOMAIN-FAILOVER", { status: "BLOCKED", live: false, successfulFailovers: 0, reason: "Requires admitted and qualified Domain B.", syntheticFaultsCountedAsLive: false });
await save("MULTI-USER-INDEPENDENCE", { status: "BLOCKED", liveConcurrentUsers: 0, userADomain: "Kilo EGRESS_IP shared-unverified", userBDomain: null,
  overlap: "Same or unknown Kilo egress is one independence group.", credentialIsolation: "DETERMINISTIC_ONLY", quotaIsolation: "DETERMINISTIC_ONLY",
  healthIsolation: "DETERMINISTIC_ONLY", accountingIsolation: "DETERMINISTIC_ONLY", reason: "No second real user with independently owned Free quota was authorized." });
await save("PRIVACY-CLASSIFICATIONS", { privateDefault: "DENY_IF_UNVERIFIED", candidates: [
  { provider: "Kilo", classification: "PUBLIC_CODE_ONLY", privateCode: "DENIED", evidence: "R64-KILO-POLICY.json", publicFixtureConsent: "EXPLICIT" },
  { provider: "Puter", classification: "UNKNOWN", privateCode: "DENIED", reason: "No complete provider/model privacy receipt obtained." },
  { provider: "Cerebras", classification: "UNKNOWN", privateCode: "DENIED", reason: "No eligible account or complete Free tier privacy receipt obtained." },
  { provider: "Cloudflare Workers AI", classification: "PRIVATE_CODE_ALLOWED_BY_DOCUMENTED_POLICY_BUT_ACCOUNT_UNADMITTED", privateCode: "DENIED_UNTIL_ACCOUNT_AND_ROUTE_ADMISSION",
    source: "https://developers.cloudflare.com/workers-ai/platform/data-usage/" },
  { provider: "OpenRouter", classification: "REQUIRES_EXPLICIT_CONSENT_AND_UPSTREAM_POLICY_VERIFICATION", privateCode: "DENIED_WITHOUT_MATCHING_ROUTE_POLICY",
    source: "https://openrouter.ai/privacy" },
  { provider: "Groq", classification: "REQUIRES_ACCOUNT_DATA_CONTROL_VERIFICATION", privateCode: "DENIED_UNTIL_ACCOUNT_AND_ROUTE_ADMISSION", source: "https://console.groq.com/docs/your-data" },
] });
await save("FRESH-USER", { status: "PARTIAL", profile: "benchmarks/r64/tmp/fresh-profile", build: "CURRENT_SOURCE_ELECTRON_BUILD",
  cloudUrl: "https://codeforge-cloud-va.onrender.com", productionManifest: "GENERATED_BUILD_ARTIFACT", hiddenProviderCredentialInjection: false,
  initialCredentialCount: 0, journey: ["Launch separate fresh CodeForge source profile", "Normal CodeForge sign-in", "Settings → Free Capacity", "Connect OpenRouter Free", "Provider authorization", "Automatic entitlement verification and qualification"],
  completedSteps: ["Fresh source profile launched against the production endpoint", "Dedicated Free Capacity UI and OAuth handoff passed focused rendering/authority tests"],
  authorizationCompleted: false, codingCompleted: false, limitation: "User reported no eligible Free account. Normal human fresh-profile sign-in and provider authorization were not completed; no end-to-end onboarding claim." });
await save("CAPACITY-METRICS", { measurement: "R64 live public fixture; not global production capacity", admittedFreeDomains: 1, independentGroups: 1,
  healthyCodingGroupsObservedDuringRun: 1, liveCodingDomains: 1, successfulLiveFailovers: 0, paidFallbacksInLiveFixture: 0, byokFallbacksInLiveFixture: 0,
  falseWaits: null, falseWaitsReason: "Two-domain live continuity not exercised; deterministic coverage is reported separately.",
  providerBillTotal: "UNKNOWN", zeroBillingAuthority: "Kilo Free public policy + Fabric admission, not a fabricated billing measurement" });
console.log("R64 evidence snapshot written; blocked live proofs remain explicitly blocked.");
