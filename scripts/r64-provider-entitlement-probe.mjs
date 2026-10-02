import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const providers = {
  openrouter: ["OPENROUTER_API_KEY"], groq: ["GROQ_API_KEY"], google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  sambanova: ["SAMBANOVA_API_KEY"], mistral: ["MISTRAL_API_KEY"], cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"], opencode: ["OPENCODE_API_KEY"],
  "github-models": ["GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"], nvidia: ["NVIDIA_API_KEY"],
};
const report = {
  generatedAt: new Date().toISOString(), inferenceCalls: 0,
  credentials: Object.fromEntries(Object.entries(providers).map(([provider, variables]) => [provider, { present: variables.some((name) => Boolean(process.env[name]?.trim())), classification: "UNVERIFIED" }])),
  openrouterCurrentKey: { status: "CREDENTIAL_ABSENT", classification: "UNKNOWN", admission: "DENIED", measurement: "READ_ONLY_GET_CURRENT_KEY_NO_INFERENCE" },
  cloudflareSubscriptions: { status: "CREDENTIAL_OR_ACCOUNT_ABSENT", classification: "UNKNOWN", admission: "DENIED", measurement: "READ_ONLY_GET_ACCOUNT_SUBSCRIPTIONS_NO_INFERENCE" },
};
const key = process.env.OPENROUTER_API_KEY?.trim();
if (key) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    report.openrouterCurrentKey.httpStatus = response.status;
    report.openrouterCurrentKey.status = response.ok ? "READ_SUCCEEDED" : "AUTHENTICATION_OR_UPSTREAM_FAILED";
    if (response.ok) {
      const payload = await response.json();
      const data = payload?.data;
      report.openrouterCurrentKey.metadata = {
        isFreeTier: typeof data?.is_free_tier === "boolean" ? data.is_free_tier : null,
        limit: typeof data?.limit === "number" ? data.limit : null,
        limitRemaining: typeof data?.limit_remaining === "number" ? data.limit_remaining : null,
        expiresAt: typeof data?.expires_at === "string" ? data.expires_at : null,
      };
      report.openrouterCurrentKey.classification = data?.is_free_tier === false ? "PAID" : data?.is_free_tier === true ? "FREE_TIER_METADATA_ONLY" : "UNKNOWN";
    }
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    report.openrouterCurrentKey.status = error instanceof Error && error.name === "TimeoutError" ? "READ_TIMEOUT" : "READ_UNAVAILABLE";
  }
}
report.openrouterCurrentKey.reason = "Environment credentials are not user-delegated Packaged Free grants; account ownership and independent entitlement must be verified separately.";
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_KEY?.trim();
const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
if (cloudflareToken && cloudflareAccount && /^[a-f0-9]{32}$/i.test(cloudflareAccount)) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/subscriptions`, {
      headers: { Authorization: `Bearer ${cloudflareToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    report.cloudflareSubscriptions.httpStatus = response.status;
    report.cloudflareSubscriptions.status = response.ok ? "READ_SUCCEEDED" : "AUTHENTICATION_OR_PERMISSION_FAILED";
    if (response.ok) {
      const payload = await response.json();
      report.cloudflareSubscriptions.accountIdentityHash = createHash("sha256").update(JSON.stringify(["cloudflare-workers-ai", "ACCOUNT", cloudflareAccount])).digest("hex");
      report.cloudflareSubscriptions.plans = Array.isArray(payload?.result) ? payload.result.map((subscription) => ({
        ratePlanId: /^[A-Za-z0-9_.-]{1,128}$/.test(subscription?.rate_plan?.id ?? "") ? subscription.rate_plan.id : "UNKNOWN",
        state: ["Trial", "Provisioned", "Paid", "AwaitingPayment", "Cancelled", "Failed", "Expired"].includes(subscription?.state) ? subscription.state : "UNKNOWN",
      })) : [];
    }
  } catch (error) {
    report.cloudflareSubscriptions.status = error instanceof Error && error.name === "TimeoutError" ? "READ_TIMEOUT" : "READ_UNAVAILABLE";
  }
}
report.cloudflareSubscriptions.reason = "Only a verified Workers Free account with provider-enforced hard stop may qualify; missing/empty subscription data does not prove Free status.";
const path = new URL("../docs/evidence/free-capacity-fabric/R64-PROVIDER-ENTITLEMENT-PROBE.json", import.meta.url);
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
