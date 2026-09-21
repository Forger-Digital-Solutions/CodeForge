#!/usr/bin/env node
/**
 * R23 pilot corpus generator (protocol §4). Deterministic: running it twice produces byte-identical
 * task directories, so the frozen manifest (`manifest.json`, sha256 per task) can always be
 * re-derived. Tasks are synthetic repositories authored for R23 — no CodeForge code, no task text
 * mentioning ForgeGreen/efficiency/tokens/benchmark, and the hidden verifier never appears in the
 * fixture tree.
 *
 *   node benchmarks/r23/generate-tasks.mjs            # writes benchmarks/r23/tasks/<task_id>/
 *
 * Layout per task: task.json · fixture/ (what the agent sees) · hidden/ (verifier, injected after
 * the run into a COPY of the resulting workspace; cwd = that copy).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TASKS_ROOT = path.join(here, "tasks");

const files = new Map(); // "<taskId>/<relative>" → content

function put(taskId, relative, content) {
  files.set(`${taskId}/${relative.replace(/\\/g, "/")}`, content);
}

function task(taskId, record, fixture, hidden) {
  const full = {
    taskId,
    role: "coder",
    permissions: { read: true, search: true, write: true, executeCommand: false, network: false },
    fixture: "fixture",
    hidden: "hidden",
    tags: [],
    ...record,
  };
  put(taskId, "task.json", `${JSON.stringify(full, null, 2)}\n`);
  for (const [relative, content] of Object.entries(fixture)) put(taskId, `fixture/${relative}`, content);
  for (const [relative, content] of Object.entries(hidden)) put(taskId, `hidden/${relative}`, content);
}

// ---------------------------------------------------------------------------------------------
// Deterministic filler so medium/large repositories have realistic shape and search noise.
// ---------------------------------------------------------------------------------------------
const WORDS = ["account", "billing", "catalog", "delivery", "export", "fleet", "gateway", "history", "invoice", "journal", "ledger", "metrics", "notice", "order", "profile", "quota", "receipt", "schedule", "tenant", "upload", "vendor", "webhook", "yield", "zone"];
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}
function fillerModuleTs(name, deps, random, lines = 24) {
  const imports = deps.map((dep) => `import { ${dep}Service } from "./${dep}.ts";`).join("\n");
  const body = Array.from({ length: lines }, (_, index) => `  ${pick(random, ["compute", "resolve", "normalize", "collect", "apply"])}${index}(input: number): number {\n    // ${name}: step ${index} — bounded arithmetic used by the ${pick(random, WORDS)} pipeline\n    if (!Number.isFinite(input)) throw new Error("${name}: invalid input");\n    return input * ${index + 1} + ${lines - index};\n  }`).join("\n\n");
  return `${imports}${imports ? "\n\n" : ""}export class ${name}Service {\n${body}\n}\n\nexport function create${name}(): ${name}Service {\n  return new ${name}Service();\n}\n`;
}
function fillerModuleJs(name, deps, random, lines = 20) {
  const imports = deps.map((dep) => `import { ${dep}Service } from "./${dep}.js";`).join("\n");
  const body = Array.from({ length: lines }, (_, index) => `  ${pick(random, ["compute", "resolve", "normalize", "collect", "apply"])}${index}(input) {\n    // ${name}: step ${index} — bounded arithmetic used by the ${pick(random, WORDS)} pipeline\n    if (!Number.isFinite(input)) throw new Error("${name}: invalid input");\n    return input * ${index + 1} + ${lines - index};\n  }`).join("\n\n");
  return `${imports}${imports ? "\n\n" : ""}export class ${name}Service {\n${body}\n}\n\nexport function create${name}() {\n  return new ${name}Service();\n}\n`;
}
function fillerTree(prefix, count, ext, seed) {
  const random = seeded(seed);
  const out = {};
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${pick(random, WORDS)}${pick(random, ["Core", "Sync", "Store", "Policy", "Reader", "Writer", "Index", "Guard"])}${index}`;
    names.push(name);
  }
  names.forEach((name, index) => {
    const deps = names.slice(Math.max(0, index - 3), index).filter(() => random() > 0.5);
    const dir = `${prefix}/${pick(random, ["core", "services", "adapters", "domain", "infra", "ops"])}`;
    out[`${dir}/${name}.${ext}`] = ext === "ts" ? fillerModuleTs(name, deps.map((dep) => `../${out.__dirOf?.[dep] ?? "core"}/${dep}`.replace(/^\.\.\//, "")), random) : fillerModuleJs(name, [], random);
  });
  return out;
}
// Simpler, import-safe filler: modules never import each other (search noise only).
function noiseTree(prefix, count, ext, seed) {
  const random = seeded(seed);
  const out = {};
  for (let index = 0; index < count; index += 1) {
    const name = `${pick(random, WORDS)}${pick(random, ["Core", "Sync", "Store", "Policy", "Reader", "Writer", "Index", "Guard"])}${index}`;
    const dir = `${prefix}/${pick(random, ["core", "services", "adapters", "domain", "infra", "ops"])}`;
    out[`${dir}/${name}.${ext}`] = ext === "ts" ? fillerModuleTs(name, [], random) : fillerModuleJs(name, [], random);
  }
  return out;
}
void fillerTree;

const PKG_ESM = (name) => `${JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }, null, 2)}\n`;
const verifierJs = (imports, checks) => `${imports}\nlet passed = 0;\nlet failed = 0;\nconst check = (label, ok) => {\n  if (ok) passed += 1;\n  else {\n    failed += 1;\n    console.error("FAIL " + label);\n  }\n};\n${checks}\nconsole.log(JSON.stringify({ passed, failed }));\nprocess.exit(failed === 0 ? 0 : 1);\n`;
const verifierPy = (imports, checks) => `import json\nimport sys\nsys.path.insert(0, ".")\n${imports}\npassed = 0\nfailed = 0\n\n\ndef check(label, ok):\n    global passed, failed\n    if ok:\n        passed += 1\n    else:\n        failed += 1\n        print("FAIL " + label, file=sys.stderr)\n\n\n${checks}\nprint(json.dumps({"passed": passed, "failed": failed}))\nsys.exit(0 if failed == 0 else 1)\n`;

// ---------------------------------------------------------------------------------------------
// Qualification tasks (model selection only — never in the paired set)
// ---------------------------------------------------------------------------------------------
task("qual-js-return-sign", {
  class: "small_fix", language: "javascript", repoSizeClass: "small", tags: ["qualification"],
  goal: "The add() function in src/math.js returns the wrong result. Fix it so add(2, 3) returns 5 without changing multiply().",
  visibleVerification: ["node --check src/math.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("qual-math"),
  "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n",
  "README.md": "# qual-math\n\nTiny arithmetic helpers.\n",
}, {
  "verify.mjs": verifierJs('import { add, multiply } from "../src/math.js";', 'check("add(2,3)", add(2, 3) === 5);\ncheck("add(-1,1)", add(-1, 1) === 0);\ncheck("multiply", multiply(3, 4) === 12);'),
});

task("qual-js-off-by-one", {
  class: "small_fix", language: "javascript", repoSizeClass: "small", tags: ["qualification"],
  goal: "lastItem() in src/list.js should return the final element of a non-empty array and undefined for an empty array. It currently misbehaves; fix it.",
  visibleVerification: ["node --check src/list.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("qual-list"),
  "src/list.js": "export function lastItem(items) {\n  return items[items.length];\n}\n\nexport function firstItem(items) {\n  return items[0];\n}\n",
}, {
  "verify.mjs": verifierJs('import { lastItem, firstItem } from "../src/list.js";', 'check("last", lastItem([1, 2, 3]) === 3);\ncheck("empty", lastItem([]) === undefined);\ncheck("first", firstItem([9]) === 9);'),
});

task("qual-js-missing-export", {
  class: "small_fix", language: "javascript", repoSizeClass: "small", tags: ["qualification"],
  goal: "src/index.js is supposed to re-export capitalize from src/strings.js but importing { capitalize } from src/index.js fails. Make the export work; capitalize('abc') must return 'Abc'.",
  visibleVerification: ["node --check src/index.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("qual-exports"),
  "src/strings.js": "export function capitalize(value) {\n  if (!value) return value;\n  return value.charAt(0).toUpperCase() + value.slice(1);\n}\n\nexport function trimAll(value) {\n  return value.replace(/\\s+/g, \"\");\n}\n",
  "src/index.js": "export { trimAll } from \"./strings.js\";\n",
}, {
  "verify.mjs": verifierJs('import { capitalize, trimAll } from "../src/index.js";', 'check("capitalize", capitalize("abc") === "Abc");\ncheck("trimAll", trimAll("a b") === "ab");'),
});

// ---------------------------------------------------------------------------------------------
// Pilot tasks (12)
// ---------------------------------------------------------------------------------------------

// 1 small_fix / javascript / small
task("js-small-fix-clamp", {
  class: "small_fix", language: "javascript", repoSizeClass: "small",
  goal: "clamp(value, min, max) in src/clamp.js returns wrong results for values below the minimum. Fix it so clamp(-5, 0, 10) returns 0, clamp(15, 0, 10) returns 10 and clamp(5, 0, 10) returns 5.",
  visibleVerification: ["node --check src/clamp.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("clamp-utils"),
  "src/clamp.js": "/** Constrain value to the inclusive [min, max] range. */\nexport function clamp(value, min, max) {\n  if (value > min) return min;\n  if (value > max) return max;\n  return value;\n}\n\nexport function lerp(a, b, t) {\n  return a + (b - a) * clamp(t, 0, 1);\n}\n",
  "src/index.js": "export { clamp, lerp } from \"./clamp.js\";\n",
  "README.md": "# clamp-utils\n\nNumeric range helpers used by the chart renderer.\n",
}, {
  "verify.mjs": verifierJs('import { clamp, lerp } from "../src/index.js";', 'check("below", clamp(-5, 0, 10) === 0);\ncheck("above", clamp(15, 0, 10) === 10);\ncheck("inside", clamp(5, 0, 10) === 5);\ncheck("edge-min", clamp(0, 0, 10) === 0);\ncheck("edge-max", clamp(10, 0, 10) === 10);\ncheck("lerp", lerp(0, 10, 0.5) === 5);\ncheck("lerp-clamped", lerp(0, 10, 2) === 10);'),
});

// 2 small_fix / typescript / small
task("ts-small-fix-slugify", {
  class: "small_fix", language: "typescript", repoSizeClass: "small",
  goal: "slugify() in src/slugify.ts must lowercase its input, replace any run of non-alphanumeric characters with a single dash, and have no leading or trailing dashes. Currently slugify('Hello, World!') returns 'Hello-World-'. Fix it.",
  visibleVerification: ["node --check src/slugify.ts"],
  verifier: { command: "node hidden/verify.ts", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("slugify-ts"),
  "src/slugify.ts": "/** URL-safe slug for a title. */\nexport function slugify(input: string): string {\n  return input.replace(/[^A-Za-z0-9]+/g, \"-\");\n}\n\nexport function isSlug(value: string): boolean {\n  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);\n}\n",
  "src/index.ts": "export { slugify, isSlug } from \"./slugify.ts\";\n",
}, {
  "verify.ts": verifierJs('import { slugify, isSlug } from "../src/index.ts";', 'check("basic", slugify("Hello, World!") === "hello-world");\ncheck("runs", slugify("  A --- B  ") === "a-b");\ncheck("unicode-strip", slugify("Café au lait") === "caf-au-lait");\ncheck("isSlug", isSlug(slugify("Release Notes 2026")) === true);\ncheck("empty", slugify("!!!") === "");'),
});

// 3 small_fix / python / small
task("py-small-fix-median", {
  class: "small_fix", language: "python", repoSizeClass: "small",
  goal: "stats.median() in stats/core.py returns the wrong value for even-length inputs (median([1, 2, 3, 4]) must be 2.5). Fix it without changing mean().",
  visibleVerification: ["python -m py_compile stats/core.py"],
  verifier: { command: "python hidden/verify.py", timeoutMs: 30000 },
}, {
  "README.md": "# stats\n\nSmall descriptive statistics helpers.\n",
  "stats/__init__.py": "from .core import mean, median\n\n__all__ = [\"mean\", \"median\"]\n",
  "stats/core.py": "\"\"\"Descriptive statistics.\"\"\"\n\n\ndef mean(values):\n    if not values:\n        raise ValueError(\"mean of empty input\")\n    return sum(values) / len(values)\n\n\ndef median(values):\n    if not values:\n        raise ValueError(\"median of empty input\")\n    ordered = sorted(values)\n    return ordered[len(ordered) // 2]\n",
}, {
  "verify.py": verifierPy("from stats import mean, median", 'check("even", median([1, 2, 3, 4]) == 2.5)\ncheck("odd", median([3, 1, 2]) == 2)\ncheck("even-unsorted", median([4, 1, 3, 2]) == 2.5)\ncheck("single", median([7]) == 7)\ncheck("mean", mean([1, 2, 3]) == 2)'),
});

// 4 bug_fix / javascript / medium (3-file regression)
task("js-bug-fix-cart-total", {
  class: "bug_fix", language: "javascript", repoSizeClass: "medium",
  goal: "Checkout totals are wrong when a percentage discount is applied: a cart with one item at 100.00 and a 10% discount code returns 10.00 instead of 90.00 from computeTotal() in src/checkout/total.js. Find the cause and fix it so discounts reduce the subtotal by the given percentage.",
  visibleVerification: ["node --check src/checkout/total.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("storefront"),
  "src/checkout/total.js": "import { subtotal } from \"./subtotal.js\";\nimport { discountMultiplier } from \"../pricing/discounts.js\";\n\n/** Final amount due for a cart after discount codes. */\nexport function computeTotal(cart, discountCode) {\n  const base = subtotal(cart.items);\n  const multiplier = discountMultiplier(discountCode);\n  return round2(base * multiplier);\n}\n\nexport function round2(value) {\n  return Math.round(value * 100) / 100;\n}\n",
  "src/checkout/subtotal.js": "export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);\n}\n",
  "src/pricing/discounts.js": "import { DISCOUNT_CODES } from \"./codes.js\";\n\n/** Fraction of the subtotal the customer pays after the code is applied. */\nexport function discountMultiplier(code) {\n  if (!code) return 1;\n  const percent = DISCOUNT_CODES[code];\n  if (percent === undefined) return 1;\n  return percent / 100;\n}\n",
  "src/pricing/codes.js": "/** Discount code → percent off. */\nexport const DISCOUNT_CODES = {\n  WELCOME10: 10,\n  SPRING25: 25,\n  HALF: 50,\n};\n",
  "src/index.js": "export { computeTotal } from \"./checkout/total.js\";\nexport { discountMultiplier } from \"./pricing/discounts.js\";\n",
  ...noiseTree("src", 40, "js", 41),
}, {
  "verify.mjs": verifierJs('import { computeTotal, discountMultiplier } from "../src/index.js";', 'const cart = { items: [{ unitPrice: 100, quantity: 1 }] };\ncheck("no-code", computeTotal(cart, undefined) === 100);\ncheck("ten-percent", computeTotal(cart, "WELCOME10") === 90);\ncheck("quarter", computeTotal({ items: [{ unitPrice: 40, quantity: 2 }] }, "SPRING25") === 60);\ncheck("half", computeTotal(cart, "HALF") === 50);\ncheck("unknown-code", computeTotal(cart, "NOPE") === 100);\ncheck("multiplier", Math.abs(discountMultiplier("WELCOME10") - 0.9) < 1e-9);'),
});

// 5 bug_fix / typescript / medium (async ordering)
task("ts-bug-fix-queue-order", {
  class: "bug_fix", language: "typescript", repoSizeClass: "medium",
  goal: "TaskQueue in src/queue/task-queue.ts is documented as processing tasks strictly in FIFO order, one at a time, but tasks run concurrently and finish out of order (a slow first task completes after a fast second task). Fix run() so tasks execute sequentially in enqueue order while keeping the public API (enqueue, run, results) unchanged.",
  visibleVerification: ["node --check src/queue/task-queue.ts"],
  verifier: { command: "node hidden/verify.ts", timeoutMs: 60000 },
}, {
  "package.json": PKG_ESM("queue-ts"),
  "src/queue/task-queue.ts": "export type Task<T> = () => Promise<T>;\n\n/**\n * FIFO task queue. Tasks are executed one at a time in the order they were enqueued; `results`\n * holds each task's value in that same order once `run()` resolves.\n */\nexport class TaskQueue<T> {\n  private readonly tasks: Task<T>[] = [];\n  readonly results: T[] = [];\n\n  enqueue(task: Task<T>): void {\n    this.tasks.push(task);\n  }\n\n  async run(): Promise<void> {\n    const pending = this.tasks.splice(0);\n    await Promise.all(pending.map(async (task) => {\n      const value = await task();\n      this.results.push(value);\n    }));\n  }\n}\n",
  "src/queue/index.ts": "export { TaskQueue } from \"./task-queue.ts\";\nexport type { Task } from \"./task-queue.ts\";\n",
  "src/index.ts": "export * from \"./queue/index.ts\";\n",
  ...noiseTree("src", 55, "ts", 52),
}, {
  "verify.ts": verifierJs('import { TaskQueue } from "../src/index.ts";', 'const order: string[] = [];\nconst wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\nconst queue = new TaskQueue<string>();\nlet active = 0;\nlet maxActive = 0;\nconst make = (name: string, ms: number) => async () => {\n  active += 1;\n  maxActive = Math.max(maxActive, active);\n  await wait(ms);\n  order.push(name);\n  active -= 1;\n  return name;\n};\nqueue.enqueue(make("slow", 120));\nqueue.enqueue(make("fast", 5));\nqueue.enqueue(make("mid", 40));\nawait queue.run();\ncheck("completion-order", order.join(",") === "slow,fast,mid");\ncheck("results-order", queue.results.join(",") === "slow,fast,mid");\ncheck("sequential", maxActive === 1);\nconst empty = new TaskQueue<number>();\nawait empty.run();\ncheck("empty-run", empty.results.length === 0);'),
});

// 6 bug_fix / python / small (deep merge)
task("py-bug-fix-config-merge", {
  class: "bug_fix", language: "python", repoSizeClass: "small",
  goal: "merge_config(base, override) in config/merge.py is supposed to deep-merge nested dictionaries (override keys win, untouched nested keys are preserved) but it currently replaces whole nested sections. For base {'db': {'host': 'a', 'port': 1}} and override {'db': {'port': 2}} the result must be {'db': {'host': 'a', 'port': 2}}. Fix it; lists and scalars in override replace the base value entirely, and neither input may be mutated.",
  visibleVerification: ["python -m py_compile config/merge.py"],
  verifier: { command: "python hidden/verify.py", timeoutMs: 30000 },
}, {
  "config/__init__.py": "from .merge import merge_config\n\n__all__ = [\"merge_config\"]\n",
  "config/merge.py": "\"\"\"Configuration layering.\"\"\"\n\n\ndef merge_config(base, override):\n    \"\"\"Return base with override applied (override wins).\"\"\"\n    result = dict(base)\n    for key, value in override.items():\n        result[key] = value\n    return result\n",
  "config/defaults.py": "DEFAULTS = {\n    \"db\": {\"host\": \"localhost\", \"port\": 5432, \"pool\": {\"min\": 1, \"max\": 8}},\n    \"features\": [\"search\"],\n    \"debug\": False,\n}\n",
  "README.md": "# config\n\nLayered configuration: defaults ← environment ← explicit overrides.\n",
}, {
  "verify.py": verifierPy("import copy\nfrom config import merge_config\nfrom config.defaults import DEFAULTS", 'base = {"db": {"host": "a", "port": 1}}\noverride = {"db": {"port": 2}}\nsnapshot_base = copy.deepcopy(base)\nsnapshot_override = copy.deepcopy(override)\nmerged = merge_config(base, override)\ncheck("deep", merged == {"db": {"host": "a", "port": 2}})\ncheck("base-unmutated", base == snapshot_base)\ncheck("override-unmutated", override == snapshot_override)\nnested = merge_config(DEFAULTS, {"db": {"pool": {"max": 20}}, "features": ["export"]})\ncheck("nested-two-levels", nested["db"]["pool"] == {"min": 1, "max": 20} and nested["db"]["host"] == "localhost")\ncheck("list-replaced", nested["features"] == ["export"])\ncheck("scalar", merge_config({"debug": False}, {"debug": True})["debug"] is True)\ncheck("new-key", merge_config({"a": 1}, {"b": {"c": 2}}) == {"a": 1, "b": {"c": 2}})'),
});

// 7 feature / javascript / medium
task("js-feature-rate-limiter", {
  class: "feature", language: "javascript", repoSizeClass: "medium",
  goal: "Add a sliding-window rate limiter to this service. Create src/net/rate-limiter.js exporting createRateLimiter(limit, windowMs) that returns an object with tryAcquire(nowMs) → boolean: it allows at most `limit` acquisitions within any trailing window of `windowMs` milliseconds and rejects further attempts until old acquisitions fall out of the window. Re-export createRateLimiter from src/index.js. Do not change existing exports.",
  visibleVerification: ["node --check src/index.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
}, {
  "package.json": PKG_ESM("edge-service"),
  "src/index.js": "export { createRetryPolicy } from \"./net/retry.js\";\nexport { parseHeaders } from \"./net/headers.js\";\n",
  "src/net/retry.js": "/** Exponential backoff policy. */\nexport function createRetryPolicy({ maxAttempts = 3, baseDelayMs = 100 } = {}) {\n  return {\n    maxAttempts,\n    delayFor(attempt) {\n      return baseDelayMs * 2 ** Math.max(0, attempt - 1);\n    },\n  };\n}\n",
  "src/net/headers.js": "export function parseHeaders(raw) {\n  const out = {};\n  for (const line of raw.split(/\\r?\\n/)) {\n    const index = line.indexOf(\":\");\n    if (index === -1) continue;\n    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();\n  }\n  return out;\n}\n",
  "README.md": "# edge-service\n\nNetworking helpers shared by the edge workers. Modules live under src/net and are re-exported from src/index.js.\n",
  ...noiseTree("src", 60, "js", 73),
}, {
  "verify.mjs": verifierJs('import { createRateLimiter, createRetryPolicy, parseHeaders } from "../src/index.js";', 'check("existing-retry", createRetryPolicy().maxAttempts === 3);\ncheck("existing-headers", parseHeaders("A: b")["a"] === "b");\ncheck("factory", typeof createRateLimiter === "function");\nconst limiter = createRateLimiter(3, 1000);\ncheck("allow-1", limiter.tryAcquire(0) === true);\ncheck("allow-2", limiter.tryAcquire(100) === true);\ncheck("allow-3", limiter.tryAcquire(200) === true);\ncheck("reject-4", limiter.tryAcquire(300) === false);\ncheck("still-rejected", limiter.tryAcquire(999) === false);\ncheck("slides", limiter.tryAcquire(1000) === true);\ncheck("slides-2", limiter.tryAcquire(1100) === true);\ncheck("reject-again", limiter.tryAcquire(1150) === false);\nconst single = createRateLimiter(1, 50);\ncheck("single-allow", single.tryAcquire(0) === true);\ncheck("single-reject", single.tryAcquire(49) === false);\ncheck("single-slide", single.tryAcquire(50) === true);'),
});

// 8 feature / typescript / medium (CLI subcommand)
task("ts-feature-cli-stats", {
  class: "feature", language: "typescript", repoSizeClass: "medium",
  goal: "Add a `stats` subcommand to the CLI in src/cli.ts. `node src/cli.ts stats <file>` must print a single JSON line {\"lines\": <number of lines>, \"words\": <number of whitespace-separated words>, \"bytes\": <file size in bytes>} for the given file and exit 0; a missing file must print an error to stderr and exit 2. Follow the existing command pattern (one module per command under src/commands, registered in src/commands/index.ts). Keep the existing echo and version commands working.",
  visibleVerification: ["node --check src/cli.ts"],
  verifier: { command: "node hidden/verify.ts", timeoutMs: 60000 },
}, {
  "package.json": PKG_ESM("textkit"),
  "src/cli.ts": "import { commands } from \"./commands/index.ts\";\n\nconst [name, ...args] = process.argv.slice(2);\nconst command = name ? commands[name] : undefined;\nif (!command) {\n  console.error(`unknown command: ${name ?? \"(none)\"}. Available: ${Object.keys(commands).join(\", \")}`);\n  process.exit(1);\n}\nconst code = await command(args);\nprocess.exit(code);\n",
  "src/commands/index.ts": "import { echo } from \"./echo.ts\";\nimport { version } from \"./version.ts\";\n\nexport type Command = (args: string[]) => Promise<number>;\n\nexport const commands: Record<string, Command> = {\n  echo,\n  version,\n};\n",
  "src/commands/echo.ts": "import type { Command } from \"./index.ts\";\n\nexport const echo: Command = async (args) => {\n  console.log(args.join(\" \"));\n  return 0;\n};\n",
  "src/commands/version.ts": "import type { Command } from \"./index.ts\";\n\nexport const version: Command = async () => {\n  console.log(\"textkit 1.0.0\");\n  return 0;\n};\n",
  "README.md": "# textkit\n\nCommand pattern: each subcommand is a module exporting a `Command` under src/commands, registered in src/commands/index.ts. Commands return the process exit code.\n",
  ...noiseTree("src/lib", 45, "ts", 84),
}, {
  "sample.txt": "alpha beta gamma\ndelta epsilon\n\nzeta\n",
  "verify.ts": `import { spawnSync } from "node:child_process";\nimport fs from "node:fs";\nimport path from "node:path";\nconst run = (args: string[]) => spawnSync(process.execPath, ["src/cli.ts", ...args], { encoding: "utf8" });\n${verifierJs("", 'const sample = path.join("hidden", "sample.txt");\nconst statsRun = run(["stats", sample]);\ncheck("exit-0", statsRun.status === 0);\nlet parsed: { lines?: number; words?: number; bytes?: number } = {};\ntry { parsed = JSON.parse(statsRun.stdout.trim().split(/\\r?\\n/).pop() ?? "{}"); } catch { parsed = {}; }\ncheck("lines", parsed.lines === 4);\ncheck("words", parsed.words === 6);\ncheck("bytes", parsed.bytes === fs.statSync(sample).size);\nconst missing = run(["stats", "hidden/does-not-exist.txt"]);\ncheck("missing-exit-2", missing.status === 2);\ncheck("missing-stderr", missing.stderr.trim().length > 0);\ncheck("echo-still-works", run(["echo", "a", "b"]).stdout.trim() === "a b");\ncheck("version-still-works", run(["version"]).stdout.includes("textkit"));\ncheck("registered-in-index", fs.readFileSync("src/commands/index.ts", "utf8").includes("stats"));').replace(/^\n/, "")}`,
});

// 9 refactor / typescript / medium
task("ts-refactor-extract-validator", {
  class: "refactor", language: "typescript", repoSizeClass: "medium",
  goal: "The three request handlers in src/handlers/ (create-order.ts, update-order.ts, quote-order.ts) each contain a copy of the same order validation logic. Extract it into a new module src/validation/order.ts exporting validateOrder(input): ValidationResult ({ ok: true } or { ok: false, errors: string[] }), make all three handlers use it, and remove the duplicated code. Behaviour must not change: the same inputs must produce the same handler results and error messages as before.",
  visibleVerification: ["node --check src/handlers/create-order.ts", "node --check src/handlers/update-order.ts", "node --check src/handlers/quote-order.ts"],
  verifier: { command: "node hidden/verify.ts", timeoutMs: 60000 },
}, (() => {
  const validation = (fnName) => `function ${fnName}(input: OrderInput): string[] {\n  const errors: string[] = [];\n  if (!input.customerId || input.customerId.trim() === "") errors.push("customerId is required");\n  if (!Array.isArray(input.lines) || input.lines.length === 0) errors.push("at least one line is required");\n  for (const [index, line] of (input.lines ?? []).entries()) {\n    if (!line.sku) errors.push(\`lines[\${index}].sku is required\`);\n    if (!Number.isInteger(line.quantity) || line.quantity <= 0) errors.push(\`lines[\${index}].quantity must be a positive integer\`);\n  }\n  if (input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency)) errors.push("currency must be a 3-letter code");\n  return errors;\n}\n`;
  return {
    "package.json": PKG_ESM("orders-api"),
    "src/types.ts": "export interface OrderLine {\n  sku: string;\n  quantity: number;\n}\n\nexport interface OrderInput {\n  customerId: string;\n  lines: OrderLine[];\n  currency?: string;\n}\n\nexport interface HandlerResult {\n  status: number;\n  body: Record<string, unknown>;\n}\n",
    "src/handlers/create-order.ts": `import type { HandlerResult, OrderInput } from "../types.ts";\n\n${validation("validateCreate")}\nexport function createOrder(input: OrderInput): HandlerResult {\n  const errors = validateCreate(input);\n  if (errors.length > 0) return { status: 400, body: { errors } };\n  return { status: 201, body: { id: \`ord-\${input.customerId}-\${input.lines.length}\`, currency: input.currency ?? "USD" } };\n}\n`,
    "src/handlers/update-order.ts": `import type { HandlerResult, OrderInput } from "../types.ts";\n\n${validation("validateUpdate")}\nexport function updateOrder(id: string, input: OrderInput): HandlerResult {\n  const errors = validateUpdate(input);\n  if (errors.length > 0) return { status: 400, body: { errors } };\n  return { status: 200, body: { id, lines: input.lines.length } };\n}\n`,
    "src/handlers/quote-order.ts": `import type { HandlerResult, OrderInput } from "../types.ts";\n\n${validation("validateQuote")}\nexport function quoteOrder(input: OrderInput): HandlerResult {\n  const errors = validateQuote(input);\n  if (errors.length > 0) return { status: 400, body: { errors } };\n  const units = input.lines.reduce((sum, line) => sum + line.quantity, 0);\n  return { status: 200, body: { units, currency: input.currency ?? "USD" } };\n}\n`,
    "src/handlers/index.ts": "export { createOrder } from \"./create-order.ts\";\nexport { updateOrder } from \"./update-order.ts\";\nexport { quoteOrder } from \"./quote-order.ts\";\n",
    "README.md": "# orders-api\n\nHandlers live under src/handlers; shared modules under src/<area>/. Handler results are `{ status, body }`.\n",
    ...noiseTree("src/lib", 50, "ts", 95),
  };
})(), {
  "verify.ts": `import fs from "node:fs";\nimport { createOrder, updateOrder, quoteOrder } from "../src/handlers/index.ts";\nimport * as validation from "../src/validation/order.ts";\n${verifierJs("", 'const bad = { customerId: "", lines: [{ sku: "", quantity: 0 }], currency: "usd" } as any;\nconst expectedErrors = ["customerId is required", "lines[0].sku is required", "lines[0].quantity must be a positive integer", "currency must be a 3-letter code"];\nconst same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);\ncheck("create-errors", same(createOrder(bad).body.errors, expectedErrors) && createOrder(bad).status === 400);\ncheck("update-errors", same(updateOrder("o1", bad).body.errors, expectedErrors));\ncheck("quote-errors", same(quoteOrder(bad).body.errors, expectedErrors));\ncheck("no-lines", same(createOrder({ customerId: "c", lines: [] } as any).body.errors, ["at least one line is required"]));\nconst good = { customerId: "c9", lines: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }] };\ncheck("create-ok", same(createOrder(good), { status: 201, body: { id: "ord-c9-2", currency: "USD" } }));\ncheck("update-ok", same(updateOrder("o1", good), { status: 200, body: { id: "o1", lines: 2 } }));\ncheck("quote-ok", same(quoteOrder({ ...good, currency: "EUR" }), { status: 200, body: { units: 3, currency: "EUR" } }));\ncheck("validator-exported", typeof validation.validateOrder === "function");\ncheck("validator-shape-ok", same(validation.validateOrder(good), { ok: true }));\ncheck("validator-shape-bad", same(validation.validateOrder(bad), { ok: false, errors: expectedErrors }));\nconst handlers = ["create-order", "update-order", "quote-order"].map((name) => fs.readFileSync(`src/handlers/${name}.ts`, "utf8"));\ncheck("handlers-import-validator", handlers.every((source) => source.includes("validation/order")));\ncheck("duplication-removed", handlers.every((source) => !source.includes("customerId is required")));').replace(/^\n/, "")}`,
});

// 10 build_config_dependency / javascript / small
task("js-build-config-test-script", {
  class: "build_config_dependency", language: "javascript", repoSizeClass: "small",
  goal: "`npm test` fails in this repository. Make `npm test` run the test files under tests/ with Node's built-in test runner and pass, without rewriting the tests' assertions. The package must remain an ES module package.",
  visibleVerification: ["node --check src/parse.js"],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 90000 },
}, {
  "package.json": `${JSON.stringify({ name: "kv-parse", version: "0.3.0", private: true, type: "module", scripts: { test: "node --test test/" } }, null, 2)}\n`,
  "src/parse.js": "/** Parse `key=value` lines into an object; `#` starts a comment. */\nexport function parseKv(text) {\n  const out = {};\n  for (const raw of text.split(/\\r?\\n/)) {\n    const line = raw.trim();\n    if (!line || line.startsWith(\"#\")) continue;\n    const index = line.indexOf(\"=\");\n    if (index === -1) throw new Error(`invalid line: ${line}`);\n    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();\n  }\n  return out;\n}\n",
  "tests/parse.test.js": "const test = require(\"node:test\");\nconst assert = require(\"node:assert/strict\");\nconst { parseKv } = require(\"../src/parse.js\");\n\ntest(\"parses pairs\", () => {\n  assert.deepEqual(parseKv(\"a=1\\nb = two\"), { a: \"1\", b: \"two\" });\n});\n\ntest(\"ignores comments and blanks\", () => {\n  assert.deepEqual(parseKv(\"# c\\n\\nx=y\"), { x: \"y\" });\n});\n\ntest(\"rejects invalid lines\", () => {\n  assert.throws(() => parseKv(\"nope\"), /invalid line/);\n});\n",
  "README.md": "# kv-parse\n\nRun `npm test`.\n",
}, {
  "verify.mjs": `import { spawnSync } from "node:child_process";\nimport fs from "node:fs";\n${verifierJs("", 'const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));\ncheck("still-esm", pkg.type === "module");\nconst npm = process.platform === "win32" ? "npm.cmd" : "npm";\nconst result = spawnSync(npm, ["test", "--silent"], { encoding: "utf8", shell: process.platform === "win32" });\ncheck("npm-test-exit-0", result.status === 0);\nconst output = `${result.stdout}\\n${result.stderr}`;\ncheck("three-tests-ran", /# pass 3/.test(output) || /pass 3/.test(output));\ncheck("assertions-intact", fs.readFileSync("tests/parse.test.js", "utf8").includes("rejects invalid lines") && fs.readFileSync("tests/parse.test.js", "utf8").includes("assert.throws"));').replace(/^\n/, "")}`,
});

// 11 investigation / javascript / medium (explorer, read-only)
task("js-investigation-webhook-retries", {
  class: "investigation", language: "javascript", repoSizeClass: "medium", role: "explorer",
  permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
  goal: "Outbound webhook deliveries are being retried more often than the operations team expects. Find where the maximum number of delivery attempts for outbound webhooks is decided in this codebase and report, in your final answer, the file path, the name of the constant or setting, and its current value.",
  visibleVerification: [],
  verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
  answerKey: { mode: "regex", values: ["webhook-dispatcher\\.js", "MAX_WEBHOOK_ATTEMPTS", "\\b7\\b"], caseInsensitive: true },
}, {
  "package.json": PKG_ESM("events-platform"),
  "src/net/webhook-dispatcher.js": "import { signPayload } from \"./signing.js\";\nimport { RETRY_BACKOFF_MS } from \"../config/timing.js\";\n\n/** Hard ceiling on delivery attempts per webhook event (initial send + retries). */\nconst MAX_WEBHOOK_ATTEMPTS = 7;\n\nexport async function dispatchWebhook(target, event, send) {\n  const body = JSON.stringify(event);\n  const signature = signPayload(body, target.secret);\n  let attempt = 0;\n  let lastError;\n  while (attempt < MAX_WEBHOOK_ATTEMPTS) {\n    attempt += 1;\n    try {\n      return await send(target.url, body, { signature, attempt });\n    } catch (error) {\n      lastError = error;\n      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1]));\n    }\n  }\n  throw lastError;\n}\n",
  "src/net/signing.js": "import crypto from \"node:crypto\";\n\nexport function signPayload(body, secret) {\n  return crypto.createHmac(\"sha256\", secret).update(body).digest(\"hex\");\n}\n",
  "src/config/timing.js": "/** Backoff schedule between delivery attempts, milliseconds. */\nexport const RETRY_BACKOFF_MS = [100, 300, 900, 2700, 8100, 24300];\n\n/** Inbound HTTP request retry budget (unrelated to outbound webhooks). */\nexport const INBOUND_MAX_RETRIES = 3;\n",
  "src/net/http-client.js": "import { INBOUND_MAX_RETRIES } from \"../config/timing.js\";\n\n/** Generic outbound HTTP client used for API calls (not webhooks). Retries idempotent GETs. */\nexport async function getWithRetry(url, fetchImpl) {\n  let attempt = 0;\n  for (;;) {\n    attempt += 1;\n    try {\n      return await fetchImpl(url);\n    } catch (error) {\n      if (attempt >= INBOUND_MAX_RETRIES) throw error;\n    }\n  }\n}\n",
  "src/jobs/email-retry.js": "/** Email deliveries retry up to 5 times; unrelated to webhooks. */\nexport const EMAIL_MAX_ATTEMPTS = 5;\n",
  "docs/operations.md": "# Operations\n\nWebhook deliveries are retried with exponential backoff. See the dispatcher for the exact policy.\n",
  ...noiseTree("src", 70, "js", 116),
}, {
  "verify.mjs": `import fs from "node:fs";\n${verifierJs("", 'const source = fs.readFileSync("src/net/webhook-dispatcher.js", "utf8");\ncheck("read-only-task-left-source-intact", source.includes("const MAX_WEBHOOK_ATTEMPTS = 7;"));').replace(/^\n/, "")}`,
});

// 12 large_context / typescript / large (rename across 8 files in a 1,200-file tree)
task("ts-large-context-rename-config-key", {
  class: "large_context", language: "typescript", repoSizeClass: "large",
  goal: "Rename the configuration key `maxRetries` to `retryLimit` everywhere it is defined or read in this repository (the ServiceConfig type, the defaults, every module that reads it, and the config loader's validation), so that loadConfig({ retryLimit: 4 }).retryLimit === 4 and the string `maxRetries` no longer appears anywhere under src/. Do not change any other behaviour.",
  visibleVerification: ["node --check src/config/load-config.ts"],
  verifier: { command: "node hidden/verify.ts", timeoutMs: 90000 },
}, (() => {
  const fixture = {
    "package.json": PKG_ESM("fleet-control"),
    "src/config/types.ts": "export interface ServiceConfig {\n  name: string;\n  maxRetries: number;\n  timeoutMs: number;\n  region: string;\n}\n",
    "src/config/defaults.ts": "import type { ServiceConfig } from \"./types.ts\";\n\nexport const DEFAULT_CONFIG: ServiceConfig = {\n  name: \"fleet-control\",\n  maxRetries: 3,\n  timeoutMs: 5000,\n  region: \"us-east-1\",\n};\n",
    "src/config/load-config.ts": "import { DEFAULT_CONFIG } from \"./defaults.ts\";\nimport type { ServiceConfig } from \"./types.ts\";\n\nexport function loadConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {\n  const merged = { ...DEFAULT_CONFIG, ...overrides };\n  if (!Number.isInteger(merged.maxRetries) || merged.maxRetries < 0) throw new Error(\"maxRetries must be a non-negative integer\");\n  if (merged.timeoutMs <= 0) throw new Error(\"timeoutMs must be positive\");\n  return merged;\n}\n",
    "src/net/retry-executor.ts": "import type { ServiceConfig } from \"../config/types.ts\";\n\nexport async function withRetries<T>(config: ServiceConfig, operation: () => Promise<T>): Promise<T> {\n  let attempt = 0;\n  for (;;) {\n    try {\n      return await operation();\n    } catch (error) {\n      attempt += 1;\n      if (attempt > config.maxRetries) throw error;\n    }\n  }\n}\n",
    "src/net/attempt-budget.ts": "import type { ServiceConfig } from \"../config/types.ts\";\n\n/** Total attempts = initial try + retries. */\nexport function attemptBudget(config: ServiceConfig): number {\n  return 1 + config.maxRetries;\n}\n",
    "src/ops/health-report.ts": "import type { ServiceConfig } from \"../config/types.ts\";\n\nexport function describeConfig(config: ServiceConfig): string {\n  return `${config.name} region=${config.region} retries=${config.maxRetries} timeout=${config.timeoutMs}ms`;\n}\n",
    "src/ops/cli-flags.ts": "import type { ServiceConfig } from \"../config/types.ts\";\n\nexport function parseFlags(argv: string[]): Partial<ServiceConfig> {\n  const out: Partial<ServiceConfig> = {};\n  for (const arg of argv) {\n    if (arg.startsWith(\"--max-retries=\")) out.maxRetries = Number(arg.slice(\"--max-retries=\".length));\n    if (arg.startsWith(\"--timeout=\")) out.timeoutMs = Number(arg.slice(\"--timeout=\".length));\n  }\n  return out;\n}\n",
    "src/index.ts": "export { loadConfig } from \"./config/load-config.ts\";\nexport { withRetries } from \"./net/retry-executor.ts\";\nexport { attemptBudget } from \"./net/attempt-budget.ts\";\nexport { describeConfig } from \"./ops/health-report.ts\";\nexport { parseFlags } from \"./ops/cli-flags.ts\";\nexport type { ServiceConfig } from \"./config/types.ts\";\n",
    "README.md": "# fleet-control\n\nService configuration is defined in src/config and consumed across src/net and src/ops.\n",
  };
  Object.assign(fixture, noiseTree("src/modules", 1180, "ts", 1207));
  return fixture;
})(), {
  "verify.ts": `import fs from "node:fs";\nimport path from "node:path";\nimport { loadConfig, attemptBudget, describeConfig, parseFlags, withRetries } from "../src/index.ts";\n${verifierJs("", 'const config = loadConfig({ retryLimit: 4 } as any);\ncheck("loads-new-key", (config as any).retryLimit === 4);\ncheck("old-key-gone-from-object", !("maxRetries" in (config as any)));\ncheck("default-preserved", (loadConfig() as any).retryLimit === 3);\ncheck("validation-renamed", (() => { try { loadConfig({ retryLimit: -1 } as any); return false; } catch (error) { return String((error as Error).message).includes("retryLimit"); } })());\ncheck("attempt-budget", attemptBudget(config) === 5);\ncheck("describe", describeConfig(config).includes("retries=4"));\ncheck("flags", (parseFlags(["--max-retries=2"]) as any).retryLimit === 2);\nlet calls = 0;\nconst value = await withRetries(loadConfig({ retryLimit: 2 } as any), async () => { calls += 1; if (calls < 3) throw new Error("flaky"); return "ok"; });\ncheck("retries-honoured", value === "ok" && calls === 3);\nconst walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);\nconst offenders = walk("src").filter((file) => fs.readFileSync(file, "utf8").includes("maxRetries"));\ncheck("no-maxRetries-under-src", offenders.length === 0);\nif (offenders.length > 0) console.error("still references maxRetries: " + offenders.join(", "));').replace(/^\n/, "")}`,
});

// ---------------------------------------------------------------------------------------------
// Write everything deterministically (sorted paths, LF line endings, UTF-8).
// ---------------------------------------------------------------------------------------------
fs.rmSync(TASKS_ROOT, { recursive: true, force: true });
const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [relative, content] of sorted) {
  const target = path.join(TASKS_ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: "utf8" });
}
const taskIds = [...new Set(sorted.map(([relative]) => relative.split("/")[0]))];
console.log(`wrote ${sorted.length} files across ${taskIds.length} tasks to ${TASKS_ROOT}`);
for (const id of taskIds) console.log(`  ${id}`);
