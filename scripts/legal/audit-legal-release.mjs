#!/usr/bin/env node
// R1 legal remediation (§48): deterministic pre-release legal/compliance gate. Verifies OBJECTIVE
// ENGINEERING FACTS only — it never encodes disputed legal interpretation, never certifies
// "CodeForge is legally compliant", and never activates anything. See docs/legal/remediation/
// r1-remediation-report.md for what this milestone did and did not resolve.
//
// Usage:
//   node scripts/legal/audit-legal-release.mjs --mode=<INTERNAL|DESKTOP_BYOK_BETA|HOSTED_FREE_BETA>
//
// A blocker for one launch mode must not block another (R1 spec §63) — e.g. HOSTED_FREE_BETA's
// unresolved OpenRouter agreement must never block a DESKTOP_BYOK_BETA release.
//
// Exit code: 1 if any applicable check is FAIL (a real engineering defect). BLOCKED /
// BLOCKED_BUSINESS_DECISION / BLOCKED_COUNSEL do NOT fail the process exit — they are known,
// already-disclosed blockers on ACTUAL PUBLIC RELEASE that a human owner must clear separately
// (see docs/legal/remediation/r1-issue-disposition.md), not something this script can fix, and
// engineering CI for unrelated changes must not be halted by them.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const MODE = modeArg ? modeArg.slice("--mode=".length) : "DESKTOP_BYOK_BETA";
const VALID_MODES = ["INTERNAL", "DESKTOP_BYOK_BETA", "HOSTED_FREE_BETA"];
if (!VALID_MODES.includes(MODE)) {
  console.error(`Unknown --mode=${MODE}. Valid: ${VALID_MODES.join(", ")}`);
  process.exit(2);
}
const ALL_MODES = VALID_MODES;
const PUBLIC_MODES = ["DESKTOP_BYOK_BETA", "HOSTED_FREE_BETA"];

function pathToFileUrl(p) {
  return "file:///" + p.replace(/\\/g, "/");
}
async function loadBuiltPackage(name) {
  const distIndex = join(REPO_ROOT, "packages", name, "dist", "index.js");
  if (!existsSync(distIndex)) {
    throw new Error(`packages/${name} is not built — run \`npm run build --workspace=@codeforge/${name}\` first`);
  }
  return import(pathToFileUrl(distIndex));
}

async function main() {
  // Resolve both packages ONCE, up front — every check below reads from these already-settled
  // module objects rather than calling import() (a Promise) inline, which a synchronous check
  // function cannot correctly await.
  let legalPolicy = null;
  let legalPolicyError = null;
  try {
    legalPolicy = await loadBuiltPackage("legal-policy");
  } catch (error) {
    legalPolicyError = error instanceof Error ? error.message : String(error);
  }
  let secrets = null;
  let secretsError = null;
  try {
    secrets = await loadBuiltPackage("secrets");
  } catch (error) {
    secretsError = error instanceof Error ? error.message : String(error);
  }

  const results = [];
  function report(id, applicableModes, fn) {
    if (!applicableModes.includes(MODE)) {
      results.push({ id, status: "NOT_APPLICABLE", detail: `not required for ${MODE}` });
      return;
    }
    try {
      results.push({ id, ...fn() });
    } catch (error) {
      results.push({ id, status: "FAIL", detail: `check threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  report("ROOT_LICENSE_POLICY", PUBLIC_MODES, () => {
    const hasLicense = existsSync(join(REPO_ROOT, "LICENSE"));
    const hasPending = existsSync(join(REPO_ROOT, "LICENSE.pending"));
    if (hasLicense) return { status: "PASS", detail: "LICENSE exists" };
    if (hasPending) return { status: "BLOCKED_BUSINESS_DECISION", detail: "LICENSE.pending exists; awaiting confirmed copyright holder (BIZ-01)" };
    return { status: "FAIL", detail: "Neither LICENSE nor LICENSE.pending exists at repo root" };
  });

  report("PACKAGE_LICENSE_METADATA", ALL_MODES, () => {
    try {
      execSync("node scripts/legal/normalize-package-licenses.mjs --check", { cwd: REPO_ROOT, stdio: "pipe" });
      return { status: "PASS", detail: "every workspace package.json declares a license" };
    } catch (error) {
      return { status: "FAIL", detail: error.stdout?.toString().trim() || String(error) };
    }
  });

  report("VSCODE_PUBLISH_READINESS", ALL_MODES, () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "vscode", "package.json"), "utf8"));
    if (pkg.private !== true) return { status: "FAIL", detail: "packages/vscode/package.json is not private:true — a stray `npm publish` is not fail-closed" };
    if (!pkg.license) return { status: "FAIL", detail: "packages/vscode/package.json has no license field" };
    return { status: "PASS", detail: "private:true blocks accidental publish; license metadata present" };
  });

  report("THIRD_PARTY_NOTICES", PUBLIC_MODES, () => {
    const jsonPath = join(REPO_ROOT, "docs", "legal", "remediation", "third-party-notices-generated.json");
    if (!existsSync(jsonPath)) return { status: "FAIL", detail: "third-party-notices-generated.json missing — run scripts/legal/generate-third-party-notices.mjs" };
    const data = JSON.parse(readFileSync(jsonPath, "utf8"));
    const unknown = (data.entries ?? []).filter((e) => e.reviewRequired);
    if (unknown.length > 0) return { status: "FAIL", detail: `${unknown.length} package(s) with UNKNOWN license: ${unknown.map((e) => e.name).join(", ")}` };
    return { status: "PASS", detail: `${data.entries?.length ?? 0} third-party packages, 0 UNKNOWN licenses (generated ${data.generatedAt})` };
  });

  report("PROVIDER_POLICY_FRESHNESS", PUBLIC_MODES, () => {
    if (!legalPolicy) return { status: "FAIL", detail: legalPolicyError };
    const now = Date.now();
    const expired = legalPolicy.PROVIDER_POLICY_REGISTRY.filter((r) => r.expiresAt && new Date(r.expiresAt).getTime() < now);
    if (expired.length > 0) {
      return {
        status: "BLOCKED",
        detail: `${expired.length} provider policy record(s) past review horizon: ${expired.map((r) => `${r.providerId}/${r.architecture}/${r.serviceTier}`).join(", ")} — re-review against current provider ToS`,
      };
    }
    return { status: "PASS", detail: `all ${legalPolicy.PROVIDER_POLICY_REGISTRY.length} provider policy records within review horizon` };
  });

  report("NO_RESTRICTED_HOSTED_ROUTE_ENABLED", ["HOSTED_FREE_BETA"], () => {
    if (!legalPolicy) return { status: "FAIL", detail: legalPolicyError };
    const denied = [];
    for (const record of legalPolicy.PROVIDER_POLICY_REGISTRY) {
      if (record.architecture !== "HOSTED_MULTI_TENANT") continue;
      if (record.hostedResaleStatus === "RESTRICTED" || record.hostedResaleStatus === "AGREEMENT_REQUIRED") {
        const decision = legalPolicy.evaluateRouteEligibility({
          providerId: record.providerId,
          architecture: record.architecture,
          serviceTier: record.serviceTier,
          region: legalPolicy.REGION_UNKNOWN,
        });
        if (decision.decision !== "DENY") {
          return { status: "FAIL", detail: `${record.providerId}/${record.serviceTier} has hostedResaleStatus=${record.hostedResaleStatus} but is not DENY with no enterprise override — policy gate is not enforcing` };
        }
        denied.push(record.providerId);
      }
    }
    return { status: "PASS", detail: `restricted hosted routes correctly deny by default: ${denied.join(", ") || "none registered"}` };
  });

  report("CLAIMS_REGRESSION_SCAN", ALL_MODES, () => {
    if (!legalPolicy) return { status: "FAIL", detail: legalPolicyError };
    const targets = [
      { path: "README.md", context: "PUBLIC_MARKETING" },
      { path: "SECURITY.md", context: "PUBLIC_MARKETING" },
      { path: "CONTRIBUTING.md", context: "PUBLIC_MARKETING" },
    ];
    const hits = [];
    for (const t of targets) {
      const full = join(REPO_ROOT, t.path);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, "utf8");
      hits.push(...legalPolicy.blockingClaimHits(legalPolicy.scanTextForClaims(t.path, content, t.context)));
    }
    if (hits.length > 0) {
      return { status: "FAIL", detail: hits.map((h) => `${h.file}:${h.line} "${h.matchedText}" (${h.patternId})`).join("; ") };
    }
    return { status: "PASS", detail: `scanned ${targets.filter((t) => existsSync(join(REPO_ROOT, t.path))).length} public file(s), 0 unsupported claims` };
  });

  report("AGE_POLICY_INFRASTRUCTURE", PUBLIC_MODES, () => {
    if (!legalPolicy) return { status: "FAIL", detail: legalPolicyError };
    if (legalPolicy.DEFAULT_AGE_POLICY.status !== "BUSINESS_DECISION_REQUIRED") {
      return { status: "FAIL", detail: "DEFAULT_AGE_POLICY.status changed unexpectedly — should remain BUSINESS_DECISION_REQUIRED until explicitly approved" };
    }
    return { status: "BLOCKED_BUSINESS_DECISION", detail: "age-policy infrastructure present (recommendedMinimumAge=18); formal policy-of-record activation pending owner approval (BIZ-04)" };
  });

  report("LEGAL_VERSION_INFRASTRUCTURE", PUBLIC_MODES, () => {
    if (!legalPolicy) return { status: "FAIL", detail: legalPolicyError };
    const active = legalPolicy.LEGAL_DOCUMENT_REGISTRY.filter((d) => d.status === "ACTIVE");
    if (active.length > 0) {
      return { status: "FAIL", detail: "a legal document is marked ACTIVE in source — R1 must not activate draft terms; this indicates an unauthorized change" };
    }
    return { status: "BLOCKED_COUNSEL", detail: `${legalPolicy.LEGAL_DOCUMENT_REGISTRY.length} document(s) registered, all DRAFT as intended; publication requires counsel/business authorization` };
  });

  report("SECRET_SCAN", ALL_MODES, () => {
    if (!secrets) return { status: "FAIL", detail: secretsError };
    // .env.example is deliberately excluded: it is a template whose entire purpose is documenting
    // variable NAMES with empty/placeholder values (verified by hand for this repo's file), and
    // @codeforge/secrets' pattern-based scanner — by design, matching KEY=value shapes to redact
    // from LLM context — cannot distinguish "OPENROUTER_API_KEY=" (empty, followed by a comment)
    // from a real assignment. Scanning it only produces noise, not signal.
    const targets = ["README.md", "SECURITY.md", "CONTRIBUTING.md"];
    const hits = [];
    for (const rel of targets) {
      const full = join(REPO_ROOT, rel);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, "utf8");
      for (const m of new secrets.SecretScanner().scan(content)) hits.push({ file: rel, ...m });
    }
    if (hits.length > 0) {
      return { status: "FAIL", detail: `possible secret(s) found: ${hits.map((h) => `${h.file}:${h.line} (${h.type})`).join("; ")}` };
    }
    return { status: "PASS", detail: `scanned ${targets.filter((t) => existsSync(join(REPO_ROOT, t))).length} top-level file(s), 0 matches` };
  });

  console.log(`\nCodeForge Legal Release Gate — mode=${MODE}\n${"=".repeat(60)}`);
  let hasFailure = false;
  for (const r of results) {
    if (r.status === "FAIL") hasFailure = true;
    const marker = { PASS: "✓", FAIL: "✗", BLOCKED: "⏸", BLOCKED_BUSINESS_DECISION: "⏸", BLOCKED_COUNSEL: "⏸", NOT_APPLICABLE: "·" }[r.status] ?? "?";
    console.log(`[${marker}] ${r.id}: ${r.status}`);
    if (r.detail) console.log(`      ${r.detail}`);
  }
  console.log(`${"=".repeat(60)}`);
  const blocked = results.filter((r) => r.status.startsWith("BLOCKED"));
  if (blocked.length > 0) {
    console.log(`${blocked.length} check(s) BLOCKED on business/counsel decisions already tracked in docs/legal/remediation/r1-issue-disposition.md — not an engineering failure.`);
  }
  if (hasFailure) {
    console.error("RELEASE GATE: FAIL — one or more objective engineering checks failed.");
    process.exitCode = 1;
    return;
  }
  console.log("RELEASE GATE: engineering checks PASS (business/counsel blockers, if any, are listed above).");
}

main();
