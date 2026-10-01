import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SQLiteCloudDatabase } from "../packages/cloud-db/dist/sqlite.js";
import { PostgresCloudDatabase } from "../packages/cloud-db/dist/postgres.js";

const postgresUrl = process.env.CODEFORGE_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error("CODEFORGE_TEST_POSTGRES_URL is required");
const postgresEndpoint = new URL(postgresUrl);
if (!/^codeforge_r60_test_[a-z0-9_]+$/.test(postgresEndpoint.pathname.slice(1))) {
  throw new Error("Refusing to run R60 parity outside a dedicated codeforge_r60_test_* database");
}

async function rejects(action, pattern) {
  try {
    await action();
  } catch (error) {
    if (!pattern.test(String(error))) throw error;
    return true;
  }
  return false;
}

async function run(factory, separateRaceConnection) {
  const db = factory();
  await db.init();
  let peer;
  try {
    const user = await db.createUser({ displayName: "R60 parity", primaryIdentity: `r60:${randomUUID()}` });
    const other = await db.createUser({ displayName: "R60 other", primaryIdentity: `r60:${randomUUID()}` });
    const jan = await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-01-31T23:59:59Z"));
    const janRepeat = await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-01-15T00:00:00Z"));
    const feb = await db.getOrCreateCurrentUsagePeriod(user.id, 500_000, new Date("2026-02-01T00:00:00Z"));
    const period = feb.period;
    const base = { userId: user.id, providerId: "codeforge-owned", modelId: "codeforge/forgeauto-free", usagePeriodId: period.id, maxTaskSpendCredits: 50_000 };
    const reserve = (requestId, reservedCredits, extra = {}) => db.reserveCredits({ ...base, requestId, reservedCredits, ...extra });

    const taskCap = await rejects(() => reserve(randomUUID(), 50_001), /Free task credit limit exceeded/);
    const first = await reserve(randomUUID(), 8_000, { maxConcurrentTasks: 1 });
    const activeLimit = await rejects(() => reserve(randomUUID(), 8_000, { maxConcurrentTasks: 1 }), /Concurrent task limit reached/);
    const inFlight = await db.getUsagePeriodReservedCredits(period.id);
    const replay = await reserve(first.reservation.requestId, 8_000, { maxConcurrentTasks: 1 });
    const settled = await db.settleReservation({ requestId: first.reservation.requestId, userId: user.id, actualCredits: 3_000 });
    const settlementReplay = await db.settleReservation({ requestId: first.reservation.requestId, userId: user.id, actualCredits: 3_000 });
    const releasedReq = randomUUID();
    await reserve(releasedReq, 7_000);
    const released = await db.releaseReservationCredits({ requestId: releasedReq, userId: user.id, reason: "controlled failure" });
    const releaseReplay = await db.releaseReservationCredits({ requestId: releasedReq, userId: user.id, reason: "controlled cancellation replay" });
    const cancelledReq = randomUUID();
    await reserve(cancelledReq, 6_000);
    const cancelled = await db.releaseReservationCredits({ requestId: cancelledReq, userId: user.id, reason: "controlled cancellation" });
    const staleReq = randomUUID();
    await reserve(staleReq, 5_000);
    const stale = await db.listStaleReservations(new Date(Date.now() + 60_000).toISOString());
    const recovered = await db.releaseReservationCredits({ requestId: staleReq, userId: user.id, reason: "controlled timeout recovery" });
    const unauthorized = await rejects(() => db.settleReservation({ requestId: first.reservation.requestId, userId: other.id, actualCredits: 3_000 }), /Unauthorized/);
    const otherPeriod = await db.getOrCreateCurrentUsagePeriod(other.id, 500_000, new Date("2026-02-01T00:00:00Z"));

    const raceUser = await db.createUser({ displayName: "R60 race", primaryIdentity: `r60:${randomUUID()}` });
    const racePeriod = (await db.getOrCreateCurrentUsagePeriod(raceUser.id, 12_000, new Date("2026-02-01T00:00:00Z"))).period;
    peer = separateRaceConnection ? factory() : db;
    if (peer !== db) await peer.init();
    const raceBase = { userId: raceUser.id, providerId: "codeforge-owned", modelId: "codeforge/forgeauto-free", usagePeriodId: racePeriod.id, maxConcurrentTasks: 2, maxTaskSpendCredits: 50_000, reservedCredits: 8_000 };
    const race = await Promise.allSettled([
      db.reserveCredits({ ...raceBase, requestId: randomUUID() }),
      peer.reserveCredits({ ...raceBase, requestId: randomUUID() }),
    ]);
    const raceAccepted = race.filter((result) => result.status === "fulfilled").length;
    const raceReserved = await db.getUsagePeriodReservedCredits(racePeriod.id);

    const boundaryUser = await db.createUser({ displayName: "R60 boundary", primaryIdentity: `r60:${randomUUID()}` });
    const boundaryPeriod = (await db.getOrCreateCurrentUsagePeriod(boundaryUser.id, 12_000, new Date("2026-02-01T00:00:00Z"))).period;
    const boundaryBase = { ...raceBase, userId: boundaryUser.id, usagePeriodId: boundaryPeriod.id };
    const boundaryFirst = await db.reserveCredits({ ...boundaryBase, requestId: randomUUID(), reservedCredits: 8_000 });
    const exact = await db.reserveCredits({ ...boundaryBase, requestId: randomUUID(), reservedCredits: 4_000 });
    const oneShortRejected = await rejects(() => db.reserveCredits({ ...boundaryBase, requestId: randomUUID(), reservedCredits: 1, maxConcurrentTasks: 3 }), /Free allowance exhausted/);

    for (const result of race) {
      if (result.status === "fulfilled") await db.releaseReservationCredits({ requestId: result.value.reservation.requestId, userId: raceUser.id, reason: "parity test cleanup" });
    }
    await db.releaseReservationCredits({ requestId: boundaryFirst.reservation.requestId, userId: boundaryUser.id, reason: "parity test cleanup" });
    await db.releaseReservationCredits({ requestId: exact.reservation.requestId, userId: boundaryUser.id, reason: "parity test cleanup" });

    return {
      utcMonth: [jan.period.periodStart, jan.period.periodEnd, feb.period.periodStart, feb.period.periodEnd],
      noRollover: jan.grantedNewAllowance && !janRepeat.grantedNewAllowance && feb.grantedNewAllowance && feb.period.freeAllowanceGranted === 500_000,
      historyPreserved: janRepeat.period.id === jan.period.id && feb.period.id !== jan.period.id,
      taskCapRejected: taskCap,
      oneActiveTaskRejected: activeLimit,
      reservationBeforeDispatch: first.created && inFlight === 8_000 && first.balanceAfter === 492_000,
      reservationIdempotent: !replay.created && replay.reservation.id === first.reservation.id,
      partialSettlement: settled.transitioned && settled.balanceAfter === 497_000 && settled.reservation.actualCredits === 3_000,
      settlementIdempotent: !settlementReplay.transitioned && settlementReplay.balanceAfter === 497_000,
      releaseOnFailureOrCancellation: released.transitioned && !releaseReplay.transitioned && released.balanceAfter === 497_000,
      cancellationRelease: cancelled.transitioned && cancelled.balanceAfter === 497_000,
      staleReservationRecovery: stale.some((reservation) => reservation.requestId === staleReq) && recovered.transitioned && recovered.balanceAfter === 497_000,
      crossAccountIsolation: unauthorized && otherPeriod.period.creditsUsed === 0,
      raceAccepted,
      raceReserved,
      raceNeverOverspends: raceAccepted === 1 && raceReserved === 8_000,
      exactRemainingBalance: exact.balanceAfter === 0,
      oneCreditShortRejected: oneShortRejected,
    };
  } finally {
    if (peer && peer !== db) await peer.close();
    await db.close();
  }
}

const sqlite = await run(() => new SQLiteCloudDatabase({ dbPath: ":memory:" }), false);
const postgres = await run(() => new PostgresCloudDatabase({ connectionString: postgresUrl }), true);
const vectors = Object.keys(sqlite).map((name) => ({ name, sqlite: sqlite[name], postgres: postgres[name], parity: JSON.stringify(sqlite[name]) === JSON.stringify(postgres[name]) ? "PASS" : "FAIL" }));
const expected = ["noRollover", "historyPreserved", "taskCapRejected", "oneActiveTaskRejected", "reservationBeforeDispatch", "reservationIdempotent", "partialSettlement", "settlementIdempotent", "releaseOnFailureOrCancellation", "cancellationRelease", "staleReservationRecovery", "crossAccountIsolation", "raceNeverOverspends", "exactRemainingBalance", "oneCreditShortRejected"];
const pass = vectors.every((vector) => vector.parity === "PASS") && expected.every((name) => sqlite[name] === true && postgres[name] === true);
const receipt = {
  schemaVersion: "r60-postgres-parity/v2",
  evidenceClass: "LIVE_SQLITE_POSTGRESQL_SAME_VECTORS",
  capturedAt: new Date().toISOString(),
  status: pass ? "PASS" : "FAIL",
  postgres: { engine: "PostgreSQL", database: postgresEndpoint.pathname.slice(1), isolation: "dedicated_disposable_database", connectionsInRace: 2 },
  vectors,
};
writeFileSync("docs/evidence/r60-usable-free-inference/postgres-parity.json", `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, vectors: vectors.length, failures: vectors.filter((vector) => vector.parity !== "PASS").map((vector) => vector.name) }));
if (!pass) process.exitCode = 1;
