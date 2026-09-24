import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const sessionId = process.argv[2];
const packagePath = process.argv[3];
const outputPath = process.argv[4];
if (!sessionId || !packagePath || !outputPath || !process.env.APPDATA) {
  throw new Error("Usage: node collect-packaged-dogfood.mjs <session-id> <app.asar> <output.json>");
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

const db = new DatabaseSync(join(process.env.APPDATA, "codeforge-desktop", "codeforge.db"), { readOnly: true });
const session = db.prepare("SELECT id,status,outcome,currentModelId,currentProviderId,workspacePath,createdAt,updatedAt FROM sessions WHERE id=?").get(sessionId);
if (!session) throw new Error("The requested packaged session was not found.");

const events = db.prepare("SELECT data FROM events WHERE sessionId=? ORDER BY id").all(sessionId).map((row) => JSON.parse(row.data));
const eventTypes = {};
for (const event of events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
const runOutcome = events.findLast((event) => event.type === "run.outcome")?.payload;
const routing = events.filter((event) => event.type === "router.selection").map((event) => ({
  providerId: event.payload.providerId,
  modelId: event.payload.modelId,
  score: event.payload.score,
}));
const commands = events.filter((event) => event.type === "command.executed").map((event) => ({
  command: event.payload.command,
  exitCode: event.payload.exitCode,
}));
const toolCalls = events.filter((event) => event.type === "tool.call_completed").map((event) => event.payload.toolName);
const usage = events.filter((event) => event.type === "token.usage").reduce((sum, event) => ({
  inputTokens: sum.inputTokens + (event.payload.inputTokens ?? 0),
  outputTokens: sum.outputTokens + (event.payload.outputTokens ?? 0),
}), { inputTokens: 0, outputTokens: 0 });
const inspectionRow = db.prepare("SELECT data FROM work_items WHERE sessionId=? AND kind='run_inspection' ORDER BY rowid DESC LIMIT 1").get(sessionId);
const inspection = inspectionRow ? JSON.parse(inspectionRow.data) : null;
const workspacePath = resolve(session.workspacePath);
const hidden = spawnSync(process.execPath, [resolve("docs/evidence/r29-release-closure/07-packaged-dogfood/hidden-verify.mjs")], {
  cwd: resolve("docs/evidence/r29-release-closure/07-packaged-dogfood"),
  encoding: "utf8",
  timeout: 10_000,
  windowsHide: true,
});

const receipt = {
  schema: "r29-packaged-authenticated-dogfood-1",
  recordedAt: new Date().toISOString(),
  session: {
    id: session.id,
    status: session.status,
    outcome: session.outcome,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  },
  package: { asarPath: resolve(packagePath), asarSha256: await sha256(packagePath) },
  model: { providerId: session.currentProviderId, modelId: session.currentModelId, routing },
  runtime: { eventTypes, toolCalls, commands, usage },
  result: {
    runId: runOutcome?.runId,
    outcome: runOutcome?.outcome,
    changedFiles: runOutcome?.changedFiles,
    completion: inspection?.completion ?? null,
    diffs: inspection?.diffs?.map((diff) => ({ path: diff.path, changeType: diff.changeType, additions: diff.additions, deletions: diff.deletions })) ?? [],
    verificationAttempts: inspection?.verificationAttempts?.map((attempt) => ({
      attempt: attempt.attempt,
      verifiers: attempt.verifiers?.map((verifier) => ({ id: verifier.id, status: verifier.status, exitCode: verifier.exitCode })),
    })) ?? [],
    review: inspection?.review ?? null,
    independentHiddenVerifier: { passed: hidden.status === 0, exitCode: hidden.status, cases: 6 },
    changedFileSha256: await sha256(join(workspacePath, "src", "add.mjs")),
  },
};

writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
db.close();
console.log(JSON.stringify({ outputPath, outcome: receipt.result.outcome, hiddenPassed: receipt.result.independentHiddenVerifier.passed }));
