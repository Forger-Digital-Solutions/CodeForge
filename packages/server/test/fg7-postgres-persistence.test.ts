import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresSessionPersistence, type ISessionPersistence } from "@codeforge/sessions";
import { runVerification } from "@codeforge/workflow";
import { createForgeVerifyPersistenceObserver, loadForgeVerifyEvidence } from "../src/forge-verify-persistence.js";

const TEST_PG = process.env.CODEFORGE_TEST_POSTGRES_URL || process.env.DATABASE_URL;

async function exerciseRestart(persistence: ISessionPersistence, sessionId: string, workspace: string, counterFile: string): Promise<void> {
  await persistence.init();
  const now = new Date().toISOString();
  await persistence.upsertSession({ id: sessionId, title: "FG-7 persistence", createdAt: now, updatedAt: now, status: "idle", workspacePath: workspace });
  const command = `node verify.mjs "${counterFile}"`;
  const first = await runVerification(workspace, [command], { runId: sessionId, observer: createForgeVerifyPersistenceObserver(persistence, sessionId) });
  expect(first.requiredPassed).toBe(true);
  await persistence.close();

  const reopened = new PostgresSessionPersistence({ connectionString: TEST_PG });
  await reopened.init();
  const prior = await loadForgeVerifyEvidence(reopened, sessionId, sessionId);
  expect(prior).toHaveLength(1);
  const second = await runVerification(workspace, [command], {
    runId: sessionId,
    observer: createForgeVerifyPersistenceObserver(reopened, sessionId),
    existingEvidence: prior,
    existingEvidenceSource: "durable",
  });
  expect(await readFile(counterFile, "utf8")).toBe("1");
  expect(second.requiredPassed).toBe(true);
  expect(second.coverageReceipt?.metrics.restartReuseCount).toBe(1);
  // The second receipt has the same canonical coverage identity, so the
  // append-only sink suppresses the duplicate instead of creating a ghost row.
  expect((await reopened.getWorkItems(sessionId)).filter((item) => item.kind === "verification" && item.recordType === "coverage_receipt")).toHaveLength(1);
  await reopened.deleteSession(sessionId);
  await reopened.close();
}

describe.skipIf(!TEST_PG?.startsWith("postgres"))("FG-7 PostgreSQL durable evidence restart proof", () => {
  let workspace: string | undefined;
  let counterFile: string | undefined;

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    if (counterFile) await rm(counterFile, { force: true });
    workspace = undefined;
    counterFile = undefined;
  });

  it("reopens the real PostgreSQL persistence boundary and reuses only durable authoritative evidence", async () => {
    workspace = await mkdtemp(join(tmpdir(), "codeforge-fg7-pg-"));
    counterFile = join(tmpdir(), `codeforge-fg7-pg-counter-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    await writeFile(counterFile, "0", "utf8");
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "fg7-pg-fixture", type: "module" }));
    await writeFile(join(workspace, "verify.mjs"), [
      "import fs from 'node:fs';",
      "const file = process.argv[2];",
      "const count = Number(fs.readFileSync(file, 'utf8')) + 1;",
      "fs.writeFileSync(file, String(count));",
      "console.log('1 passed');",
    ].join("\n"));
    await exerciseRestart(new PostgresSessionPersistence({ connectionString: TEST_PG }), `fg7-pg-${Date.now()}-${Math.random().toString(16).slice(2)}`, workspace, counterFile);
  }, 120_000);
});
