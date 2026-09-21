#!/usr/bin/env node
/**
 * R24 recovery snapshot (Phase 1, step 4): records repository truth plus every quota/catalog fact
 * that is readable WITHOUT sending inference — OpenRouter key allowance (`/api/v1/auth/key`), the
 * live OpenRouter `:free` catalog, the bundled provider catalog, the current probe-gate ledger,
 * and the R23 verdict lineage. Output: docs/evidence/r24-free-fabric/recovery/.
 *
 * Nothing here spends a free-model request or a Groq token. Groq's bucket state is only visible
 * on a completion response, so it is reported from the R23 ledger (last observed) and labelled
 * as such — never fabricated.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "evidence", "r24-free-fabric", "recovery");
fs.mkdirSync(OUT, { recursive: true });

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" }).trim();
}

const recordedAt = new Date().toISOString();
const repo = {
  branch: git("branch --show-current"),
  head: git("rev-parse HEAD"),
  headShort: git("rev-parse --short HEAD"),
  porcelain: git("status --porcelain=v1").split(/\r?\n/).filter(Boolean),
  staged: git("diff --cached --name-only").split(/\r?\n/).filter(Boolean),
  unstaged: git("diff --name-only").split(/\r?\n/).filter(Boolean),
  untracked: git("ls-files --others --exclude-standard").split(/\r?\n/).filter(Boolean),
  recentCommits: git("log --oneline -12").split(/\r?\n/),
};

const r23 = {
  verdictPath: "docs/evidence/r23-efficiency-proof/R23-VERDICT.md",
  protocol: { id: "codeforge-efficiency-protocol-r23", version: "1.0.6", digest: fs.readFileSync(path.join(ROOT, "docs/evidence/r23-efficiency-proof/protocol/PROTOCOL-DIGEST.txt"), "utf8").trim().split(/\r?\n/).slice(-3) },
  winner: null,
  verdicts: ["R23_CAPABILITY_BLOCKED (groq coder qualification)", "R23_SUPPLY_BLOCKED (nemotron/NVIDIA)", "R23_OWNER_ATTESTATION_REQUIRED (Cloudflare, Copilot)"],
};

// Probe-gate ledger (bench-side, R23) — the signal Mission A wires into 8-Bit.
const gatePath = path.join(ROOT, "docs/evidence/r23-efficiency-proof/supply/probe-gates.jsonl");
const gates = fs.existsSync(gatePath) ? fs.readFileSync(gatePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const gateSummary = {};
for (const gate of gates) {
  const key = `${gate.providerId}::${gate.modelId}`;
  const entry = (gateSummary[key] ??= { gates: 0, open: 0, closed: 0, lastVerdict: undefined, lastAt: undefined, probes: 0, served: 0 });
  entry.gates += 1;
  entry[gate.verdict] += 1;
  entry.probes += gate.n;
  entry.served += gate.served;
  entry.lastVerdict = gate.verdict;
  entry.lastAt = gate.recordedAt;
}

// Groq: last observed bucket facts from the R23 checkpoint (no request sent here).
const groqLastObserved = {
  source: "docs/checkpoints/R23-EFFICIENCY-PROOF-CHECKPOINT.md (Live capacity facts)",
  note: "Groq exposes bucket state only on completion responses; not re-probed by this snapshot.",
  perModelDailyTokens: 200_000,
  tpmWindow: 8_000,
  observedUsage: { "openai/gpt-oss-20b": "~119k of 200k served on 2026-09-21 (round 4–6)", "openai/gpt-oss-120b": "~170k of 200k served on 2026-09-21 (rounds 1–3), bucket exhausted" },
  refill: "continuous, cap/24h (measured F1/F10)",
};

async function openRouter(pathname, auth) {
  const headers = auth ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {};
  const response = await fetch(`https://openrouter.ai${pathname}`, { headers });
  if (!response.ok) return { error: `HTTP ${response.status}` };
  return response.json();
}

let openrouter = { skipped: "OPENROUTER_API_KEY unset" };
let orCatalog = { skipped: "network" };
if (process.env.OPENROUTER_API_KEY) {
  try {
    const key = (await openRouter("/api/v1/auth/key", true)).data ?? {};
    openrouter = {
      checkedAt: new Date().toISOString(),
      usage: key.usage,
      usageDaily: key.usage_daily,
      isFreeTier: key.is_free_tier,
      limit: key.limit,
      limitRemaining: key.limit_remaining,
      freeModelDailyRequests: key.free_model_daily_requests,
      rateLimit: key.rate_limit,
    };
  } catch (error) {
    openrouter = { error: String(error?.message ?? error) };
  }
}
try {
  const catalog = (await openRouter("/api/v1/models", false)).data ?? [];
  const free = catalog.filter((m) => m.id.endsWith(":free") && m.pricing?.prompt === "0" && m.pricing?.completion === "0");
  orCatalog = {
    checkedAt: new Date().toISOString(),
    totalModels: catalog.length,
    freeModels: free.length,
    freeToolCapable: free.filter((m) => (m.supported_parameters ?? []).includes("tools")).length,
    free: free.map((m) => ({ id: m.id, context: m.context_length, tools: (m.supported_parameters ?? []).includes("tools"), structured: (m.supported_parameters ?? []).includes("structured_outputs") || (m.supported_parameters ?? []).includes("response_format") })),
  };
} catch (error) {
  orCatalog = { error: String(error?.message ?? error) };
}

const credentialsPresent = Object.fromEntries(["OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "CEREBRAS_API_KEY", "OPENAI_API_KEY", "CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "CODEFORGE_TEST_POSTGRES_URL"].map((k) => [k, Boolean(process.env[k])]));

const snapshot = { recordedAt, repo, r23, probeGates: { ledger: path.relative(ROOT, gatePath), rows: gates.length, byRoute: gateSummary }, openrouter, openrouterFreeCatalog: orCatalog, groqLastObserved, credentialsPresent, moneyRule: "no inference sent by this snapshot; paid keys present in the environment are never used by R24 Free Fabric work" };
const outPath = path.join(OUT, `r24-recovery-snapshot-${recordedAt.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${path.relative(ROOT, outPath)}`);
console.log(JSON.stringify({ branch: repo.branch, head: repo.headShort, dirty: repo.porcelain.length, openrouter: openrouter.freeModelDailyRequests ?? openrouter, freeCatalog: { free: orCatalog.freeModels, tools: orCatalog.freeToolCapable }, probeGateRoutes: Object.keys(gateSummary).length }, null, 2));
