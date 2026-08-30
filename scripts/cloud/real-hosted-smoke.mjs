// CodeForge Cloud — REAL hosted-inference smoke (credential-gated, zero owner cash).
//
// Proves the full server path end-to-end against REAL provider endpoints:
//   real provider discovery → ForgeZero free verification → Auto routing → real remote inference
//   → SSE streaming → credit reservation + settlement.
//
// SAFETY: only $0-safe capacity is ever used. ForgeZero admits a model to the free pool only when it
// is verified free (OpenRouter $0 ":free" routes / provider free allowances). Paid-only providers
// (OpenAI) are structurally skipped. GitHub OAuth is the ONLY mocked piece (no staging OAuth app);
// provider inference uses the real network. Prints no secrets.
//
//   node scripts/cloud/real-hosted-smoke.mjs
//
// Exits 0 on success, 3 when no free-safe provider credential is present (SKIP, not a failure).

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CodeForgeCloudServer } from "../../apps/cloud-api/dist/index.js";
import { CloudFirewallManager, CloudProviderRegistry, resolveCloudProviderCredentials } from "@codeforge/cloud-gateway";

function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const { store, providerIds } = resolveCloudProviderCredentials(process.env);
// Free-safe providers only (never OpenAI/Anthropic paid-only).
const freeSafe = providerIds.filter((p) => !["openai", "anthropic"].includes(p));
if (freeSafe.length === 0) {
  console.log("SKIP: no free-safe provider credential present (OPENROUTER_API_KEY / GROQ_API_KEY / …).");
  process.exit(3);
}
console.log(`[smoke] free-safe providers configured: ${freeSafe.join(", ")}`);

const mockGitHubFetch = async (url) => {
  const s = url.toString();
  if (s.includes("login/oauth/access_token"))
    return new Response(JSON.stringify({ access_token: "gho_smoke", token_type: "bearer", scope: "read:user user:email" }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (s.includes("api.github.com/user"))
    return new Response(JSON.stringify({ id: 42, login: "smoke_user", name: "Smoke User", email: "smoke@example.com" }), { status: 200, headers: { "Content-Type": "application/json" } });
  return new Response("Not found", { status: 404 });
};

const firewallManager = new CloudFirewallManager();
const providerRegistry = new CloudProviderRegistry({ firewallManager, credentialStore: store, providerIds: freeSafe });

const server = new CodeForgeCloudServer({
  jwtSecret: "smoke-jwt-secret-key-32-characters-min",
  fetchFn: mockGitHubFetch,
  firewallManager,
  providerRegistry,
  stripeConfig: { secretKey: "sk_test_smoke", webhookSecret: "whsec_smoke", proPriceId: "price_pro", creditPackPriceId: "price_credits" },
});

const port = await server.start(0);
const base = `http://127.0.0.1:${port}`;
let exitCode = 0;
try {
  const reports = providerRegistry.getReports();
  for (const r of reports) console.log(`[smoke] ${r.providerId}: ${r.status} (${r.verifiedFreeCount} verified-free)`);
  const eligible = firewallManager.firewall.eligibleModels();
  console.log(`[smoke] ForgeZero eligible free models: ${eligible.length}`);
  if (eligible.length === 0) throw new Error("No verified-free models discovered from real providers");

  // Sign in (GitHub mocked) — no provider account or key from the user.
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const redirectUri = "http://127.0.0.1:8765/auth/callback";

  const startRes = await fetch(`${base}/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirectUri, codeChallenge }),
  });
  const start = await startRes.json();

  const cbRes = await fetch(`${base}/v1/auth/github/callback?code=mock_gh_code&state=${encodeURIComponent(start.state)}`, {
    redirect: "manual",
  });
  const loc = cbRes.headers.get("location");
  if (!loc) throw new Error("OAuth callback did not return a redirect");
  const desktopCode = new URL(loc).searchParams.get("code");
  if (!desktopCode) throw new Error("OAuth callback redirect missing desktop authorization code");

  const exchangeRes = await fetch(`${base}/v1/auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: desktopCode, codeVerifier, state: start.state, redirectUri }),
  });
  const tokens = await exchangeRes.json();
  if (!tokens.accessToken) throw new Error(`OAuth exchange failed: ${JSON.stringify(tokens)}`);
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };

  const before = await (await fetch(`${base}/v1/usage`, { headers: auth })).json();

  console.log("[smoke] sending Auto hosted inference (harmless prompt)…");
  const res = await fetch(`${base}/v1/hosted/inference`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), messages: [{ role: "user", content: "Reply with exactly: CODEFORGE_HOSTED_SMOKE_OK" }], modelId: "auto", taskType: "coding" }),
  });
  const sse = await res.text();

  let provider = "?", model = "?", text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === "assistant.message.started") { provider = ev.provider; model = ev.model; }
    if (ev.type === "assistant.message.delta") text += ev.delta;
    if (ev.type === "turn.failed") throw new Error(`Inference failed: ${ev.error}`);
  }
  if (!sse.includes("turn.completed")) throw new Error("No turn.completed event — inference did not settle");

  const after = await (await fetch(`${base}/v1/usage`, { headers: auth })).json();
  const delta = before.creditBalance - after.creditBalance;

  console.log("\n===== REAL HOSTED INFERENCE SMOKE — PASS =====");
  console.log(`provider/model : ${provider} :: ${model}`);
  console.log(`response (head): ${JSON.stringify(text.slice(0, 120))}`);
  console.log(`credit balance : ${before.creditBalance} → ${after.creditBalance} (delta ${delta})`);
  console.log(`usage events   : ${after.recentEvents.length}`);
  console.log("owner cash     : $0 (free-safe route only)");
} catch (e) {
  exitCode = 1;
  console.error("\n===== REAL HOSTED INFERENCE SMOKE — FAIL =====");
  console.error(String(e && e.message ? e.message : e));
} finally {
  await server.stop();
  process.exit(exitCode);
}
