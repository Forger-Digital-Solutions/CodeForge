import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repo = process.cwd();
const baseline = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-free-baseline-"));
const archive = path.join(baseline, "head.tar");
const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true });
await execFile("git", ["archive", `--output=${archive}`, "HEAD", "package.json", "tsconfig.base.json", "vitest.config.mts", "packages", "apps/cloud-api", "tests"], { cwd: repo, windowsHide: true });
await execFile("tar", ["-xf", archive, "-C", baseline], { windowsHide: true });
await fs.symlink(path.join(repo, "node_modules"), path.join(baseline, "node_modules"), "junction");
const files = ["tests/cloud-e2e.test.ts", "tests/reservation-ordering.test.ts", "packages/cloud-db/test/account-deletion.test.ts", "packages/cloud-billing/test/billing.test.ts"];
let result;
try {
  result = await execFile(process.execPath, [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", ...files], { cwd: baseline, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  result.exitCode = 0;
} catch (error) { result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code }; }
await fs.writeFile(path.join(repo, "docs/evidence/free-capacity-fabric/baseline-credit-audit.json"), JSON.stringify({ head: head.trim(), baseline, files, ...result }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ head: head.trim(), baseline, exitCode: result.exitCode, summary: result.stdout.match(/Test Files[^\n]+|Tests\s+[^\n]+/g) }) + "\n");
