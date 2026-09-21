#!/usr/bin/env node
/**
 * R25 corpus delta generator (R25 campaign §15, §58-59). Deterministic: running it twice produces
 * byte-identical task directories, so the frozen manifest (manifest.json, sha256 per task) can
 * always be re-derived. Tasks are synthetic repositories authored for R25 — no CodeForge code, no
 * task text mentioning ForgeGreen/efficiency/tokens/benchmark, and the hidden verifier never
 * appears in the fixture tree.
 *
 * Adds the classes R23's 15-task corpus did not cover: tiny, ambiguous (location not given),
 * review_heavy (reviewer role, structured verdict), test_fix (verifier uses a mutation check —
 * the fixed test must still catch a deliberately-broken implementation). The r23 corpus remains
 * frozen under its own manifest; the R25 campaign runner consumes both.
 *
 *   node benchmarks/r25/generate-tasks.mjs            # writes benchmarks/r25/tasks/<task_id>/
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

const pkg = (name) => `${JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }, null, 2)}\n`;

/** Standard assertion scaffold for hidden verifiers (same shape as the r23 corpus). */
const CHECKS = `let passed = 0;
let failed = 0;
const check = (label, ok) => {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error("FAIL " + label);
  }
};
`;
const TALLY = `console.log(JSON.stringify({ passed, failed }));
process.exit(failed === 0 ? 0 : 1);
`;

// ---------------------------------------------------------------------------------------------
// Deterministic filler so medium repositories have realistic shape and search noise.
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
function fillerModuleJs(name, random, lines = 18) {
  const body = Array.from({ length: lines }, (_, index) => `export function ${name}${index}(input) {\n  // ${name}: step ${index} — bounded arithmetic used by the ${pick(random, WORDS)} pipeline\n  if (!Number.isFinite(input)) throw new Error("${name}: invalid input");\n  return input * ${index + 1} + ${lines - index};\n}`).join("\n\n");
  return `${body}\n`;
}
function fillerModuleTs(name, random, lines = 18) {
  const body = Array.from({ length: lines }, (_, index) => `export function ${name}${index}(input: number): number {\n  // ${name}: step ${index} — bounded arithmetic used by the ${pick(random, WORDS)} pipeline\n  if (!Number.isFinite(input)) throw new Error("${name}: invalid input");\n  return input * ${index + 1} + ${lines - index};\n}`).join("\n\n");
  return `${body}\n`;
}
/** Sprinkle `count` filler modules across `dirs`; deterministic by seed. */
function fill(taskId, dirs, count, seed, lang) {
  const random = seeded(seed);
  const make = lang === "ts" ? fillerModuleTs : fillerModuleJs;
  const ext = lang === "ts" ? "ts" : "js";
  for (let i = 0; i < count; i += 1) {
    const dir = pick(random, dirs);
    const name = `${pick(random, WORDS)}${pick(random, ["Core", "Store", "Index", "Sync", "Guard", "Writer", "Reader", "Policy"])}${i}`;
    put(taskId, `fixture/src/${dir}/${name}.${ext}`, make(name, random));
  }
}

// =============================================================================================
// tiny — one-line/local corrections
// =============================================================================================

task("r25-tiny-js-adult-check",
  {
    class: "tiny", language: "javascript", repoSizeClass: "small",
    goal: "The README says an account holder who is 18 or older counts as an adult, but isAdult(18) returns false. Fix it.",
    visibleVerification: ["node --check src/user.js"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
  },
  {
    "package.json": pkg("account-utils"),
    "README.md": "# account-utils\n\nSmall account helpers. `isAdult(age)` returns true when the holder is 18 or older.\n",
    "src/user.js": `export function isAdult(age) {
  return age > 18;
}

export function displayName(first, last) {
  return \`\${first} \${last}\`.trim();
}
`,
    "src/format.js": `export function pad2(n) {
  return String(n).padStart(2, "0");
}
`,
  },
  {
    "verify.mjs": `import { isAdult, displayName } from "../src/user.js";
${CHECKS}
check("isAdult(18)", isAdult(18) === true);
check("isAdult(17)", isAdult(17) === false);
check("isAdult(0)", isAdult(0) === false);
check("isAdult(65)", isAdult(65) === true);
check("displayName unchanged", displayName("Ada", "Lovelace") === "Ada Lovelace");
${TALLY}`,
  });

task("r25-tiny-ts-status-label",
  {
    class: "tiny", language: "typescript", repoSizeClass: "small",
    goal: "Jobs that have finished still show 'In progress' in the status column. Fix the label mapping so a finished job reads 'Done'.",
    visibleVerification: ["node --check src/status.ts"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
  },
  {
    "package.json": pkg("job-labels"),
    "README.md": "# job-labels\n\nMaps internal job statuses to display labels.\n",
    "src/status.ts": `export type Status = "queued" | "running" | "done" | "failed";

export function labelFor(status: Status): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "In progress";
    case "done":
      return "In progress";
    case "failed":
      return "Failed";
  }
}
`,
    "src/columns.ts": `export const COLUMNS = ["id", "label", "owner"] as const;
`,
  },
  {
    "verify.mjs": `import { labelFor } from "../src/status.ts";
${CHECKS}
check("done label", labelFor("done") === "Done");
check("queued label", labelFor("queued") === "Queued");
check("running label", labelFor("running") === "In progress");
check("failed label", labelFor("failed") === "Failed");
${TALLY}`,
  });

// =============================================================================================
// ambiguous — the symptom is given; the location is not
// =============================================================================================

{
  const id = "r25-ambiguous-js-checkout-discount";
  task(id,
    {
      class: "ambiguous", language: "javascript", repoSizeClass: "medium",
      goal: "Customers report that the loyalty code LOYAL10 is silently ignored when they check out with a single-item cart, even though it works on larger orders. Find and fix the bug.",
      visibleVerification: ["node --check src/checkout/discount.js"],
      verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
    },
    {
      "package.json": pkg("storefront"),
      "README.md": "# storefront\n\nCheckout, catalog, and order pipeline for a small store.\n",
      "src/checkout/cart.js": `export function makeCart(items) {
  return { items: items.slice(), code: null };
}

export function cartSubtotal(cart) {
  return cart.items.reduce((sum, item) => sum + item.price, 0);
}
`,
      "src/checkout/discount.js": `// Loyalty discount: LOYAL10 takes 10% off the subtotal.
export function discountFactor(cart, code) {
  if (cart.items.length > 1 && code === "LOYAL10") {
    return 0.9;
  }
  return 1;
}

export function applyDiscount(cart, code) {
  const factor = discountFactor(cart, code);
  return Math.round(cart.items.reduce((sum, item) => sum + item.price, 0) * factor * 100) / 100;
}
`,
      "src/checkout/total.js": `import { applyDiscount } from "./discount.js";

export function checkoutTotal(cart, code) {
  return applyDiscount(cart, code);
}
`,
    },
    {
      "verify.mjs": `import { makeCart } from "../src/checkout/cart.js";
import { discountFactor, applyDiscount } from "../src/checkout/discount.js";
${CHECKS}
const single = makeCart([{ price: 40 }]);
check("LOYAL10 single-item factor", discountFactor(single, "LOYAL10") === 0.9);
check("LOYAL10 single-item total", applyDiscount(single, "LOYAL10") === 36);
const multi = makeCart([{ price: 40 }, { price: 10 }]);
check("LOYAL10 multi-item total", applyDiscount(multi, "LOYAL10") === 45);
check("invalid code rejected", applyDiscount(single, "NOPE") === 40);
check("no code full price", applyDiscount(single, null) === 40);
${TALLY}`,
    });
  fill(id, ["catalog", "orders", "shipping"], 11, 0xa25, "js");
}

{
  const id = "r25-ambiguous-ts-session-clock";
  task(id,
    {
      class: "ambiguous", language: "typescript", repoSizeClass: "medium",
      goal: "Support tickets say active users are being signed out seconds after logging in, far before the configured session limit. Find and fix the bug.",
      visibleVerification: ["node --check src/auth/session.ts"],
      verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
    },
    {
      "package.json": pkg("sessiond"),
      "README.md": "# sessiond\n\nSession issuance and expiry for the app. Session TTLs are configured in seconds.\n",
      "src/auth/session.ts": `export interface Session {
  issuedAt: number;
  expiresAt: number;
}

// All timestamps are milliseconds since the epoch (Date.now()).
export function createSession(now: number, ttlSeconds: number): Session {
  return { issuedAt: now, expiresAt: now + ttlSeconds };
}

export function isExpired(session: Session, now: number): boolean {
  return now >= session.expiresAt;
}
`,
      "src/auth/token.ts": `export function tokenFor(sessionId: string): string {
  return "tok_" + sessionId;
}
`,
      "src/index.ts": `export { createSession, isExpired } from "./auth/session.ts";
`,
    },
    {
      "verify.mjs": `import { createSession, isExpired } from "../src/auth/session.ts";
${CHECKS}
const t0 = 1_800_000_000_000;
const session = createSession(t0, 3600);
check("fresh session not expired", isExpired(session, t0 + 1_000) === false);
check("30 min in still valid", isExpired(session, t0 + 1_800_000) === false);
check("1s before TTL still valid", isExpired(session, t0 + 3_599_000) === false);
check("at TTL expired", isExpired(session, t0 + 3_600_000) === true);
check("2h later expired", isExpired(session, t0 + 7_200_000) === true);
${TALLY}`,
    });
  fill(id, ["api", "jobs", "store"], 12, 0xb17, "ts");
}

// =============================================================================================
// review_heavy — reviewer role; the patch is already applied, the flaw is subtle
// =============================================================================================

task("r25-review-js-retry-storm",
  {
    role: "reviewer",
    structuredOutput: "reviewer",
    permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    class: "review_heavy", language: "javascript", repoSizeClass: "small",
    goal: "Review the proposed dispatcher retry change for merge readiness: the request is described in docs/REVIEW-REQUEST.md, the diff is in proposed.diff, and the post-change file is src/net/dispatcher.js. Report any blocking issues with file/line evidence; your summary must state the verdict and name each blocking defect.",
    visibleVerification: [],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
    answerKey: {
      mode: "regex",
      values: [
        "revision[_ ]?required|do not (merge|approve)|must not (merge|ship)|block",
        "unbounded|infinite|forever|never (stops|gives up|terminates)|no (upper )?(bound|limit|cap|max)|4\\d\\d|permanent|non-?retryable|backoff",
      ],
      caseInsensitive: true,
    },
  },
  {
    "package.json": pkg("webhook-dispatcher"),
    "README.md": "# webhook-dispatcher\n\nDelivers outbound webhooks for account events.\n",
    "docs/REVIEW-REQUEST.md": `# Review request

Change: "make outbound webhook delivery resilient to transient failures by retrying failed
deliveries" (see proposed.diff; post-change source is already applied at src/net/dispatcher.js).

Context: yesterday's incident — a single 503 from a partner endpoint dropped a delivery
permanently. The intent is to survive *transient* failures only; permanent errors must still
surface to the dead-letter queue so on-call is paged.
`,
    "proposed.diff": `--- a/src/net/dispatcher.js
+++ b/src/net/dispatcher.js
@@ -1,8 +1,9 @@
-export async function deliver(url, payload, fetchImpl = fetch) {
-  const response = await fetchImpl(url, {
-    method: "POST",
-    body: JSON.stringify(payload),
-    headers: { "content-type": "application/json" },
-  });
-  if (!response.ok) throw new Error(\`delivery failed: \${response.status}\`);
-  return response.status;
-}
+export async function deliver(url, payload, fetchImpl = fetch) {
+  let response;
+  while (true) {
+    response = await fetchImpl(url, {
+      method: "POST",
+      body: JSON.stringify(payload),
+      headers: { "content-type": "application/json" },
+    });
+    if (response.ok) return response.status;
+  }
+}
`,
    "src/net/dispatcher.js": `export async function deliver(url, payload, fetchImpl = fetch) {
  let response;
  while (true) {
    response = await fetchImpl(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
    if (response.ok) return response.status;
  }
}
`,
    "src/net/dead-letter.js": `export function routeToDeadLetter(delivery, cause) {
  return { delivery, cause, queuedAt: Date.now() };
}
`,
  },
  {
    "verify.mjs": `import fs from "node:fs";
${CHECKS}
const source = fs.readFileSync("src/net/dispatcher.js", "utf8");
check("read-only task left dispatcher intact", source.includes("while (true)"));
check("review request intact", fs.existsSync("docs/REVIEW-REQUEST.md"));
check("diff intact", fs.existsSync("proposed.diff"));
${TALLY}`,
  });

task("r25-review-ts-config-swallow",
  {
    role: "reviewer",
    structuredOutput: "reviewer",
    permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    class: "review_heavy", language: "typescript", repoSizeClass: "small",
    goal: "Review the proposed config-loading change for merge readiness: the request is described in docs/REVIEW-REQUEST.md, the diff is in proposed.diff, and the post-change file is src/config/load.ts. Report any blocking issues with file/line evidence; your summary must state the verdict and name each blocking defect.",
    visibleVerification: [],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
    answerKey: {
      mode: "regex",
      values: [
        "revision[_ ]?required|do not (merge|approve)|must not (merge|ship)|block",
        "silent|swallow|mask|empty|missing|required|fail[- ]?fast|contract",
      ],
      caseInsensitive: true,
    },
  },
  {
    "package.json": pkg("app-config"),
    "README.md": "# app-config\n\nStartup configuration loader.\n",
    "docs/REVIEW-REQUEST.md": `# Review request

Change: "stop the service crashing on a malformed config.json" (see proposed.diff; post-change
source is already applied at src/config/load.ts).

Contract (docs/CONFIG.md): a config that cannot be parsed or lacks required fields is a fatal
startup error — the operator must see *why*. Silently continuing with defaults has caused
production incidents before.
`,
    "docs/CONFIG.md": `# Config contract

- apiEndpoint (string, required)
- retries (number, required)
- Invalid or incomplete config must fail fast with the parse/validation error. Never substitute a
  partial or empty config.
`,
    "proposed.diff": `--- a/src/config/load.ts
+++ b/src/config/load.ts
@@ -10,6 +10,8 @@
 export function loadConfig(path: string): AppConfig {
-  const raw = fs.readFileSync(path, "utf8");
-  const parsed = JSON.parse(raw) as AppConfig;
-  if (typeof parsed.apiEndpoint !== "string" || typeof parsed.retries !== "number") {
-    throw new Error("config: missing required fields");
-  }
-  return parsed;
+  try {
+    const raw = fs.readFileSync(path, "utf8");
+    return JSON.parse(raw) as AppConfig;
+  } catch {
+    return {} as AppConfig;
+  }
 }
`,
    "src/config/load.ts": `import fs from "node:fs";

export interface AppConfig {
  apiEndpoint: string;
  retries: number;
}

export function loadConfig(path: string): AppConfig {
  try {
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return {} as AppConfig;
  }
}
`,
    "src/config/types.ts": `export type { AppConfig } from "./load.ts";
`,
  },
  {
    "verify.mjs": `import fs from "node:fs";
${CHECKS}
const source = fs.readFileSync("src/config/load.ts", "utf8");
check("read-only task left loader intact", source.includes("return {} as AppConfig"));
check("review request intact", fs.existsSync("docs/REVIEW-REQUEST.md"));
check("diff intact", fs.existsSync("proposed.diff"));
${TALLY}`,
  });

task("r25-review-js-test-weakened",
  {
    role: "reviewer",
    structuredOutput: "reviewer",
    permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
    class: "review_heavy", language: "javascript", repoSizeClass: "small",
    goal: "Review the proposed test fix for merge readiness: the request is described in docs/REVIEW-REQUEST.md, the diff is in proposed.diff, and the post-change test is test/cart.test.js. Report any blocking issues with file/line evidence; your summary must state the verdict and name each blocking defect.",
    visibleVerification: [],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
    answerKey: {
      mode: "regex",
      values: [
        "revision[_ ]?required|do not (merge|approve)|must not (merge|ship)|block",
        "assert|weaken|coverage|no longer (tests|verifies|checks)|removed|delet|meaningless|vacuous",
      ],
      caseInsensitive: true,
    },
  },
  {
    "package.json": pkg("cart-service"),
    "README.md": "# cart-service\n\nCart totals with tax.\n",
    "docs/REVIEW-REQUEST.md": `# Review request

Change: "stop the cart test flaking in CI" (see proposed.diff; post-change test is already
applied at test/cart.test.js).

Context: the suite went red after the tax-rate update last week. The implementation in
src/cart.js is confirmed correct by product — 8% tax is the intended behaviour.
`,
    "proposed.diff": `--- a/test/cart.test.js
+++ b/test/cart.test.js
@@ -1,7 +1,6 @@
 test("total applies 8% tax", () => {
-  assert.equal(cartTotal(100), 108);
-  assert.equal(cartTotal(250), 270);
+  assert.ok(cartTotal(100) > 0);
 });
`,
    "src/cart.js": `// Product-confirmed: tax rate is 8%.
export function cartTotal(subtotal) {
  return Math.round(subtotal * 108) / 100;
}
`,
    "test/cart.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/cart.js";

test("total applies tax", () => {
  assert.ok(cartTotal(100) > 0);
});
`,
  },
  {
    "verify.mjs": `import fs from "node:fs";
${CHECKS}
const test = fs.readFileSync("test/cart.test.js", "utf8");
check("read-only task left test intact", test.includes("assert.ok(cartTotal(100) > 0)"));
check("review request intact", fs.existsSync("docs/REVIEW-REQUEST.md"));
check("diff intact", fs.existsSync("proposed.diff"));
${TALLY}`,
  });

// =============================================================================================
// test_fix — repair the test, not the implementation; verifier mutation-checks the result
// =============================================================================================

task("r25-testfix-js-stale-expected",
  {
    class: "test_fix", language: "javascript", repoSizeClass: "small",
    goal: "The pricing suite fails after the tax-rate update. The implementation already matches docs/PRICING.md, so the stale test expectations are the bug. Update the tests to match the documented behaviour; do not change src/.",
    visibleVerification: ["node --test test/pricing.test.js"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 60000 },
  },
  {
    "package.json": pkg("pricing"),
    "README.md": "# pricing\n\nPricing rules. The documented contract lives in docs/PRICING.md.\n",
    "docs/PRICING.md": "# Pricing\n\n- Tax is 8% of the subtotal, rounded to cents.\n",
    "src/pricing.js": `// Tax rate is 8% (see docs/PRICING.md).
export function totalWithTax(subtotal) {
  return Math.round(subtotal * 108) / 100;
}
`,
    "test/pricing.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { totalWithTax } from "../src/pricing.js";

test("applies tax", () => {
  assert.equal(totalWithTax(100), 105);
  assert.equal(totalWithTax(250), 262.5);
});
`,
  },
  {
    "verify.mjs": `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
${CHECKS}
const src = fs.readFileSync("src/pricing.js", "utf8");
check("implementation untouched (8% rate kept)", src.includes("108") && !src.includes("105"));
const suite = spawnSync("node", ["--test", "test/pricing.test.js"], { encoding: "utf8", timeout: 30000 });
check("test suite passes", suite.status === 0);
// Mutation check: a repaired test must still catch a wrong implementation. Replace the module
// with a no-tax version in-place, run the suite, and require it to fail; then restore.
const original = fs.readFileSync("src/pricing.js", "utf8");
fs.writeFileSync("src/pricing.js", "export function totalWithTax(subtotal) { return subtotal; }\\n");
const mutated = spawnSync("node", ["--test", "test/pricing.test.js"], { encoding: "utf8", timeout: 30000 });
fs.writeFileSync("src/pricing.js", original);
check("test suite still detects a wrong implementation (mutation kill)", mutated.status !== 0);
${TALLY}`,
  });

task("r25-testfix-ts-unawaited",
  {
    class: "test_fix", language: "typescript", repoSizeClass: "small",
    goal: "The user-lookup test passes even when the lookup returns the wrong data — the promise is never awaited, so the assertion never runs. Fix the test so it actually verifies the result. The implementation in src/lookup.ts is correct; do not change it.",
    visibleVerification: ["node --test test/lookup.test.ts"],
    verifier: { command: "node hidden/verify.mjs", timeoutMs: 60000 },
  },
  {
    "package.json": pkg("user-lookup"),
    "README.md": "# user-lookup\n\nAsync user directory lookups.\n",
    "src/lookup.ts": `export interface User {
  id: number;
  name: string;
}

const USERS: Record<number, User> = {
  1: { id: 1, name: "Ada" },
  2: { id: 2, name: "Grace" },
};

export async function lookupUser(id: number): Promise<User> {
  const user = USERS[id];
  if (!user) throw new Error("unknown user " + id);
  return user;
}
`,
    "test/lookup.test.ts": `import test from "node:test";
import assert from "node:assert/strict";
import { lookupUser } from "../src/lookup.ts";

test("returns the user", () => {
  lookupUser(1).then((u) => assert.equal(u.name, "Ada"));
  lookupUser(2).then((u) => assert.equal(u.name, "Grace"));
});
`,
  },
  {
    "verify.mjs": `import { spawnSync } from "node:child_process";
import fs from "node:fs";
${CHECKS}
const testSource = fs.readFileSync("test/lookup.test.ts", "utf8");
check("test awaits or returns the promise", /await\\s+lookupUser|return\\s+lookupUser/.test(testSource));
const suite = spawnSync("node", ["--test", "test/lookup.test.ts"], { encoding: "utf8", timeout: 30000 });
check("test suite passes", suite.status === 0);
// Mutation check: the repaired test must catch a wrong implementation.
const original = fs.readFileSync("src/lookup.ts", "utf8");
const wrong = original.replace('name: "Ada"', 'name: "Mallory"');
fs.writeFileSync("src/lookup.ts", wrong);
const mutated = spawnSync("node", ["--test", "test/lookup.test.ts"], { encoding: "utf8", timeout: 30000 });
fs.writeFileSync("src/lookup.ts", original);
check("test suite still detects a wrong implementation (mutation kill)", mutated.status !== 0);
check("implementation restored", fs.readFileSync("src/lookup.ts", "utf8") === original);
${TALLY}`,
  });

// =============================================================================================
// investigation — explorer role, answer-key verified (adds to r23's single investigation task)
// =============================================================================================

{
  const id = "r25-investigate-js-retry-budget";
  task(id,
    {
      role: "explorer",
      permissions: { read: true, search: true, write: false, executeCommand: false, network: false },
      class: "investigation", language: "javascript", repoSizeClass: "medium",
      goal: "Queue consumers sometimes keep retrying deliveries far longer than the on-call team expects. Find where the maximum number of delivery attempts is decided in this codebase and report, in your final answer, the file path, the name of the constant or setting, and its current value.",
      visibleVerification: [],
      verifier: { command: "node hidden/verify.mjs", timeoutMs: 30000 },
      answerKey: {
        mode: "regex",
        values: ["consumer\\.js", "MAX_DELIVERY_ATTEMPTS", "\\b9\\b"],
        caseInsensitive: true,
      },
    },
    {
      "package.json": pkg("queue-workers"),
      "README.md": "# queue-workers\n\nQueue consumers, retry policies, and delivery bookkeeping.\n",
      "src/queue/consumer.js": `const MAX_DELIVERY_ATTEMPTS = 9;

export function shouldRetry(attempts) {
  return attempts < MAX_DELIVERY_ATTEMPTS;
}
`,
      "src/queue/schedule.js": `export function nextDelay(attempt) {
  return Math.min(1000 * 2 ** attempt, 60_000);
}
`,
    },
    {
      "verify.mjs": `import fs from "node:fs";
${CHECKS}
const source = fs.readFileSync("src/queue/consumer.js", "utf8");
check("read-only task left source intact", source.includes("const MAX_DELIVERY_ATTEMPTS = 9;"));
${TALLY}`,
    });
  fill(id, ["queue", "jobs", "net"], 11, 0xc41, "js");
}

// ---------------------------------------------------------------------------------------------
// Write the corpus. Deterministic ordering: Map insertion order is fixed by the calls above.
// ---------------------------------------------------------------------------------------------
for (const [relative, content] of files) {
  const target = path.join(TASKS_ROOT, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
console.log(`wrote ${files.size} files across ${new Set([...files.keys()].map((k) => k.split("/")[0])).size} tasks under ${TASKS_ROOT}`);
