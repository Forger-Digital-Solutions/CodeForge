#!/usr/bin/env node
/**
 * Repository secret scan (Security R1, Phase 29).
 *
 * Scans every tracked and untracked-but-not-ignored file for credential-shaped content using the
 * same patterns the runtime redactor uses (@codeforge/secrets), plus a few repository-only
 * shapes. Findings never include the matched value — only path, line, and pattern type.
 *
 * Suppression: obviously synthetic fixtures (test/fixture directories, CF_TEST_SECRET_DO_NOT_USE
 * markers, documented placeholders) are classified `synthetic`. Anything else is
 * `owner-review-required` and fails the gate (exit 2). An allowlist file lets a reviewed
 * false positive be pinned by path + pattern without weakening the scanner globally.
 *
 *   node scripts/security/secret-scan.mjs [--json <out>] [--allowlist scripts/security/secret-scan-allowlist.json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "docs/evidence/security-r1/secret-scan.json";
const allowlistPath = args.includes("--allowlist") ? args[args.indexOf("--allowlist") + 1] : "scripts/security/secret-scan-allowlist.json";

const { SecretScanner } = await import("@codeforge/secrets");

const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "release", "coverage", "tmp", "out", "build", ".vite", ".audit-worktree-initial", "evidence"]);
const BINARY_EXTENSIONS = /\.(png|jpg|jpeg|gif|ico|icns|woff2?|ttf|eot|pdf|zip|gz|tgz|7z|exe|dll|node|db|sqlite|asar|wasm|mp4|mp3|bin)$/i;
const SYNTHETIC_MARKERS = /(CF_TEST_SECRET_DO_NOT_USE|SYNTHETIC|PLACEHOLDER|REDACTED|mock_|_mock|fixture|example\.com|whsec_mock|sk_test_mock|codeforge-ci-throwaway|codeforge_ci\b|USER:PASSWORD@HOST|user:pass@host|do-not-index|DO_NOT_USE|eyJhbGciOiJub25lIn0|\$\{\{\s*secrets\.)/i;
const SYNTHETIC_PATH = /(^|[\\/])(test|tests|__tests__|fixtures|fixture|__fixtures__|evidence|scratch)([\\/]|$)|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/i;

// Repository-only shapes (the runtime redactor is tuned for logs; these are tuned for source).
const REPO_PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g, type: "private_key_block" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, type: "github_token" },
  { re: /\bsk-or-v1-[a-f0-9]{64}\b/g, type: "openrouter_key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, type: "aws_access_key_id" },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, type: "stripe_live_key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, type: "slack_token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, type: "google_api_key" },
  { re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/gi, type: "postgres_credentials_url" },
];

function listFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.split(/[\\/]/).some((segment) => EXCLUDED_SEGMENTS.has(segment)))
    .filter((file) => !BINARY_EXTENSIONS.test(file))
    .filter((file) => !file.endsWith("package-lock.json"));
}

async function loadAllowlist() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.resolve(root, allowlistPath), "utf8"));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function isAllowlisted(allowlist, finding) {
  return allowlist.some((entry) => entry.path === finding.path && (entry.type === "*" || entry.type === finding.type));
}

function classify(relativePath, line, type) {
  if (SYNTHETIC_PATH.test(relativePath)) return "synthetic";
  if (SYNTHETIC_MARKERS.test(line)) return "synthetic";
  // Pattern definitions and redaction code legitimately contain the shapes they detect.
  if (/(SECRET_PATTERNS|REPO_PATTERNS|new RegExp|RegExp\(|\bre:\s*\/|redact|containsSecret|type: "|pattern:|\.replace\(\/)/.test(line)) return "synthetic";
  if (/\.(md|txt)$/i.test(relativePath) && /`[^`]*`/.test(line) && /(example|placeholder|\.\.\.|<[^>]+>)/i.test(line)) return "synthetic";
  if (type === "credential_field" && /(:\s*(string|number|boolean|unknown|undefined)\b|\binterface\b|\btype\b|\bimport\b|\bexport\b|\?\.|\bz\.)/.test(line)) return "synthetic";
  if (type === "credential_field" && !/["'`][A-Za-z0-9._~+/-]{16,}["'`]/.test(line)) return "synthetic";
  if (type === "password" && /(process\.env|POSTGRES_PASSWORD|\$\{|\bpassword:\s*(string|z\.)|"password"|'password')/i.test(line)) return "synthetic";
  if (type === "bearer" && /(\$\{|Bearer\s+\$|`Bearer|Bearer \${|"Bearer "|'Bearer ')/.test(line)) return "synthetic";
  if ((type === "postgres_uri" || type === "postgres_credentials_url") && /(localhost|127\.0\.0\.1|codeforge_test|postgrespassword|cipassword|@host|@HOST|USER:PASSWORD|user:pass)/i.test(line)) return "synthetic";
  if (type === "sk_key" && /sk-[a-z]+-?\*|sk-\.\.\.|sk-xxx|sk-or-v1-\*|sk-proj-\*/i.test(line)) return "synthetic";
  // A connection-string scheme without embedded credentials is documentation, not a secret.
  if ((type === "postgres_uri" || type === "mongodb_uri") && !/:\/\/[^:\s/]+:[^@\s]+@/.test(line)) return "synthetic";
  // "Bearer tokens" / "Bearer API key": prose, not a credential (real tokens are long and mixed-case/digits).
  if (type === "bearer") {
    const token = /Bearer\s+([A-Za-z0-9._-]+)/.exec(line)?.[1] ?? "";
    if (token.length < 20 || !/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return "synthetic";
  }
  // ENV_NAME = process.env.X / undefined / a variable reference — no literal value present.
  if (type.endsWith("_env") && /(process\.env|undefined|\$\{|\bz\.|\bstring\b|<[^>]+>|\.\.\.)/.test(line)) return "synthetic";
  // KEY=            (empty), KEY=...   (elided), KEY=$VAR / KEY=<value>: documentation of a name, not a value.
  if (/^(openrouter_key|groq_key_env|opencode_key|anthropic_key|cloudflare_token|google_api_env|aws_access_key_env|aws_secret_env)$/.test(type)) {
    const value = /_(?:KEY|TOKEN|ID)\s*[:=]\s*['"]?([^'"\s]*)/i.exec(line)?.[1] ?? "";
    if (value === "" || value === "#" || /^(\.\.\.|\$|<|\{|\*|x{3,}|your[-_]|none$|null$|unset$)/i.test(value) || /^[A-Za-z0-9_-]{0,7}$/.test(value)) return "synthetic";
  }
  // A cookie header carries name=value pairs; an assignment or prose mention does not.
  if (type === "cookie_header" && !/cookie\s*[:=]\s*[^\n]*\b[\w-]+=[^;\s]{8,}/i.test(line)) return "synthetic";
  if (type === "cookie_header" && /\b(const|let|var)\s+cookie\b|cookie\s*=\s*(this\.|result\.|await\s|req\.|res\.|[A-Za-z_$][\w$]*\()/.test(line)) return "synthetic";
  // password=secret / password=changeme style placeholders in documentation.
  if (type === "password" && /password\s*[:=]\s*['"`]?(secret|password|changeme|hunter2|xxx+|\*+|<[^>]+>|\.\.\.|\$[A-Z_{]|redacted)/i.test(line)) return "synthetic";
  return "owner-review-required";
}

const scanner = new SecretScanner();
const allowlist = await loadAllowlist();

function scanContents(relativePath, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/);
  const seen = new Set();
  const record = (lineNumber, type) => {
    const key = `${lineNumber}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = lines[lineNumber - 1] ?? "";
    const finding = { path: relativePath, line: lineNumber, type, classification: classify(relativePath, line, type) };
    if (finding.classification === "owner-review-required" && isAllowlisted(allowlist, finding)) finding.classification = "allowlisted";
    found.push(finding);
  };
  for (const match of scanner.scan(contents)) record(match.line, match.type);
  for (const { re, type } of REPO_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(contents)) !== null) {
      record(contents.slice(0, m.index).split("\n").length, type);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return found;
}

// --self-test: prove the gate detects realistic (still fake) credential shapes in a non-test path
// and does NOT flag documented placeholders. Runs before the repository scan in CI so a scanner
// regression that suppresses everything cannot report a hollow PASS.
if (args.includes("--self-test")) {
  const hex64 = "0123456789abcdef".repeat(4);
  const mustFlag = [
    ["apps/cloud-api/src/leak.ts", `const key = "sk-or-v1-${hex64}";`],
    ["packages/server/src/leak.ts", `const gh = "ghp_${"A1b2C3d4".repeat(5)}";`],
    ["scripts/leak.mjs", `const dsn = "postgresql://cf_user:Sup3rS3cretPassw0rd@db.example.internal:5432/codeforge";`],
    ["packages/x/src/key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow"],
  ];
  const mustNotFlag = [
    [".env.example", "# OPENROUTER_API_KEY=                      # gateway"],
    ["docs/deploy.md", "  OPENROUTER_API_KEY=... GROQ_API_KEY=... \\"],
    ["packages/ui/src/Header.tsx", '<span className="task-header-title">'],
    ["packages/cloud-db/src/database.ts", 'rawDbUrl.startsWith("postgres://")'],
  ];
  let ok = true;
  for (const [file, text] of mustFlag) {
    const hit = scanContents(file, text).some((f) => f.classification === "owner-review-required");
    if (!hit) { ok = false; console.error(`SELF-TEST FAIL: expected a finding for ${file}`); }
  }
  for (const [file, text] of mustNotFlag) {
    const hit = scanContents(file, text).some((f) => f.classification === "owner-review-required");
    if (hit) { ok = false; console.error(`SELF-TEST FAIL: unexpected finding for ${file}`); }
  }
  console.log(JSON.stringify({ selfTest: ok ? "PASS" : "FAIL" }));
  if (!ok) process.exit(3);
  if (!args.includes("--scan")) process.exit(0);
}

const findings = [];
let filesScanned = 0;

for (const relativePath of listFiles()) {
  let contents;
  try {
    contents = await fs.readFile(path.join(root, relativePath), "utf8");
  } catch {
    continue;
  }
  if (contents.includes("\u0000")) continue;
  filesScanned += 1;
  findings.push(...scanContents(relativePath, contents));
}

const ownerReviewRequired = findings.filter((f) => f.classification === "owner-review-required");
const result = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  filesScanned,
  totalFindings: findings.length,
  synthetic: findings.filter((f) => f.classification === "synthetic").length,
  allowlisted: findings.filter((f) => f.classification === "allowlisted").length,
  ownerReviewRequired,
  status: ownerReviewRequired.length === 0 ? "PASS" : "REVIEW_REQUIRED",
  policy: "Findings carry path, line and pattern type only; matched values are never emitted.",
};

await fs.mkdir(path.dirname(path.resolve(root, jsonOut)), { recursive: true });
await fs.writeFile(path.resolve(root, jsonOut), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: result.status, filesScanned, totalFindings: result.totalFindings, synthetic: result.synthetic, allowlisted: result.allowlisted, ownerReviewRequired: ownerReviewRequired.length, report: jsonOut }, null, 2));
for (const f of ownerReviewRequired) console.log(`  REVIEW ${f.path}:${f.line} (${f.type})`);
if (ownerReviewRequired.length > 0) process.exitCode = 2;
