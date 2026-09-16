// R3 corpus oracle wrapper: executes the frozen oracle's vitest invocation, then enforces the
// pre-registered baseline contract. A red-baseline fixture (frozen sandbox/dogfood heads carry
// pre-existing failing tests) makes a raw "suite must exit 0" oracle unsatisfiable for unrelated
// tasks, so the frozen standard becomes: (1) no test may fail that passed-or-did-not-fail at the
// frozen baseline ("no new failures"), and (2) every test file collected at baseline must still
// be collected ("no silent test deletion"). Skipped tests are exempt from both rules. The
// baseline sets are captured at the frozen starting commits and hashed into freeze.json BEFORE
// any task executes; the wrapper never sees or adapts to task results.
//
// Usage: node r3-oracle-wrapper.mjs --baseline=<json> --out=<json> -- <vitest args...>
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const sepIndex = args.indexOf("--");
if (sepIndex === -1) {
  console.error("oracle-wrapper: missing -- separator before vitest args");
  process.exit(2);
}
const baselinePath = option("baseline");
const outPath = option("out");
function findVitestEntry() {
  let directory = process.cwd();
  while (true) {
    const candidate = path.join(directory, "node_modules", "vitest", "vitest.mjs");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve("node_modules", "vitest", "vitest.mjs");
}
const vitestEntry = option("vitest") ?? findVitestEntry();
const vitestArgs = args.slice(sepIndex + 1);
if (!baselinePath || !outPath || vitestArgs.length === 0) {
  console.error("oracle-wrapper: --baseline and --out and vitest args are required");
  process.exit(2);
}

// Test file identities are compared repo-root-relative: baseline captures and task runs happen
// in different worktree directories, so absolute paths must never leak into the compared ids.
function normFile(file) {
  const absolute = path.resolve(String(file ?? ""));
  return path.relative(process.cwd(), absolute).replaceAll("\\", "/");
}

function testId(file, fullName) {
  return `${file}::${fullName}`;
}

function collect(report) {
  const failing = new Set();
  const skipped = new Set();
  const files = new Set();
  let passed = 0;
  let failed = 0;
  let skippedCount = 0;
  for (const tr of report.testResults ?? []) {
    const file = normFile(tr.name);
    files.add(file);
    for (const a of tr.assertionResults ?? []) {
      const id = testId(file, a.fullName);
      if (a.status === "failed") {
        failing.add(id);
        failed += 1;
      } else if (a.status === "skipped" || a.status === "todo") {
        skipped.add(id);
        skippedCount += 1;
      } else if (a.status === "passed") {
        passed += 1;
      }
    }
  }
  return { failing, skipped, files, passed, failed, skippedCount };
}

function runVitest() {
  return new Promise((resolve) => {
    const rawPath = `${outPath}.raw.json`;
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    const full = [vitestEntry, "run", ...vitestArgs, "--reporter=json", `--outputFile=${rawPath}`];
    execFile(
      process.execPath,
      full,
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, timeout: 3 * 60 * 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          rawPath,
        });
      },
    );
  });
}

const run = await runVitest();
let raw = null;
try {
  raw = JSON.parse(fs.readFileSync(run.rawPath, "utf8"));
} catch {
  // handled below via verdict error
}

if (!raw || !Array.isArray(raw.testResults)) {
  const evaluation = {
    command: `npx vitest run ${vitestArgs.join(" ")}`,
    verdict: "error",
    reason: "vitest produced no parseable JSON report",
    exitCode: run.exitCode,
    stdoutTail: run.stdout.slice(-4_000),
    stderrTail: run.stderr.slice(-4_000),
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
  console.error(`oracle-wrapper: ${evaluation.reason}`);
  process.exit(1);
}

const current = collect(raw);
const baselineRaw = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baseline = {
  failing: new Set(baselineRaw.failingIds ?? []),
  files: new Set(baselineRaw.files ?? []),
};

const newFailures = [...current.failing].filter((id) => !baseline.failing.has(id));
const lostFiles = [...baseline.files].filter((file) => !current.files.has(file));
const verdict = newFailures.length === 0 && lostFiles.length === 0 ? "pass" : "fail";

const evaluation = {
  command: `npx vitest run ${vitestArgs.join(" ")}`,
  verdict,
  counts: { passed: current.passed, failed: current.failed, skipped: current.skippedCount },
  newFailures,
  lostFiles,
  baseline: { file: path.resolve(baselinePath), failing: baseline.failing.size, files: baseline.files.size },
  vitestExitCode: run.exitCode,
  at: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
console.log(`oracle-wrapper: ${verdict} (passed=${current.passed} failed=${current.failed} newFailures=${newFailures.length} lostFiles=${lostFiles.length})`);
process.exit(verdict === "pass" ? 0 : 1);
