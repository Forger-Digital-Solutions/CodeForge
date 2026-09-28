import { readFile, writeFile } from "node:fs/promises";
import { createProviderAdapterById, createOpenRouterAdapter } from "@codeforge/providers";

const root = "docs/evidence/r53-role-intelligence";
const inventory = JSON.parse(await readFile(`${root}/R53-FREE-ROUTE-INVENTORY.json`, "utf8"));
const cases = [
  { id: "A-correct", intent: "Round a finite number to the nearest integer.", diff: "--- a/src/rounding.ts\n+++ b/src/rounding.ts\n@@\n- return Math.floor(value);\n+ return Math.round(value);", approve: true },
  { id: "B-obvious", intent: "Fix add(a,b) to return the sum.", diff: "--- a/src/arithmetic.ts\n+++ b/src/arithmetic.ts\n@@\n- return 0;\n+ return a - b;", approve: false, markers: ["subtract", "minus", "a - b", "sum"] },
  { id: "C-semantic", intent: "Return the median for both odd and even sorted arrays.", diff: "--- a/src/median.ts\n+++ b/src/median.ts\n@@\n  const mid = Math.floor(values.length / 2);\n  if (values.length % 2) return values[mid];\n- return values[mid];\n+ return (values[mid] + values[mid + 1]) / 2;", approve: false, markers: ["mid - 1", "mid+1", "out of bounds", "undefined", "even"] },
  { id: "D-requirement", intent: "Apply a 10% fee to signed balances; negative balances must retain their sign. Existing tests cover positive balances only.", diff: "--- a/src/fee.ts\n+++ b/src/fee.ts\n@@\n- return balance;\n+ return Math.abs(balance) * 1.1;", approve: false, markers: ["negative", "sign", "abs"] },
  { id: "E-noise", intent: "Fix a display typo in the welcome label. Keep audit logging enabled.", diff: "--- a/src/labels.ts\n+++ b/src/labels.ts\n@@\n- export const welcome = 'Welcom';\n+ export const welcome = 'Welcome';\n--- a/src/audit.ts\n+++ b/src/audit.ts\n@@\n- export const auditEnabled = true;\n+ export const auditEnabled = false;", approve: false, markers: ["audit", "unrelated", "logging"] },
  { id: "F-integration", intent: "Rename the public total helper while preserving callers.", diff: "--- a/src/total.ts\n+++ b/src/total.ts\n@@\n- export function total(items) { return items.reduce((n,x) => n+x, 0); }\n+ export function calculateTotal(items) { return items.reduce((n,x) => n+x, 0); }\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@\n import { total } from './total.js';\n export const checkout = (items) => total(items);", approve: false, markers: ["import", "total", "checkout"] },
  { id: "G-clean-variant", intent: "Ensure the formatter includes exactly two decimal places for finite values.", diff: "--- a/lib/money-format.ts\n+++ b/lib/money-format.ts\n@@\n- return value.toFixed(0);\n+ return value.toFixed(2);", approve: true },
];

const selected = [
  ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
  ["groq", "openai/gpt-oss-20b"],
  ["mistral", "codestral-2508"],
];
const adapters = new Map();
const rows = [];
for (const [providerId, modelId] of selected) {
  const route = inventory.routes.find((item) => item.providerId === providerId && item.modelId === modelId && item.pool.startsWith("managed:") && item.eligible && item.enabled && item.explicitZeroPrice && item.paidFallbackDisabled && item.capacityState === "CAPACITY_MEASURED");
  if (!route) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_MEASURED_FREE_ROUTE" });
    continue;
  }
  const adapter = adapters.get(providerId) ?? (providerId === "openrouter" ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" }) : createProviderAdapterById(providerId));
  if (!adapter?.streamChat) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_ADAPTER" });
    continue;
  }
  adapters.set(providerId, adapter);
  const results = [];
  for (const benchmarkCase of cases) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let text = "";
    let inputTokens = null;
    let outputTokens = null;
    let failure = null;
    try {
      for await (const event of adapter.streamChat({
        model: modelId,
        messages: [
          { role: "system", content: 'Review the patch against the stated intent. Return exactly one JSON object: {"verdict":"approve"|"reject","findings":[{"message":"specific reason"}]}. Approve valid patches promptly; identify a real defect when rejecting.' },
          { role: "user", content: `Intent: ${benchmarkCase.intent}\n\nPatch:\n${benchmarkCase.diff}` },
        ],
        temperature: 0,
        maxTokens: 1200,
      }, controller.signal)) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "usage") {
          inputTokens = event.usage.inputTokens ?? null;
          outputTokens = event.usage.outputTokens ?? null;
        }
        if (event.type === "error") failure = event.message;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
    let answer = null;
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) answer = JSON.parse(text.slice(start, end + 1));
    } catch { /* malformed answer is a measured benchmark result */ }
    const schemaValid = (answer?.verdict === "approve" || answer?.verdict === "reject") && Array.isArray(answer?.findings);
    const verdictCorrect = schemaValid && (answer.verdict === "approve") === benchmarkCase.approve;
    const findingText = schemaValid ? answer.findings.map((finding) => String(finding.message ?? "")).join(" ").toLowerCase() : "";
    const localized = benchmarkCase.approve || benchmarkCase.markers.some((marker) => findingText.includes(marker));
    results.push({
      caseId: benchmarkCase.id,
      expected: benchmarkCase.approve ? "approve" : "reject",
      verdict: schemaValid ? answer.verdict : null,
      schemaValid: Boolean(schemaValid),
      verdictCorrect: Boolean(verdictCorrect),
      localized: Boolean(localized),
      passed: Boolean(verdictCorrect && localized && !failure),
      converged: Boolean(schemaValid && !failure),
      requests: 1,
      toolCalls: 0,
      inputTokens,
      outputTokens,
      wallTimeMs: Date.now() - started,
      failure: failure?.slice(0, 180) ?? null,
    });
  }
  rows.push({ providerId, modelId, status: "EXECUTED", qualificationBefore: route.roles.REVIEWER, cases: results, passed: results.filter((result) => result.passed).length, verdictCorrect: results.filter((result) => result.verdictCorrect).length, nonConverged: results.filter((result) => !result.converged).length });
  console.log(`${providerId}/${modelId}: ${rows.at(-1).passed}/${cases.length} cases`);
}
await writeFile(`${root}/R53-REVIEWER-BENCHMARK.json`, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), sourceInventory: inventory.generatedAt, cases: cases.map(({ id, approve }) => ({ id, expected: approve ? "approve" : "reject" })), rows, paidSpendUsd: 0, caveat: "Direct single-turn patch review probes; no repository tools or autonomous runtime. These scores alone do not change production receipts." }, null, 2)}\n`);
