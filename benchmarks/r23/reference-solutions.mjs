/**
 * Reference solutions for the R23 corpus, expressed as declarative steps so they serve two
 * purposes: (1) `validate-tasks.mjs` applies them to prove every hidden verifier is satisfiable;
 * (2) the bench runner's `--dry-run` mode replays them as a scripted model trace through the real
 * runtime/orchestrator to exercise the full pipeline on every task at $0.
 *
 * Steps: { kind: "edit", path, from, to } | { kind: "write", path, content }.
 * The reference is one correct minimal change — never the only acceptable one.
 */

const VALIDATOR_MODULE = "import type { OrderInput } from \"../types.ts\";\n\nexport type ValidationResult = { ok: true } | { ok: false; errors: string[] };\n\nexport function validateOrder(input: OrderInput): ValidationResult {\n  const errors: string[] = [];\n  if (!input.customerId || input.customerId.trim() === \"\") errors.push(\"customerId is required\");\n  if (!Array.isArray(input.lines) || input.lines.length === 0) errors.push(\"at least one line is required\");\n  for (const [index, line] of (input.lines ?? []).entries()) {\n    if (!line.sku) errors.push(`lines[${index}].sku is required`);\n    if (!Number.isInteger(line.quantity) || line.quantity <= 0) errors.push(`lines[${index}].quantity must be a positive integer`);\n  }\n  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) errors.push(\"currency must be a 3-letter code\");\n  return errors.length === 0 ? { ok: true } : { ok: false, errors };\n}\n";

const handler = (name, signature, body) => `import type { HandlerResult, OrderInput } from "../types.ts";\nimport { validateOrder } from "../validation/order.ts";\n\nexport function ${name}(${signature}): HandlerResult {\n  const validation = validateOrder(input);\n  if (!validation.ok) return { status: 400, body: { errors: validation.errors } };\n${body}}\n`;

export const REFERENCE_STEPS = {
  "qual-js-return-sign": [{ kind: "edit", path: "src/math.js", from: "return a - b;", to: "return a + b;" }],
  "qual-js-off-by-one": [{ kind: "edit", path: "src/list.js", from: "return items[items.length];", to: "return items[items.length - 1];" }],
  "qual-js-missing-export": [{ kind: "edit", path: "src/index.js", from: "export { trimAll } from \"./strings.js\";", to: "export { trimAll, capitalize } from \"./strings.js\";" }],
  "js-small-fix-clamp": [{ kind: "edit", path: "src/clamp.js", from: "if (value > min) return min;", to: "if (value < min) return min;" }],
  "ts-small-fix-slugify": [{ kind: "edit", path: "src/slugify.ts", from: "return input.replace(/[^A-Za-z0-9]+/g, \"-\");", to: "return input.toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");" }],
  "py-small-fix-median": [{ kind: "edit", path: "stats/core.py", from: "    return ordered[len(ordered) // 2]\n", to: "    mid = len(ordered) // 2\n    if len(ordered) % 2 == 1:\n        return ordered[mid]\n    return (ordered[mid - 1] + ordered[mid]) / 2\n" }],
  "js-bug-fix-cart-total": [{ kind: "edit", path: "src/pricing/discounts.js", from: "return percent / 100;", to: "return 1 - percent / 100;" }],
  "ts-bug-fix-queue-order": [{ kind: "edit", path: "src/queue/task-queue.ts", from: "    await Promise.all(pending.map(async (task) => {\n      const value = await task();\n      this.results.push(value);\n    }));\n", to: "    for (const task of pending) {\n      const value = await task();\n      this.results.push(value);\n    }\n" }],
  "py-bug-fix-config-merge": [{ kind: "edit", path: "config/merge.py", from: "    result = dict(base)\n    for key, value in override.items():\n        result[key] = value\n    return result\n", to: "    result = {key: (dict(value) if isinstance(value, dict) else value) for key, value in base.items()}\n    for key, value in override.items():\n        if isinstance(value, dict) and isinstance(result.get(key), dict):\n            result[key] = merge_config(result[key], value)\n        else:\n            result[key] = value\n    return result\n" }],
  "js-feature-rate-limiter": [
    { kind: "write", path: "src/net/rate-limiter.js", content: "/** Sliding-window limiter: at most `limit` acquisitions in any trailing `windowMs`. */\nexport function createRateLimiter(limit, windowMs) {\n  const stamps = [];\n  return {\n    tryAcquire(nowMs) {\n      while (stamps.length > 0 && nowMs - stamps[0] >= windowMs) stamps.shift();\n      if (stamps.length >= limit) return false;\n      stamps.push(nowMs);\n      return true;\n    },\n  };\n}\n" },
    { kind: "edit", path: "src/index.js", from: "export { parseHeaders } from \"./net/headers.js\";\n", to: "export { parseHeaders } from \"./net/headers.js\";\nexport { createRateLimiter } from \"./net/rate-limiter.js\";\n" },
  ],
  "ts-feature-cli-stats": [
    { kind: "write", path: "src/commands/stats.ts", content: "import fs from \"node:fs\";\nimport type { Command } from \"./index.ts\";\n\nexport const stats: Command = async (args) => {\n  const file = args[0];\n  if (!file || !fs.existsSync(file)) {\n    console.error(`stats: file not found: ${file ?? \"(none)\"}`);\n    return 2;\n  }\n  const text = fs.readFileSync(file, \"utf8\");\n  const lines = text.length === 0 ? 0 : text.split(/\\r?\\n/).length - (text.endsWith(\"\\n\") ? 1 : 0);\n  const words = text.split(/\\s+/).filter(Boolean).length;\n  console.log(JSON.stringify({ lines, words, bytes: fs.statSync(file).size }));\n  return 0;\n};\n" },
    { kind: "edit", path: "src/commands/index.ts", from: "import { version } from \"./version.ts\";\n", to: "import { version } from \"./version.ts\";\nimport { stats } from \"./stats.ts\";\n" },
    { kind: "edit", path: "src/commands/index.ts", from: "  echo,\n  version,\n", to: "  echo,\n  version,\n  stats,\n" },
  ],
  "ts-refactor-extract-validator": [
    { kind: "write", path: "src/validation/order.ts", content: VALIDATOR_MODULE },
    { kind: "write", path: "src/handlers/create-order.ts", content: handler("createOrder", "input: OrderInput", "  return { status: 201, body: { id: `ord-${input.customerId}-${input.lines.length}`, currency: input.currency ?? \"USD\" } };\n") },
    { kind: "write", path: "src/handlers/update-order.ts", content: handler("updateOrder", "id: string, input: OrderInput", "  return { status: 200, body: { id, lines: input.lines.length } };\n") },
    { kind: "write", path: "src/handlers/quote-order.ts", content: handler("quoteOrder", "input: OrderInput", "  const units = input.lines.reduce((sum, line) => sum + line.quantity, 0);\n  return { status: 200, body: { units, currency: input.currency ?? \"USD\" } };\n") },
  ],
  "js-build-config-test-script": [
    // Node's runner treats a bare directory argument as a file; default discovery finds tests/**/*.test.js.
    { kind: "edit", path: "package.json", from: "\"test\": \"node --test test/\"", to: "\"test\": \"node --test\"" },
    { kind: "write", path: "tests/parse.test.js", content: "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { parseKv } from \"../src/parse.js\";\n\ntest(\"parses pairs\", () => {\n  assert.deepEqual(parseKv(\"a=1\\nb = two\"), { a: \"1\", b: \"two\" });\n});\n\ntest(\"ignores comments and blanks\", () => {\n  assert.deepEqual(parseKv(\"# c\\n\\nx=y\"), { x: \"y\" });\n});\n\ntest(\"rejects invalid lines\", () => {\n  assert.throws(() => parseKv(\"nope\"), /invalid line/);\n});\n" },
  ],
  "js-investigation-webhook-retries": [],
  "ts-large-context-rename-config-key": [
    { kind: "edit", path: "src/config/types.ts", from: "maxRetries: number;", to: "retryLimit: number;" },
    { kind: "edit", path: "src/config/defaults.ts", from: "maxRetries: 3,", to: "retryLimit: 3," },
    { kind: "edit", path: "src/config/load-config.ts", from: "if (!Number.isInteger(merged.maxRetries) || merged.maxRetries < 0) throw new Error(\"maxRetries must be a non-negative integer\");", to: "if (!Number.isInteger(merged.retryLimit) || merged.retryLimit < 0) throw new Error(\"retryLimit must be a non-negative integer\");" },
    { kind: "edit", path: "src/net/retry-executor.ts", from: "config.maxRetries", to: "config.retryLimit" },
    { kind: "edit", path: "src/net/attempt-budget.ts", from: "config.maxRetries", to: "config.retryLimit" },
    { kind: "edit", path: "src/ops/health-report.ts", from: "config.maxRetries", to: "config.retryLimit" },
    { kind: "edit", path: "src/ops/cli-flags.ts", from: "out.maxRetries = ", to: "out.retryLimit = " },
  ],
};

export const REFERENCE_ANSWERS = {
  "js-investigation-webhook-retries": "The maximum number of outbound webhook delivery attempts is decided in src/net/webhook-dispatcher.js by the constant MAX_WEBHOOK_ATTEMPTS, currently 7 (initial send plus retries).",
};

/** Final summary text the scripted reference coder reports after applying its steps. */
export function referenceSummary(taskId) {
  return REFERENCE_ANSWERS[taskId] ?? `Applied the reference change for ${taskId}: ${(REFERENCE_STEPS[taskId] ?? []).map((step) => `${step.kind} ${step.path}`).join(", ")}.`;
}
