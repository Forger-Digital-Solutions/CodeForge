// R47 §9: audit the qualified free role matrix per INDEPENDENT physical capacity pool.
// Reads the durable qualification store (no live provider calls) and maps every receipted
// route onto its managed quota domain, then reports role coverage per pool.
//
//   node scripts/r47-role-coverage-audit.mjs [out.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionPersistence } from "../packages/sessions/dist/index.js";
import { SqliteQualificationPersistence } from "../packages/eight-bit/dist/index.js";

const OUT = process.argv[2] ?? "docs/evidence/r47-16bit/R47-FREE-ROLE-COVERAGE.json";
const QUAL_DB = process.env.R47_QUAL_DB ?? path.join(os.tmpdir(), "r46-qualification.db");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ROLES = ["EXPLORER", "PLANNER", "CODER", "REVIEWER"];

const persistence = createSessionPersistence({ dbPath: QUAL_DB });
await persistence.init();
const store = new SqliteQualificationPersistence(persistence);
const receipts = await store.loadAll();
console.log(`receipts loaded: ${receipts.length} from ${QUAL_DB}`);

// Independent pools = distinct managed quota domains. The corpus registers one managed pool
// per provider credential (provider::live-acct-<provider>). Owner pools are dev-key supply,
// not fleet capacity, but are listed separately for completeness.
const managedPoolId = (providerId, modelId) => `managed:${providerId}:live-acct-${providerId}:model:${modelId}`;

const pools = new Map(); // poolId -> { providerId, models: Map<modelId, {state, roles:{role:status}, ageDays}> }
const stateRank = { QUALIFIED: 4, PROBATION: 3, NOT_QUALIFIED: 2, HARD_FAILURE: 1, QUOTA_EXHAUSTED: 0 };
const roleRank = { QUALIFIED: 3, PROBATION: 2, NOT_TESTED: 1, NOT_QUALIFIED: 0, HARD_FAILURE: 0 };

for (const r of receipts) {
  const poolId = managedPoolId(r.providerId, r.modelId);
  const ageDays = Math.round((Date.now() - new Date(r.completedAt).getTime()) / 86400_00) / 100;
  const stale = Date.now() - new Date(r.completedAt).getTime() > MAX_AGE_MS;
  const pool = pools.get(poolId) ?? { providerId: r.providerId, models: new Map() };
  const roles = {};
  for (const role of ROLES) {
    const rr = r.roleResults?.[role];
    roles[role] = stale ? "STALE" : (rr?.status ?? "UNTESTED");
  }
  pool.models.set(r.modelId, {
    state: stale ? "STALE" : r.qualificationState,
    suiteVersion: r.suiteVersion,
    ageDays,
    roles,
    hardFailureRoles: r.hardFailureRoles ?? [],
  });
  pools.set(poolId, pool);
}

// Per-pool role coverage: best status across the pool's models.
const matrix = [];
for (const [poolId, pool] of [...pools.entries()].sort()) {
  const coverage = {};
  for (const role of ROLES) {
    let best = "UNTESTED";
    for (const m of pool.models.values()) {
      const s = m.roles[role] ?? "UNTESTED";
      if ((roleRank[s] ?? -1) > (roleRank[best] ?? -1)) best = s;
    }
    coverage[role] = best;
  }
  matrix.push({ poolId, providerId: pool.providerId, models: pool.models.size, coverage, modelsDetail: Object.fromEntries(pool.models) });
}

// Account-level rollup — the real independence boundary. Models on one credential share that
// account's aggregate quota/financial fate even when per-model RPM windows differ; §9 says
// 15 models sharing one quota domain are one backup, not fifteen.
const accountOf = (poolId) => poolId.replace(/:model:.*$/, "");
const accounts = new Map();
for (const p of matrix) {
  const acc = accountOf(p.poolId);
  const entry = accounts.get(acc) ?? { accountId: acc, providerId: p.providerId, pools: 0, coverage: {}, models: 0 };
  entry.pools++;
  entry.models += p.models;
  for (const role of ROLES) {
    const cur = entry.coverage[role] ?? "UNTESTED";
    if ((roleRank[p.coverage[role]] ?? -1) > (roleRank[cur] ?? -1)) entry.coverage[role] = p.coverage[role];
  }
  accounts.set(acc, entry);
}
const accountMatrix = [...accounts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));

// Critical-role independence: count pools where the role is QUALIFIED (not probation).
const independence = {};
const accountIndependence = {};
for (const role of ROLES) {
  const qualified = matrix.filter((p) => p.coverage[role] === "QUALIFIED");
  const probation = matrix.filter((p) => p.coverage[role] === "PROBATION");
  independence[role] = {
    qualifiedPools: qualified.length,
    probationPools: probation.length,
    qualifiedPoolIds: qualified.map((p) => p.poolId),
    probationPoolIds: probation.map((p) => p.poolId),
  };
  const qAcc = accountMatrix.filter((a) => a.coverage[role] === "QUALIFIED");
  accountIndependence[role] = {
    qualifiedAccounts: qAcc.length,
    qualifiedAccountIds: qAcc.map((a) => a.accountId),
  };
}

const report = {
  at: new Date().toISOString(),
  source: QUAL_DB,
  receipts: receipts.length,
  managedPools: matrix.length,
  accounts: accountMatrix.length,
  roles: ROLES,
  independence,
  accountIndependence,
  accountMatrix,
  matrix,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log("\n=== role coverage by independent managed pool ===");
for (const p of matrix) {
  console.log(`${p.poolId}`);
  console.log(`   ${ROLES.map((r) => `${r}=${p.coverage[r]}`).join("  ")}`);
}
console.log("\n=== role coverage by ACCOUNT (true independence boundary) ===");
for (const a of accountMatrix) {
  console.log(`${a.accountId}  (${a.pools} pools, ${a.models} models)`);
  console.log(`   ${ROLES.map((r) => `${r}=${a.coverage[r]}`).join("  ")}`);
}
console.log("\n=== critical-role independence ===");
for (const role of ROLES) {
  const i = independence[role];
  const ai = accountIndependence[role];
  console.log(`${role}: ${i.qualifiedPools} qualified pools / ${ai.qualifiedAccounts} independent accounts, ${i.probationPools} probation`);
}
console.log(`\nwrote ${OUT}`);
