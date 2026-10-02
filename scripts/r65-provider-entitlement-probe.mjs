import { writeFile } from "node:fs/promises";

const report = { generatedAt: new Date().toISOString(), inferenceCalls: 0, measurement: "READ_ONLY_PROVIDER_METADATA", providers: {} };
const read = async (url, key) => {
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch { return { status: "UNAVAILABLE" }; }
};
const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
const openRouter = openRouterKey ? await read("https://openrouter.ai/api/v1/key", openRouterKey) : { status: "CREDENTIAL_ABSENT" };
const current = openRouter.body?.data;
report.providers.openrouter = { implementation: "OAuth PKCE and owner/key-bound entitlement receipt; policy and exact-zero model discovery required", httpStatus: openRouter.status,
  accountClass: current?.is_free_tier === false ? "PAID" : "UNKNOWN", admission: "DENIED", credentialSource: "ENVIRONMENT",
  metadata: { isFreeTier: typeof current?.is_free_tier === "boolean" ? current.is_free_tier : null, providerOwnerPresent: typeof current?.creator_user_id === "string", personalAccount: current?.organization_id === null,
    freeRequests: current?.free_model_daily_requests ? { limit: current.free_model_daily_requests.limit, used: current.free_model_daily_requests.used, remaining: current.free_model_daily_requests.remaining } : null },
  blocker: "User-delegated eligible Free account required; environment credential is not a user grant", privacy: "Consent and upstream policy dependent; private-code admission remains separately gated",
  sources: ["https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key", "https://openrouter.ai/docs/guides/overview/auth/oauth", "https://openrouter.ai/docs/api_reference/limits"] };
const cloudflareKey = process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_KEY?.trim();
const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const cloudflareReads = [];
if (cloudflareKey && /^[a-f0-9]{32}$/i.test(account ?? "")) {
  for (const suffix of ["", "/subscriptions", "/entitlements", "/workers/account-settings"]) {
    const result = await read(`https://api.cloudflare.com/client/v4/accounts/${account}${suffix}`, cloudflareKey);
    cloudflareReads.push({ endpoint: `/accounts/<redacted>${suffix}`, httpStatus: result.status, success: result.body?.success === true,
      errorCodes: Array.isArray(result.body?.errors) ? result.body.errors.map((error) => error.code).filter((code) => Number.isInteger(code)) : [] });
  }
}
report.providers["cloudflare-workers-ai"] = { implementation: "Encrypted account credential path and neuron budget guard; entitlement admission remains unavailable", accountClass: "UNKNOWN", admission: "DENIED", reads: cloudflareReads,
  blocker: "Available token lacks access to account/billing evidence. Subscriptions require Billing Read; account entitlements require Account Read. Missing or empty subscription data cannot prove Workers Free.",
  billing: "Workers Free has a provider-enforced daily hard stop; Workers Paid and AI Gateway credits can incur charges. Local budget estimation alone cannot prove no paid spillover.",
  privacy: "Private-code compatible only after actual admission verification",
  sources: ["https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/", "https://developers.cloudflare.com/api/resources/accounts/subresources/entitlements/methods/list/", "https://developers.cloudflare.com/workers-ai/platform/pricing/"] };
for (const [provider, keyName, url] of [["groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1/models"], ["cerebras", "CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/models"]]) {
  const result = process.env[keyName]?.trim() ? await read(url, process.env[keyName].trim()) : { status: "CREDENTIAL_ABSENT" };
  report.providers[provider] = { implementation: "Encrypted user credential connection and model discovery", modelReadStatus: result.status, modelCount: Array.isArray(result.body?.data) ? result.body.data.length : null,
    accountClass: "UNKNOWN", ...(provider === "cerebras" ? { publicFreeOfferClass: "PROMOTIONAL" } : {}), admission: "DENIED",
    blocker: provider === "cerebras" ? "Provider explicitly offers only time/credit-bounded Free Trial; no recurring permanent Free tier" : "Public API catalog proves model access only. No supported authoritative owner/billing-tier endpoint found; rate-limit headers cannot prove Free billing tier.",
    privacy: provider === "cerebras" ? "UNKNOWN" : "Organization/data-control verification required",
    sources: provider === "cerebras" ? ["https://inference-docs.cerebras.ai/support/rate-limits"] : ["https://console.groq.com/docs/api-reference", "https://console.groq.com/docs/rate-limits", "https://console.groq.com/docs/billing-faqs"] };
}
report.providers.puter = { implementation: "Browser user sign-in available; aggregate allowance is insufficient", accountClass: "UNKNOWN", admission: "DENIED", privacy: "UNKNOWN",
  blocker: "Documented MonthlyUsage allowanceInfo exposes monthUsageAllowance and remaining, without Free/purchased buckets or a Free-only spending selector; no inference performed",
  sources: ["https://docs.puter.com/Objects/monthlyusage/"] };
report.humanAction = "Open CodeForge → Settings → Free Capacity → Connect OpenRouter Free → authorize a genuine personal Free account in the browser";
report.afterAuthorization = "Verify current-key owner, tier, quota and policy; bind receipt to local user and credential; encrypt credential; discover exact-zero routes; qualify eligible models; admit only on passing ForgeZero policy";
const destination = new URL("../docs/evidence/free-capacity-fabric/R65-PROVIDER-VERIFIERS.json", import.meta.url);
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ destination: destination.pathname, inferenceCalls: report.inferenceCalls, classifications: Object.fromEntries(Object.entries(report.providers).map(([provider, evidence]) => [provider, evidence.accountClass])) }));
