import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateScale } from "../packages/forge-zero/dist/capacity-simulator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const observedAt = "2026-09-15T12:00:00.000Z";
const resetAt = "2026-09-16T00:00:00.000Z";
const window = (unit, limit, scope = "ORG", authoritative = true) => ({ unit, limit, remaining: limit, resetAt, scope, observedAt, authoritative });

const common = {
  capacityClass: "RECURRING_SHARED_FREE",
  capacityScope: "ORG",
  economicSource: "RETAIL_FREE",
  explicitZeroPrice: true,
  privacyClass: "standard",
  roles: ["explorer", "planner", "coder", "reviewer"],
  qualityScore: 75,
  healthy: true,
  enabled: true,
};

const routes = [
  { ...common, routeId: "groq-gpt-oss-120b", providerId: "groq", modelId: "openai/gpt-oss-120b", canonicalModelId: "openai/gpt-oss-120b", family: "gpt-oss", gateway: "direct", qualityScore: 84, windows: [window("requests", 1000), window("input_tokens", 200_000), window("output_tokens", 200_000)] },
  { ...common, routeId: "cloudflare-gpt-oss", providerId: "cloudflare", modelId: "@cf/openai/gpt-oss-120b", canonicalModelId: "openai/gpt-oss-120b", family: "gpt-oss", gateway: "workers-ai", capacityScope: "ACCOUNT", qualityScore: 72, windows: [window("requests", 300, "ACCOUNT"), window("neurons", 10_000, "ACCOUNT")] },
  // Account endpoint observed $10 credits and $0 usage. The official ≥$10 policy qualifies this
  // account for 1,000 daily :free requests; the remaining daily counter is not exposed by /key.
  { ...common, routeId: "openrouter-free-account", providerId: "openrouter", modelId: "nex-agi/nex-n2.5-pro:free", canonicalModelId: "nex-agi/nex-n2.5-pro", family: "nex", gateway: "openrouter", capacityScope: "ACCOUNT", qualityScore: 78, windows: [window("requests", 1000, "ACCOUNT")], },
  { ...common, routeId: "promo-boost", providerId: "promo", modelId: "promo-free", canonicalModelId: "promo-free", family: "promo", gateway: "promo", capacityClass: "PROMOTIONAL_FREE", economicSource: "PROMOTIONAL_FREE", capacityScope: "PROMO_ACCOUNT", qualityScore: 68, windows: [window("requests", 250, "PROMO_ACCOUNT")] },
  // Kilo's IP-scoped anonymous free route is catalogued but disabled until its current terms and
  // privacy class are independently qualified for CodeForge's default safety profile.
  { ...common, routeId: "kilo-anonymous-free", providerId: "kilo", modelId: "auto:free", canonicalModelId: "auto", family: "mixed", gateway: "kilo", capacityScope: "SOURCE_IP", economicSource: "USER_SCALED_FREE", enabled: false, qualityScore: 60, windows: [window("requests", 200, "SOURCE_IP")] },
];

const taskDemand = {
  taskKind: "normal-engineering-task",
  requests: 4,
  inputTokens: 1_500,
  outputTokens: 600,
  roleRequests: { explorer: 1, planner: 1, coder: 1, reviewer: 1 },
};

const scenarios = [];
for (const registeredUsers of [1, 10, 25, 50, 100, 200, 373, 500, 1000]) {
  scenarios.push({ id: `registered-${registeredUsers}`, registeredUsers, dailyActiveUsers: registeredUsers, newUsers: Math.min(registeredUsers, 1), tasksPerActiveUser: 1, taskDemand });
}
for (const dailyActiveUsers of [75, 150, 373]) {
  scenarios.push({ id: `registered-373-dau-${dailyActiveUsers}`, registeredUsers: 373, dailyActiveUsers, newUsers: Math.min(25, dailyActiveUsers), tasksPerActiveUser: 2, taskDemand });
}
scenarios.push(
  { id: "peak-new-user-reserve", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand },
  { id: "top-provider-outage", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand, failedProviders: ["openrouter"] },
  { id: "gateway-outage", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand, failedGateways: ["openrouter"] },
  { id: "promotion-ended", registeredUsers: 373, dailyActiveUsers: 75, newUsers: 25, tasksPerActiveUser: 2, taskDemand, endedPromotions: ["promo-boost"] },
  { id: "50-huge-vs-50-normal", registeredUsers: 100, dailyActiveUsers: 100, newUsers: 0, tasksPerActiveUser: 1, taskDemand, heavyUsers: 50, hugeTaskMultiplier: 8 },
);

const results = simulateScale({ routes, scenarios });
const report = {
  schema: "codeforge-r4-scale-v1",
  generatedAt: new Date().toISOString(),
  deterministic: true,
  fabricatedUsers: false,
  registeredUserScenarios: [1, 10, 25, 50, 100, 200, 373, 500, 1000],
  routeEvidence: {
    groq: "R3.5 dataset manifest / current provider research; account limits remain header-authoritative",
    cloudflare: "R3.5 dataset manifest / current Workers AI limits; neurons/day modeled",
    openrouter: "live GET /api/v1/credits observed total_credits=10,total_usage=0; official FAQ threshold qualifies 1,000 daily :free requests; daily counter not observable",
    kilo: "catalogued but disabled pending current terms/privacy qualification",
  },
  results,
};
const evidenceDir = path.join(root, "tests", "evidence", "r4-scale");
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "scale-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdown = [
  "# R4 deterministic scale simulation",
  "",
  `Generated at ${report.generatedAt}. This is a model-based capacity proof, not fabricated early-access telemetry.`,
  "",
  "| Scenario | Demand | Counted capacity | First-run success | Normal success | Blocks | p95 wait (min) |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...results.map((result) => `| ${result.scenarioId} | ${result.demand.totalTasks} | ${result.capacity.totalTasks} | ${(result.outcomes.firstRunSuccessRate * 100).toFixed(1)}% | ${(result.outcomes.normalSuccessRate * 100).toFixed(1)}% | ${result.outcomes.capacityBlocks} | ${result.outcomes.p95WaitMinutes} |`),
  "",
  "OpenRouter's account credit balance was read successfully, but its API does not expose the remaining daily `:free` counter. The 1,000-request/day route is therefore modeled from the official ≥$10 policy and must remain header-observed at runtime.",
  "",
  "Paid routes are absent from the eligible fleet. Kilo's IP-scoped route is retained as disabled research input until its current terms and privacy treatment are qualified.",
  "",
].join("\n");
fs.writeFileSync(path.join(root, "docs", "r4-scale-report.md"), markdown, "utf8");
console.log(JSON.stringify({ output: path.relative(root, path.join(evidenceDir, "scale-report.json")), scenarios: results.length, blockedScenarios: results.filter((result) => result.outcomes.capacityBlocks > 0).map((result) => result.scenarioId) }, null, 2));
