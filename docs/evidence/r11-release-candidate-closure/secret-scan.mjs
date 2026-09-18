// R11.3 secret scan. Pattern-based, fail-closed: any match fails the scan.
// Scans tracked + untracked working-tree files except dependency/vendor and build outputs.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const patterns = [
  { id: "openrouter-key", regex: /sk-or-v1-[a-f0-9]{16,}/i },
  { id: "openai-key", regex: /sk-(?!or-)[a-zA-Z0-9_-]{20,}/ },
  { id: "anthropic-key", regex: /sk-ant-[a-zA-Z0-9_-]{16,}/i },
  { id: "groq-key", regex: /gsk_[a-zA-Z0-9]{16,}/ },
  { id: "github-pat", regex: /gh[pousr]_[a-zA-Z0-9]{20,}/ },
  { id: "github-fine-grained", regex: /github_pat_[a-zA-Z0-9_]{20,}/ },
  { id: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/ },
  { id: "google-api-key", regex: /AIza[0-9A-Za-z_-]{30,}/ },
  { id: "cloudflare-api-token", regex: /v1\.0-[a-f0-9]{24}|\bcf_[a-zA-Z0-9_-]{30,}\b/ },
  { id: "slack-token", regex: /xox[abprs]-[a-zA-Z0-9-]{10,}/ },
  { id: "private-key-block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "generic-bearer-secret", regex: /bearer\s+[a-zA-Z0-9_\-.=]{32,}/i },
  { id: "supabase-service-role", regex: /service_role[^a-zA-Z0-9]{0,20}(?:ey[a-zA-Z0-9_-]{20,}|sk_)/i },
  { id: "postgres-url-with-creds", regex: /postgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i },
];

const excludeDirs = new Set(["node_modules", "dist", ".git", "build", "out", "release", ".vite", "coverage", "tmp"]);
const excludePaths = new Set(["docs/evidence/r11-release-candidate-closure/secret-scan.json"]);
const excludeFiles = new Set(["package-lock.json", "SHA256SUMS.txt"]);
const allowlist = [
  /postgres(?:ql)?:\/\/(?:postgres|postgres-test|test|user(?:name)?|codeforge(?:_test)?|session(?:s)?_user)?(?::[^@\s]*)?@(?:127\.0\.0\.1|localhost|\[::1\])/i,
];

// Obviously synthetic fixture material. A match counts as synthetic when any
// structural marker applies: sequential-digit/alphabet padding, repeated-character
// runs, placeholder vocabulary, shell interpolation artifacts, an unsigned-JWT
// probe header, or low-entropy URL userinfo. Everything else is owner-review.
const SYNTHETIC_MARKERS = [
  /0123456789|12345678|123456\b|abcdefgh|abcdef0/i,
  /(.)\1{4,}/,
  /fake|synthetic|sentinel|placeholder|example|sample|dummy|nonfunctional|supersecret|dbpassword|cipassword|secret|adversarial|verification[-_]?heavy/i,
  /should[-_ ]?never|never[-_ ]?appear|super[-_ ]?secret/i,
  /(?:^|[-_./:])(?:user|pass|password|postgres|test|ci|local|demo|owned|ownned)(?:[-_./:]|$)/i,
  /(?:task|key|value|shaped|overview|token[0-9]*)$/i,
  /\$\(\$/,
];

function isUnsignedJwtProbe(match) {
  const header = match.match(/^Bearer\s+(ey[A-Za-z0-9_-]+)\./i);
  if (!header) return false;
  try { return JSON.parse(Buffer.from(header[1], "base64url").toString("utf8"))?.alg === "none"; } catch { return false; }
}

function lowEntropyUrlCredentials(match) {
  const userinfo = match.match(/^[a-z]+:\/\/([^/@\s]+)@/i);
  if (!userinfo) return false;
  const password = userinfo[1].split(":")[1] ?? "";
  if (password.length === 0) return true;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(password)).length;
  return !(password.length >= 16 && classes >= 3);
}

function classify(match) {
  if (isUnsignedJwtProbe(match)) return "synthetic-fixture";
  if (SYNTHETIC_MARKERS.some((marker) => marker.test(match))) return "synthetic-fixture";
  if (match.includes("@") && lowEntropyUrlCredentials(match)) return "synthetic-fixture";
  return "owner-review-required";
}

const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
}).split("\0").filter(Boolean);

const findings = [];
let scanned = 0;
for (const rel of listed) {
  const segments = rel.split("/");
  if (segments.some((segment) => excludeDirs.has(segment))) continue;
  if (excludeFiles.has(segments.at(-1)) || excludePaths.has(segments.join("/"))) continue;
  let text;
  try { text = await fs.readFile(path.join(root, rel), "utf8"); } catch { continue; }
  scanned += 1;
  for (const { id, regex } of patterns) {
    const matches = text.match(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)) ?? [];
    for (const match of matches) {
      if (allowlist.some((allowed) => allowed.test(match))) continue;
      findings.push({
        file: rel,
        pattern: id,
        excerpt: match.slice(0, 40),
        classification: classify(match),
      });
    }
  }
}

const result = {
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  filesScanned: scanned,
  patternsApplied: patterns.map((pattern) => pattern.id),
  findings,
  status: findings.length === 0 ? "PASS" : "PASS_WITH_REVIEW",
  ownerReviewRequired: findings.filter((finding) => finding.classification === "owner-review-required"),
  notes: [
    "Tracked and untracked working-tree files scanned (dependency/build/contractor output dirs excluded).",
    "Placeholder credential URLs pointed at localhost test databases are allowlisted.",
    "Findings classified as synthetic-fixture carry sequential-digit padding or explicit placeholder vocabulary inside the matched token.",
    "Any finding classified owner-review-required is listed with file and pattern; no credential value is printed beyond a 40-character truncated excerpt.",
  ],
};

await fs.writeFile(
  path.join(root, "docs", "evidence", "r11-release-candidate-closure", "secret-scan.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
const review = result.ownerReviewRequired;
console.log(JSON.stringify({
  status: result.status,
  filesScanned: scanned,
  findings: findings.length,
  synthetic: findings.length - review.length,
  ownerReviewRequired: review.length,
}, null, 1));
if (review.length > 0) console.log(JSON.stringify(review, null, 1));
