// Paired live replay of R40's bounded-reasoning starvation shape.
// Two requests maximum, one identical task; only a catalog-proven $0 route is allowed.
import { readFile, writeFile } from "node:fs/promises";
import { createOpenRouterAdapter } from "../packages/providers/dist/index.js";
import { roleOutputBudget } from "../packages/server/dist/role-output-budget.js";

const out = process.argv[2] ?? "docs/evidence/r41-role-intelligence/R41-REASONING-BUDGET.json";
const inventory = JSON.parse(await readFile("docs/evidence/r41-role-intelligence/R41-LIVE-PREFLIGHT.json", "utf8"));
const provider = inventory.providers.find((p) => p.provider === "openrouter" && p.httpStatus === 200);
const model = "cohere/north-mini-code:free";
const route = provider?.models?.find((m) => m.id === model);
if (!route || Number(route.pricing?.prompt) !== 0 || Number(route.pricing?.completion) !== 0 || !model.endsWith(":free")) {
  throw new Error("Fail closed: exact route has not been live catalog-verified at $0 for both token directions.");
}

const messages = [
  { role: "system", content: "You are a software change reviewer. Reply with one JSON object only: {\"verdict\":\"approve\"|\"reject\",\"finding\":string}. Reject a security defect and identify the behavior that permits it." },
  { role: "user", content: "Intent: authorize(role) must allow only admin, denying guest and unknown roles. Review this diff:\n-export function authorize(role) { return role === 'admin'; }\n+export function authorize(role) { return role === 'admin' || role === 'guest'; }\nVerdict and actionable finding?" },
];
const requestBudget = roleOutputBudget({ role: "reviewer", providerId: "openrouter", modelId: model }).maxTokens;
if (requestBudget !== 2048) throw new Error("Production reviewer profile changed: stop rather than silently change experiment.");

const adapter = createOpenRouterAdapter({ timeoutMs: 45_000 });
const result = { at: new Date().toISOString(), route: { providerId: "openrouter", modelId: model, catalogAt: inventory.at, priceUsdPerToken: { input: 0, output: 0 } }, task: "review-guest-authorization-defect", maxRequests: 2, cases: [] };
for (const [label, maxTokens] of [["old-cap", 500], ["r41-profile", requestBudget]]) {
  const start = Date.now();
  const observed = { label, maxTokens, inputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, visibleChars: 0, finishReason: null, usable: false, correct: false, errorCode: null, latencyMs: null };
  let text = "";
  try {
    for await (const event of adapter.streamChat({ model, messages, temperature: 0, maxTokens })) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "usage") {
        observed.inputTokens = event.usage.inputTokens;
        observed.outputTokens = event.usage.outputTokens;
        observed.reasoningTokens = event.usage.reasoningTokens ?? null;
        observed.costUsd = event.usage.costUsd ?? null;
      }
      if (event.type === "finish") observed.finishReason = event.finishReason;
      if (event.type === "error") {
        observed.errorCode = event.code;
        break;
      }
    }
    const object = text.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = object ? JSON.parse(object[0]) : null; } catch { parsed = null; }
    observed.visibleChars = text.length;
    observed.usable = !!parsed && ["approve", "reject"].includes(parsed.verdict) && typeof parsed.finding === "string";
    observed.correct = observed.usable && parsed.verdict === "reject" && /\bguest\b/i.test(parsed.finding);
  } catch (error) {
    observed.errorCode = error?.code ?? error?.name ?? "UNKNOWN";
  }
  observed.latencyMs = Date.now() - start;
  result.cases.push(observed);
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  // If free status or account posture changes mid-pair, do not retry or switch to a paid route.
  if (observed.costUsd !== null && observed.costUsd > 0) throw new Error("Unexpected positive cost; stop all live requests.");
  if (observed.errorCode !== null) break;
}
console.log(JSON.stringify({ route: model, cases: result.cases.map(({ label, maxTokens, reasoningTokens, outputTokens, visibleChars, finishReason, correct, errorCode }) => ({ label, maxTokens, reasoningTokens, outputTokens, visibleChars, finishReason, correct, errorCode })) }));
