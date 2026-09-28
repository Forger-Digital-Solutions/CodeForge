import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionPersistence } from "@codeforge/sessions";
import { SqliteQualificationPersistence, roleQualityAdvice } from "@codeforge/eight-bit";

const root = "docs/evidence/r53-role-intelligence";
const inventory = JSON.parse(await readFile(`${root}/R53-FREE-ROUTE-INVENTORY.json`, "utf8"));
const db = createSessionPersistence({ dbPath: join(tmpdir(), "r46-qualification.db") });
await db.init();
const store = new SqliteQualificationPersistence(db);
const roles = ["EXPLORER", "PLANNER", "CODER", "REVIEWER"];
const routes = inventory.routes.filter((route) => route.eligible && route.enabled && route.pool.startsWith("managed:"));
const rows = [];
for (const route of routes) {
  const receipt = await store.load(route.providerId, route.modelId);
  const roleResults = Object.fromEntries(roles.map((role) => {
    const result = receipt?.roleResults?.[role];
    const advice = roleQualityAdvice(receipt ?? undefined, role);
    const cases = result?.testCases ?? [];
    const positive = cases.filter((item) => item.passed).at(-1);
    const negative = cases.filter((item) => !item.passed && !item.error).at(-1);
    return [role, {
      status: result?.status ?? "NOT_TESTED",
      receiptScoreAdjustment: advice.scoreAdjustment,
      sampleCount: advice.sampleCount,
      passedCases: cases.filter((item) => item.passed).length,
      failedCases: cases.filter((item) => !item.passed && !item.error).length,
      lastPositiveCase: positive?.caseId ?? null,
      lastNegativeCase: negative?.caseId ?? null,
      runtimeQualitySamples: null,
    }];
  }));
  rows.push({
    providerId: route.providerId,
    modelId: route.modelId,
    pool: route.pool,
    receiptSuite: receipt?.suiteVersion ?? null,
    qualifiedAt: receipt?.completedAt ?? null,
    receiptCurrent: route.receiptCurrent,
    capacityState: route.capacityState,
    policyState: route.eligible && route.enabled ? "ELIGIBLE_MANAGED_FREE" : "EXCLUDED",
    roles: roleResults,
  });
}
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inventoryGeneratedAt: inventory.generatedAt,
  note: "One row per eligible managed route. Runtime role feedback from ephemeral R52 mission hosts is not in the qualification database; null means unobserved here, not zero quality failures.",
  rows,
};
await writeFile(`${root}/R53-ROLE-QUALIFICATION-MATRIX.json`, `${JSON.stringify(output, null, 2)}\n`);
await db.close?.();
console.log(`R53 role matrix: ${rows.length} managed routes, ${roles.length} roles`);
