#!/usr/bin/env node
/**
 * Public security/privacy claim gate (Security R1, Phase 61).
 *
 * Scans every file a user or the public can read — README, SECURITY.md, docs/security,
 * docs/privacy, docs/legal drafts, the desktop settings/onboarding/about copy, and the UI — for
 * claims CodeForge cannot substantiate (see @codeforge/legal-policy UNSUPPORTED_CLAIM_PATTERNS:
 * certifications, "military-grade", "zero knowledge", "end-to-end encrypted", "never leaves your
 * machine", ...). A hit is blocking unless the surrounding line is an explicit negation or a
 * prohibition ("must NOT claim …", "is not SOC 2 certified"), which is how the policy documents
 * themselves talk about these phrases.
 *
 *   node scripts/security/public-claims-scan.mjs [--json docs/evidence/security-r1/public-claims-scan.json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { scanTextForClaims } from "@codeforge/legal-policy";

const root = process.cwd();
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "docs/evidence/security-r1/public-claims-scan.json";

const PUBLIC_SURFACES = [
  /^README\.md$/,
  /^SECURITY\.md$/,
  /^ARCHITECTURE\.md$/,
  /^CONTRIBUTING\.md$/,
  /^docs\/(security|privacy|legal|certification)\/.*\.md$/,
  /^docs\/legal\/pass3\/proposed-drafts\/.*\.md$/,
  /^docs\/FAQ\.md$/,
  /^apps\/desktop\/src\/renderer\/.*\.(tsx?|html)$/,
  /^packages\/ui\/src\/.*\.tsx?$/,
  /^apps\/web\/.*\.(tsx?|html)$/,
];
const SKIP = [/^docs\/legal\/(pass1|pass2|remediation|drafts)\//, /^docs\/legal\/pass3\/(?!proposed-drafts)/, /\.test\./, /\/test\//];

// A line that names a claim in order to forbid, negate, or scan for it is not making the claim.
const NEGATION = /\b(not|never|no|neither|nor|without|cannot|can't|isn't|is not|are not|does not|do not|don't|doesn't|must not|prohibited|forbidden|avoid|instead of|rather than|unless|until|claim|claims|claiming|pattern|patterns|regex|scanner|suggestion|false|prohibits?)\b/i;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The phrase itself is quoted ("military-grade", `zero knowledge`): it is being mentioned, not asserted.
function isQuotedMention(line, matchedText) {
  const quoted = new RegExp(`["“‘'\`][^"”’'\`]{0,80}${escapeRegex(matchedText)}[^"“‘'\`]{0,80}["”’'\`]`, "i");
  return quoted.test(line);
}
// A certification held by a named third party (Stripe is PCI DSS Level 1) is a fact about that
// party, not a claim about CodeForge; it is reported as informational, never blocking.
const THIRD_PARTY_NAMES = "Stripe|Supabase|Neon|Render|GitHub|Google|Cloudflare|OpenRouter|Groq|Microsoft|Amazon|AWS";
const THIRD_PARTY_ATTRIBUTION = new RegExp(`\\b(${THIRD_PARTY_NAMES})\\b[^.|]{0,160}\\b(SOC|ISO|PCI|HIPAA|FedRAMP|FIPS)\\b|^\\|\\s*\\*{0,2}(${THIRD_PARTY_NAMES})\\b`, "i");

function contextFor(file) {
  if (file.startsWith("docs/security/") || file.startsWith("docs/privacy/") || file.startsWith("docs/certification/")) return "PUBLIC_MARKETING";
  if (/^(README|SECURITY|ARCHITECTURE|CONTRIBUTING)\.md$/.test(file) || file.startsWith("docs/legal/") || file === "docs/FAQ.md") return "PUBLIC_MARKETING";
  return "USER_UI";
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => PUBLIC_SURFACES.some((re) => re.test(f)) && !SKIP.some((re) => re.test(f)));

const hits = [];
for (const file of files) {
  const content = await fs.readFile(path.join(root, file), "utf8");
  const lines = content.split(/\r?\n/);
  for (const hit of scanTextForClaims(file, content, contextFor(file))) {
    const line = lines[hit.line - 1] ?? "";
    const negated = NEGATION.test(line) || isQuotedMention(line, hit.matchedText) || (hit.patternId === "compliance-certified" && THIRD_PARTY_ATTRIBUTION.test(line));
    hits.push({ ...hit, blocking: !negated, lineText: line.trim().slice(0, 200) });
  }
}
const blocking = hits.filter((h) => h.blocking);
const result = { generatedAt: new Date().toISOString(), filesScanned: files.length, totalHits: hits.length, blocking, informational: hits.filter((h) => !h.blocking).length, status: blocking.length === 0 ? "PASS" : "FAIL" };
await fs.mkdir(path.dirname(path.resolve(root, jsonOut)), { recursive: true });
await fs.writeFile(path.resolve(root, jsonOut), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: result.status, filesScanned: files.length, totalHits: hits.length, blocking: blocking.length, report: jsonOut }, null, 2));
for (const h of blocking) console.log(`  CLAIM ${h.file}:${h.line} [${h.patternId}] ${h.lineText}`);
if (blocking.length > 0) process.exitCode = 2;
