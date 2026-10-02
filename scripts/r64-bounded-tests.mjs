import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = new URL("../docs/evidence/free-capacity-fabric/", import.meta.url);
const temporary = new URL("../benchmarks/r64/tmp/", import.meta.url);
await mkdir(temporary, { recursive: true });
const heavy = [
  "packages/server/test/autonomous-orchestrator.test.ts",
  "packages/server/test/parallel-orchestrator-integration.test.ts",
  "packages/repo-intelligence/test/cf14-large-repo-benchmark.test.ts",
  "apps/cloud-api/test/desktop-cloud-bridge.e2e.test.ts",
];
const phases = [
  { name: "bounded-main", args: heavy.flatMap((file) => [`--exclude=${file}`]), workers: 2 },
  ...heavy.map((file, index) => ({ name: `serial-heavy-${index + 1}`, args: [file], workers: 1 })),
];
const state = { generatedAt: new Date().toISOString(), status: "RUNNING", repositoryWideGreen: false,
  strategy: "One main pass with two isolated workers; four contention-sensitive suites then run serially. Certificate canary independently recertified by main R64 workstream.",
  workerHeapLimitMb: 2048, peakProcessTreeWorkingSetBytes: 0, peakSingleProcessWorkingSetBytes: 0, phases: [] };
const persist = async () => writeFile(new URL("R64-REPOSITORY-TESTS.json", evidence), `${JSON.stringify(state, null, 2)}\n`);
await persist();
for (const phase of phases) {
  const output = new URL(`R64-suite-${phase.name}.json`, evidence);
  const log = createWriteStream(new URL(`${phase.name}.log`, temporary));
  const args = ["--max-old-space-size=2048", "node_modules/vitest/vitest.mjs", "run", ...phase.args,
    `--maxWorkers=${phase.workers}`, "--exclude=tests/free-capacity-certificate.test.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${fileURLToPath(output)}`];
  const started = Date.now();
  const entry = { name: phase.name, status: "RUNNING", startedAt: new Date(started).toISOString(), workers: phase.workers,
    command: `node ${args.join(" ")}`, report: fileURLToPath(output), completedFileLines: 0, latestProgress: "", durationSeconds: 0 };
  state.phases.push(entry);
  await persist();
  console.log(`Started ${phase.name} with ${phase.workers} worker(s)`);
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", NODE_ENV: "test", CODEFORGE_ALLOW_TEST_PROVIDERS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let lines = "";
  const onOutput = (chunk) => {
    log.write(chunk);
    lines = (lines + String(chunk)).slice(-6000);
    entry.latestProgress = lines.split(/\r?\n/).filter((line) => /\.(test|spec)\.|Test Files|Tests\s/.test(line)).slice(-1)[0]?.replace(/\u001b\[[0-9;]*m/g, "") ?? entry.latestProgress;
    entry.completedFileLines += (String(chunk).match(/[✓×]\s.*\.test\./g) ?? []).length;
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  let sampling = false;
  const sampler = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const command = `$taskRootPid=${child.pid}; $taskProcesses=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"; $taskIds=@($taskRootPid); do { $taskNew=@($taskProcesses | Where-Object { $taskIds -contains $_.ParentProcessId -and $taskIds -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId); $taskIds += $taskNew } while ($taskNew.Count -gt 0); $taskMemory=@(Get-Process -Id $taskIds -ErrorAction SilentlyContinue); @{total=($taskMemory | Measure-Object WorkingSet64 -Sum).Sum;peak=($taskMemory | Measure-Object PeakWorkingSet64 -Maximum).Maximum} | ConvertTo-Json -Compress`;
      const { stdout } = await runFile("pwsh", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 10_000 });
      const memory = JSON.parse(stdout);
      state.peakProcessTreeWorkingSetBytes = Math.max(state.peakProcessTreeWorkingSetBytes, memory.total ?? 0);
      state.peakSingleProcessWorkingSetBytes = Math.max(state.peakSingleProcessWorkingSetBytes, memory.peak ?? 0);
    } catch { /* Sampling is observational and cannot change test outcome. */ }
    entry.durationSeconds = (Date.now() - started) / 1000;
    await persist();
    sampling = false;
  }, 15_000);
  const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearInterval(sampler);
  log.end();
  entry.durationSeconds = (Date.now() - started) / 1000;
  entry.exitCode = exitCode;
  entry.status = exitCode === 0 ? "PASS" : "FAIL";
  try {
    const result = JSON.parse(await readFile(output, "utf8"));
    entry.totals = { files: result.testResults.length, passed: result.numPassedTests, failed: result.numFailedTests,
      skipped: result.numPendingTests, todo: result.numTodoTests, pending: result.testResults.flatMap((test) => test.assertionResults ?? []).filter((test) => !["passed", "failed", "pending", "todo", "skipped"].includes(test.status)).length };
    entry.failedAssertions = result.testResults.flatMap((test) => (test.assertionResults ?? []).filter((assertion) => assertion.status === "failed").map((assertion) => ({ file: test.name.replaceAll("\\", "/").replace(root.replaceAll("\\", "/"), ""), title: assertion.fullName, message: assertion.failureMessages?.[0]?.slice(0,1600) })));
    entry.failedSuitesWithoutAssertions = result.testResults.filter((test) => test.status === "failed" && !(test.assertionResults?.length)).map((test) => ({ file: test.name, message: test.message }));
  } catch {
    entry.reportUnavailable = true;
    entry.status = "RESOURCE_OR_RUNNER_FAILURE";
  }
  await persist();
  console.log(`Completed ${phase.name}: ${entry.status} ${JSON.stringify(entry.totals ?? {})}`);
}
state.status = state.phases.every((phase) => phase.status === "PASS") ? "PASS" : "FAIL";
state.repositoryWideGreen = state.status === "PASS";
state.totals = state.phases.reduce((total, phase) => { for (const key of ["files", "passed", "failed", "skipped", "todo", "pending"]) total[key] += phase.totals?.[key] ?? 0; total.durationSeconds += phase.durationSeconds; return total; }, { files: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0, durationSeconds: 0 });
state.finishedAt = new Date().toISOString();
await persist();
console.log(JSON.stringify({ status: state.status, totals: state.totals }));
