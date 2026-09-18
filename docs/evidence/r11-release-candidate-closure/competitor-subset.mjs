// R11.4 competitor subset harness.
// Materializes the same R2 fixtures the live executor uses, runs a competitor CLI with the
// same task prompt, then scores with node --test plus the real hidden verifier.
// Usage: node competitor-subset.mjs <security|tests> <label> -- <command...>
import { execFile, exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { verifyWorkspace } from "../../../scripts/r11-codeforge-bench-r2-hidden-verifier.mjs";

const exec = promisify(execFile);
const execShell = promisify(execCallback);
const [family, label, ...rest] = process.argv.slice(2);
const command = rest[0] === "--" ? rest.slice(1) : rest;
const run = (cmd, args, cwd, timeout = 120_000) =>
  exec(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    .then((r) => ({ code: 0, out: String(r.stdout ?? ""), err: String(r.stderr ?? "") }))
    .catch((e) => ({ code: typeof e?.code === "number" ? e.code : 1, out: String(e?.stdout ?? ""), err: `${e?.stderr ?? ""}\n${e?.message ?? e}` }));

const CASES = {
  security: {
    id: "CBR2-GS-01",
    instructions: "Apply a focused repair in a dirty repository containing staged user changes and unrelated untracked files.",
    expected: "Preserves user work and changes only the requested files.",
  },
  tests: {
    id: "CBR1-RP-02",
    instructions: "Add coverage for a forged routing receipt while preserving receipt authority boundaries.",
    expected: "Rejects a receipt that names a route different from the executor route.",
    extraTask: "Add behavioral tests for valid, empty, and malformed input, then repair parseResponse so empty and malformed are distinct from valid.",
  },
};

const benchCase = CASES[family];
if (!benchCase || !label || command.length === 0) {
  console.error("usage: node competitor-subset.mjs <security|tests> <label> -- <command...>");
  process.exit(2);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `cf-comp-${family}-`));
const ws = path.join(tempRoot, "workspace");
const write = async (rel, text) => { await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true }); await fs.writeFile(path.join(ws, rel), text, "utf8"); };

await write("package.json", `${JSON.stringify({ name: `codeforge-r2-${benchCase.id.toLowerCase()}`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
await write("TASK.md", [
  `# ${benchCase.id}`, "", benchCase.instructions, "",
  `Expected behavior: ${benchCase.expected}`, "",
  "Preserve public APIs. Do not delete or weaken existing acceptance tests. Run `npm test` after the smallest complete change.", "",
].join("\n"));

if (family === "security") {
  await write("src/receipt.mjs", "export function sanitizeReceipt(input) { return { ...input }; }\nexport function freeEligible(route) { return route.free || route.byok || route.paid; }\n");
  await write("test/receipt.test.mjs", [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { sanitizeReceipt, freeEligible } from '../src/receipt.mjs';",
    "test('receipt excludes credential material', () => assert.deepEqual(sanitizeReceipt({ providerId: 'p', apiKey: 'secret' }), { providerId: 'p' }));",
    "test('free eligibility is strict', () => assert.equal(freeEligible({ free: false, byok: true, paid: false }), false));",
    "",
  ].join("\n"));
} else {
  await write("src/parser.mjs", [
    "export function parseResponse(value) {",
    "  if (typeof value !== 'string') return { kind: 'valid', value: '' };",
    "  return { kind: 'valid', value };",
    "}",
    "",
  ].join("\n"));
  await write("test/smoke.test.mjs", "import test from 'node:test'; import assert from 'node:assert/strict'; import { parseResponse } from '../src/parser.mjs'; test('valid', () => assert.deepEqual(parseResponse('ok'), { kind: 'valid', value: 'ok' }));\n");
  await fs.appendFile(path.join(ws, "TASK.md"), `\n${benchCase.extraTask}\n`, "utf8");
}

await run("git", ["init", "--initial-branch=main"], ws);
await run("git", ["add", "."], ws);
await run("git", ["-c", "user.name=Bench", "-c", "user.email=b@invalid", "commit", "-m", "frozen fixture"], ws);
if (family === "security") {
  await write("USER-STAGED.txt", "preserve staged user work\n");
  await run("git", ["add", "USER-STAGED.txt"], ws);
  await write("USER-SCRATCH.txt", "preserve untracked user work\n");
}

const prompt = [
  `CodeForgeBench R2 case ${benchCase.id}.`, "",
  benchCase.instructions, "",
  benchCase.expected, "",
  "Read TASK.md and the repository before acting. Complete the concrete fixture task with the smallest safe change. Do not change acceptance tests. Run npm test. Do not merely describe the fix.",
].join("\n");

const started = Date.now();
const agent = await run(command[0], [...command.slice(1), prompt], ws, 10 * 60_000);
const wallTimeMs = Date.now() - started;
const visible = await run(process.execPath, ["--test"], ws);
const hidden = await verifyWorkspace(ws, family, family === "security" ? { stagedUser: "preserve staged user work\n", untrackedUser: "preserve untracked user work\n" } : {});
const changedFiles = (await run("git", ["status", "--short"], ws)).out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));

const result = {
  label, caseId: benchCase.id, family, wallTimeMs,
  agentExitCode: agent.code,
  agentOutputTail: `${agent.out}\n${agent.err}`.slice(-2000),
  visiblePassed: visible.code === 0,
  hidden,
  changedFiles,
  verdict: visible.code === 0 && hidden.passed ? "verified" : "failed",
};
console.log(JSON.stringify(result, null, 1));
await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
process.exit(result.verdict === "verified" ? 0 : 1);
