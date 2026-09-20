import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { R20FairScheduler } from "../packages/benchmark/dist/r20-scale.js";

const root = path.resolve(import.meta.dirname, "..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const profile = { taskType: "explain", inputTokens: 100, outputTokens: 50, turns: 1, topology: "T0", role: "coder" };
const samples = [10, 100, 1_000, 10_000].map((size) => {
  const scheduler = new R20FairScheduler(1);
  const enqueueStart = performance.now();
  for (let index = 0; index < size; index++) scheduler.enqueue({ userId: `user-${index}`, sessionId: `session-${index}`, taskId: `task-${index}`, executionId: `execution-${index}`, profile, availableAt: 0, queuedAt: 0, attempt: 0, routeIndex: 0, state: "queued" });
  const enqueueMs = performance.now() - enqueueStart;
  const selectionStart = performance.now();
  let selected = 0;
  while (scheduler.next(0)) selected++;
  const selectionMs = performance.now() - selectionStart;
  return { queuedTasks: size, selected, enqueueMs, selectionMs, averageSelectionMicros: selectionMs * 1_000 / size };
});
const result = { schemaVersion: 1, evidenceClass: "locally_emulated", timestamp: new Date().toISOString(), commit, samples };
const outputDir = path.join(root, "docs", "evidence", "r20-platform-intelligence-scale", "04-per-user", "fairness");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "scheduler-overhead.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
