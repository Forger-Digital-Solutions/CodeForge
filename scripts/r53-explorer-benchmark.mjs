import { readFile, writeFile } from "node:fs/promises";
import { createProviderAdapterById, createOpenRouterAdapter } from "@codeforge/providers";

const root = "docs/evidence/r53-role-intelligence";
const inventory = JSON.parse(await readFile(`${root}/R53-FREE-ROUTE-INVENTORY.json`, "utf8"));
const cases = [
  {
    id: "simple-bug",
    task: "Find the implementation and test for formatting a negative balance incorrectly.",
    files: ["src/money/format.ts — formats signed balances", "src/money/parse.ts — parses currency input", "test/money/format.test.ts — formatter cases", "src/ui/header.ts — page heading"],
    expected: ["src/money/format.ts", "test/money/format.test.ts"],
  },
  {
    id: "cross-package",
    task: "A CLI timeout setting is ignored by the server request. Locate the handoff and its contract test.",
    files: ["packages/cli/src/options.ts — parses timeout", "packages/server/src/request.ts — receives client options", "packages/providers/src/retry.ts — provider backoff", "tests/client-timeout.test.ts — CLI/server timeout contract", "apps/docs/src/timeout.md — user guide"],
    expected: ["packages/cli/src/options.ts", "packages/server/src/request.ts", "tests/client-timeout.test.ts"],
  },
  {
    id: "unfamiliar-feature",
    task: "Add a public checkout total that composes cart subtotal and coupon policy; find the implementation and test entry points.",
    files: ["src/cart.mjs — item subtotal", "src/coupons.mjs — coupon policy", "src/index.mjs — public exports", "test/checkout.test.mjs — desired checkout behavior", "src/analytics.mjs — page views"],
    expected: ["src/cart.mjs", "src/coupons.mjs", "src/index.mjs", "test/checkout.test.mjs"],
  },
  {
    id: "large-repo",
    task: "Find why a model with an unmeasured quota is reported exhausted and identify its routing regression test.",
    files: ["packages/forge-zero/src/quota.ts — quota window states", "packages/eight-bit/src/free-fabric.ts — admission decisions", "packages/model-registry/src/catalog.ts — model names", "packages/server/src/desktop-bridge.ts — UI stream", "packages/forge-zero/test/quota.test.ts — quota states", "packages/eight-bit/test/free-fabric.test.ts — routing decisions", "apps/docs/src/model-list.md — model list", "scripts/clean.mjs — cleanup"],
    expected: ["packages/forge-zero/src/quota.ts", "packages/eight-bit/src/free-fabric.ts", "packages/eight-bit/test/free-fabric.test.ts"],
  },
  {
    id: "symbol-rename",
    task: "Rename `calculateSubtotal` to `subtotalCents` while preserving the public API and all callers. Find definitions, exports, callers, and tests.",
    files: ["src/cart.ts — defines calculateSubtotal", "src/index.ts — re-exports calculateSubtotal", "src/checkout.ts — imports calculateSubtotal", "test/cart.test.ts — exercises calculateSubtotal", "src/coupon.ts — discount percentage"],
    expected: ["src/cart.ts", "src/index.ts", "src/checkout.ts", "test/cart.test.ts"],
  },
  {
    id: "hidden-adapter",
    task: "A provider's tool call ID is lost when events cross the adapter. Find the provider decoder, shared event type, runtime consumer, and contract test.",
    files: ["packages/providers/src/openrouter.ts — decodes upstream tool events", "packages/providers/src/types.ts — StreamEvent contract", "packages/server/src/agent-runtime.ts — consumes tool calls", "packages/providers/test/openrouter-contract.test.ts — tool event assertions", "packages/server/src/http.ts — HTTP routes", "packages/providers/src/pricing.ts — price metadata"],
    expected: ["packages/providers/src/openrouter.ts", "packages/providers/src/types.ts", "packages/server/src/agent-runtime.ts", "packages/providers/test/openrouter-contract.test.ts"],
  },
];

const selected = [
  ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
  ["groq", "openai/gpt-oss-20b"],
  ["mistral", "codestral-2508"],
];
const rows = [];
for (const [providerId, modelId] of selected) {
  const route = inventory.routes.find((item) => item.providerId === providerId && item.modelId === modelId && item.pool.startsWith("managed:") && item.eligible && item.enabled && item.explicitZeroPrice && item.paidFallbackDisabled && item.capacityState === "CAPACITY_MEASURED");
  if (!route) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_MEASURED_FREE_ROUTE" });
    continue;
  }
  const adapter = providerId === "openrouter" ? createOpenRouterAdapter({ baseUrl: "https://openrouter.ai/api/v1" }) : createProviderAdapterById(providerId);
  if (!adapter?.streamChat) {
    rows.push({ providerId, modelId, status: "SKIPPED_NO_ADAPTER" });
    continue;
  }
  const results = [];
  for (const benchmarkCase of cases) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response = "";
    let inputTokens = null;
    let outputTokens = null;
    let failure = null;
    try {
      for await (const event of adapter.streamChat({
        model: modelId,
        messages: [
          { role: "system", content: 'You are a read-only repository explorer. Return exactly one JSON object: {"files":["path"]}. Select the smallest set of existing files needed to investigate the task, including relevant tests. Do not invent paths.' },
          { role: "user", content: `Task: ${benchmarkCase.task}\n\nRepository file index:\n${benchmarkCase.files.join("\n")}` },
        ],
        temperature: 0,
        maxTokens: 700,
      }, controller.signal)) {
        if (event.type === "text_delta") response += event.delta;
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
      const start = response.indexOf("{");
      const end = response.lastIndexOf("}");
      if (start >= 0 && end > start) answer = JSON.parse(response.slice(start, end + 1));
    } catch { /* malformed answer is evidence */ }
    const selectedFiles = Array.isArray(answer?.files) && answer.files.every((file) => typeof file === "string") ? [...new Set(answer.files)] : [];
    const available = benchmarkCase.files.map((entry) => entry.split(" — ")[0]);
    const relevant = selectedFiles.filter((file) => benchmarkCase.expected.includes(file));
    const invented = selectedFiles.filter((file) => !available.includes(file));
    const irrelevant = selectedFiles.filter((file) => available.includes(file) && !benchmarkCase.expected.includes(file));
    results.push({
      caseId: benchmarkCase.id,
      expected: benchmarkCase.expected,
      selected: selectedFiles,
      relevant,
      invented,
      irrelevant,
      recall: relevant.length / benchmarkCase.expected.length,
      precision: selectedFiles.length ? relevant.length / selectedFiles.length : 0,
      passed: !failure && relevant.length === benchmarkCase.expected.length && invented.length === 0 && irrelevant.length === 0,
      requests: 1,
      toolCalls: 0,
      inputTokens,
      outputTokens,
      wallTimeMs: Date.now() - started,
      failure: failure ? (/\b429\b|rate.?limit|quota/i.test(failure) ? "RATE_LIMITED_429" : "PROVIDER_ERROR") : null,
    });
    if (failure) break;
  }
  rows.push({ providerId, modelId, status: results.length === cases.length ? "EXECUTED" : "INCONCLUSIVE_PROVIDER", qualificationBefore: route.roles.EXPLORER, cases: results, passed: results.filter((result) => result.passed).length });
  console.log(`${providerId}/${modelId}: ${rows.at(-1).passed}/${results.length} completed cases`);
}
await writeFile(`${root}/R53-EXPLORER-BENCHMARK.json`, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), sourceInventory: inventory.generatedAt, cases: cases.map(({ id, expected }) => ({ id, expected })), rows, paidSpendUsd: 0, caveat: "Single-turn file-index discovery probes. No repository tools or autonomous navigation; results alone do not change qualification receipts." }, null, 2)}\n`);
