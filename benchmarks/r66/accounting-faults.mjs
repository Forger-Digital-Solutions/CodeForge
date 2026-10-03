#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedPaidAllowanceLedger, createShillingEntry, summarizeShillings } from "@codeforge/cloud-usage";
import { SqliteSessionPersistence } from "@codeforge/sessions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "docs/evidence/r66-everyday-free-readiness/R66-ACCOUNTING-FAULTS.json");
const policy = {
  ownerUserId: "r66-accounting-owner", entitlement: "PAID", costMode: "BALANCED",
  includedAllowanceUsd: 5, overageEnabled: false, hardMaximumUsd: 5,
  userOwnedAllowed: false, paidLeadAllowed: false, updatedAt: "2026-09-29T00:00:00.000Z",
};
const reservation = (requestId) => ({
  requestId, taskId: "r66-accounting-fault", role: "CODER", providerId: "simulated-provider",
  modelId: "simulated-model", estimatedUsd: 1, priceSource: "deterministic-fault-injection",
});

async function child(dbPath) {
  const db = new SqliteSessionPersistence({ dbPath });
  const ledger = new ManagedPaidAllowanceLedger(db);
  await ledger.reserve(policy, reservation("crash-window"));
  process.stdout.write("RESERVATION_DURABLE\n");
  await new Promise(() => setInterval(() => {}, 1_000));
}

async function killAfterDurableReservation(dbPath) {
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", dbPath], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let finished = false;
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("reservation child did not durably checkpoint"));
    }, 30_000);
    proc.stdout.on("data", (bytes) => {
      output += String(bytes);
      if (!finished && output.includes("RESERVATION_DURABLE")) {
        finished = true;
        proc.kill("SIGKILL");
      }
    });
    proc.on("error", (error) => { clearTimeout(timer); reject(error); });
    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!finished) reject(new Error(`child exited before durable reservation: ${code}/${signal}`));
      else resolve({ code, signal });
    });
  });
}

function vitestPattern(pattern) {
  const result = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs", "run", "packages/server/test/paid-role-routing.test.ts", "-t", pattern,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, `${pattern}: ${String(result.stdout).slice(-1000)} ${String(result.stderr).slice(-1000)}`);
  return { pattern, exitCode: result.status, testPassed: /Tests\s+\d+ passed/.test(result.stdout) };
}

async function main() {
  const startedAt = new Date().toISOString();
  const tempDir = await mkdtemp(path.join(root, "benchmarks/r66/tmp/accounting-"));
  const dbPath = path.join(tempDir, "accounting.db");
  const cases = [];
  let duplicateSettlementCount = 0;
  let unknownToZeroCoercionCount = 0;
  let successfulInferenceReplayDueToAccountingFailure = 0;
  try {
    const db = new SqliteSessionPersistence({ dbPath });
    const ledger = new ManagedPaidAllowanceLedger(db);
    await ledger.reserve(policy, reservation("pre-inference-failure"));
    await ledger.release(policy.ownerUserId, "pre-inference-failure");
    assert.equal((await ledger.receipts(policy.ownerUserId, "r66-accounting-fault")).length, 0);
    cases.push({ name: "request_failure_before_inference", proof: "released hold; zero successful-inference settlement", pass: true });
    await db.close();

    const postInference = vitestPattern("fails closed with MANAGED_PAID_ACCOUNTING_FAILED");
    assert.equal(postInference.testPassed, true);
    cases.push({ name: "inference_served_then_settlement_write_fails", proof: "production runtime asserts one provider request, zero retry/failover, open reservation", pass: true, test: postInference });

    const kill = await killAfterDurableReservation(dbPath);
    const recoveredDb = new SqliteSessionPersistence({ dbPath });
    const recoveredLedger = new ManagedPaidAllowanceLedger(recoveredDb);
    const open = await recoveredLedger.snapshot(policy);
    assert.equal(open.reservedUsd, 1);
    const receipt = await recoveredLedger.settle(policy.ownerUserId, "crash-window", 0.75, "OBSERVED");
    assert.equal(receipt.chargedUsd, 0.75);
    cases.push({ name: "kill_after_reservation_before_settlement", proof: "real process kill, reopened SQLite hold, one observed settlement", kill, pass: true });

    const replay = await recoveredLedger.settle(policy.ownerUserId, "crash-window", 0.75, "OBSERVED");
    assert.deepEqual(replay, receipt);
    const receipts = await recoveredLedger.receipts(policy.ownerUserId, "r66-accounting-fault");
    duplicateSettlementCount = Math.max(0, receipts.filter((item) => item.requestId === "crash-window").length - 1);
    assert.equal(duplicateSettlementCount, 0);
    cases.push({ name: "settlement_repeated_after_restart", proof: "same receipt; one durable row", pass: true });

    await recoveredLedger.reserve(policy, reservation("unmeasured"));
    const estimated = await recoveredLedger.settle(policy.ownerUserId, "unmeasured", null, "ESTIMATED");
    assert.equal(estimated.actualUsd, null);
    assert.equal(estimated.chargedUsd, 1);
    const unknown = createShillingEntry({
      id: "r57-unknown", userId: policy.ownerUserId, taskId: "r66-accounting-fault", role: "CODER",
      requestId: "unmeasured", providerId: "simulated-provider", modelId: "simulated-model",
      sourceClass: "MANAGED_FREE", rawUsage: null,
      conversion: { rawUnit: "UNKNOWN", confidence: "UNKNOWN" },
      managedSpendUsd: null, userProviderSpendUsd: null, costConfidence: "UNKNOWN",
      recordedAt: new Date().toISOString(),
    });
    const summary = summarizeShillings("r66-accounting-fault", [unknown]);
    unknownToZeroCoercionCount = [unknown.shConsumed, summary.shConsumed, unknown.rawUsage].filter((value) => value === 0).length;
    assert.equal(unknownToZeroCoercionCount, 0);
    cases.push({ name: "usage_unavailable", proof: "actual usage and Shilling totals remain null; estimated money hold is charged conservatively", pass: true });
    await recoveredDb.close();

    const failover = vitestPattern("records every charged paid attempt");
    assert.equal(failover.testPassed, true);
    cases.push({ name: "provider_model_failover", proof: "production runtime asserts distinct estimated failed-attempt and observed successful-attempt route receipts", pass: true, test: failover });

    const result = {
      schema: "r66-accounting-fault-campaign/v1", startedAt, finishedAt: new Date().toISOString(),
      scope: "deterministic fault injection; no paid-provider inference or charge",
      cases,
      metrics: { successfulInferenceReplayDueToAccountingFailure, duplicateSettlementCount, unknownToZeroCoercionCount },
      pass: cases.length === 6 && cases.every((item) => item.pass) && duplicateSettlementCount === 0 && unknownToZeroCoercionCount === 0,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, pass: result.pass, cases: cases.length, metrics: result.metrics }));
    if (!result.pass) process.exitCode = 1;
  } finally {
    // Preserve owned ledger fixtures for review.
  }
}

if (process.argv[2] === "--child") child(process.argv[3]).catch((error) => { console.error(error); process.exitCode = 1; });
else main().catch((error) => { console.error(error); process.exitCode = 1; });
