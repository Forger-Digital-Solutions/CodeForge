import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ForgeZero } from "@codeforge/forge-zero";
import { discoverAndVerifyFree, NormalizedModelRegistry } from "@codeforge/model-registry";
import { createOpenRouterAdapter, InMemoryProviderCatalog } from "@codeforge/providers";
import { CodeForgeServer } from "@codeforge/server";
import { verifyWorkspace } from "./r11-codeforge-bench-r2-hidden-verifier.mjs";

const execFile = promisify(execFileCallback);
const ROUTE = "cohere/north-mini-code:free";
const CASE_TIMEOUT_MS = Number(process.env.CODEFORGE_R2_CASE_TIMEOUT_MS ?? 5 * 60_000);
const EVIDENCE_ROOT = path.resolve(process.env.CODEFORGE_R2_EVIDENCE_DIR ?? "docs/evidence/r11-release-candidate-closure/r2/raw");
let harnessPromise;
let routeNotBefore = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeDiagnostic = (value) => String(value ?? "")
  .replace(/(?:sk|key|token)[-_a-z0-9]{12,}/gi, "[REDACTED]")
  .replace(/bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
  .slice(0, 2_000);

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, "utf8");
}

async function run(command, args, cwd, timeout = 120_000) {
  try {
    const result = await execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { exitCode: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? error),
    };
  }
}

async function requestJson(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 1_000) }; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function familyFor(category) {
  if (["repository_understanding", "architecture_understanding", "context_pressure"].includes(category)) return "analysis";
  if (["ambiguous_task", "planning_quality"].includes(category)) return "planning";
  if (category === "reviewer_quality") return "review";
  if (["test_creation", "regression_prevention"].includes(category)) return "tests";
  if (["routing_difficulty", "provider_failure"].includes(category)) return "routing";
  if (["recovery", "long_horizon", "complex_debugging", "subagent_cooperation"].includes(category)) return "recovery";
  if (["security_sensitive", "git_safety"].includes(category)) return "security";
  if (["large_repository", "tool_efficiency"].includes(category)) return "localization";
  if (["verification_resistance", "adversarial_verification"].includes(category)) return "verification";
  return "coding";
}

async function materializeFixture(workspace, benchmarkCase) {
  const family = familyFor(benchmarkCase.category);
  const commonPackage = {
    name: `codeforge-r2-${benchmarkCase.id.toLowerCase()}`,
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  };
  await write(path.join(workspace, "package.json"), `${JSON.stringify(commonPackage, null, 2)}\n`);
  await write(path.join(workspace, "TASK.md"), [
    `# ${benchmarkCase.id}`,
    "",
    benchmarkCase.instructions,
    "",
    `Expected behavior: ${benchmarkCase.expectedBehavior}`,
    "",
    "Preserve public APIs. Do not delete or weaken existing acceptance tests. Run `npm test` after the smallest complete change.",
    "",
  ].join("\n"));

  if (family === "analysis") {
    await write(path.join(workspace, "src", "authority.mjs"), [
      "export const completionAuthority = 'CompletionGate';",
      "export const eligibilityAuthority = 'ForgeZero';",
      "export const routeAdvisor = 'EightBit';",
      "export const boundaries = ['Free', 'Paid Auto', 'BYOK', 'GEMS'];",
      "",
    ].join("\n"));
    await write(path.join(workspace, "src", "persistence.mjs"), "export const durableOwner = 'SessionPersistence';\n");
    await write(path.join(workspace, "test", "report.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';",
      "test('source-backed report exists', () => { const text = fs.readFileSync('REPORT.md', 'utf8'); assert.match(text, /CompletionGate/); assert.match(text, /ForgeZero/); assert.match(text, /src\\//); });",
      "",
    ].join("\n"));
  } else if (family === "planning") {
    await write(path.join(workspace, "src", "router.mjs"), "export const exactSelection = 'no-substitution';\nexport const adaptiveSelection = 'policy-bound';\n");
    await write(path.join(workspace, "test", "plan.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';",
      "test('plan preserves selection contracts', () => { const text = fs.readFileSync('PLAN.md', 'utf8'); assert.match(text, /exact/i); assert.match(text, /no.?substitution/i); assert.match(text, /verification/i); });",
      "",
    ].join("\n"));
  } else if (family === "review") {
    await write(path.join(workspace, "candidate.patch"), "- if (!receipt.verified) return false;\n+ return true; // happy path tests pass\n");
    await write(path.join(workspace, "test", "review.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';",
      "test('review identifies the blocking authority regression', () => { const text = fs.readFileSync('REVIEW.md', 'utf8'); assert.match(text, /blocking/i); assert.match(text, /receipt|verification/i); assert.match(text, /test/i); });",
      "",
    ].join("\n"));
  } else if (family === "tests") {
    await write(path.join(workspace, "src", "parser.mjs"), [
      "export function parseResponse(value) {",
      "  if (typeof value !== 'string') return { kind: 'valid', value: '' };",
      "  return { kind: 'valid', value };",
      "}",
      "",
    ].join("\n"));
    await write(path.join(workspace, "test", "smoke.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { parseResponse } from '../src/parser.mjs'; test('valid', () => assert.deepEqual(parseResponse('ok'), { kind: 'valid', value: 'ok' }));\n");
    await fs.appendFile(path.join(workspace, "TASK.md"), "\nAdd behavioral tests for valid, empty, and malformed input, then repair parseResponse so empty and malformed are distinct from valid.\n", "utf8");
  } else if (family === "routing") {
    await write(path.join(workspace, "src", "router.mjs"), [
      "export function selectRoute(routes, request) {",
      "  if (request.mode === 'exact') return routes.find((route) => route.free) ?? routes[0];",
      "  return routes[0];",
      "}",
      "",
    ].join("\n"));
    await write(path.join(workspace, "test", "router.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { selectRoute } from '../src/router.mjs';",
      "const routes = [{ id: 'paid', free: false, healthy: true }, { id: 'free', free: true, healthy: true }];",
      "test('exact stays exact', () => assert.equal(selectRoute(routes, { mode: 'exact', id: 'paid' })?.id, 'paid'));",
      "test('free auto stays free', () => assert.equal(selectRoute(routes, { mode: 'free-auto' })?.id, 'free'));",
      "",
    ].join("\n"));
  } else if (family === "recovery") {
    await write(path.join(workspace, "src", "continuation.mjs"), [
      "export function applyResult(state, result) {",
      "  state.writes.push(result.value);",
      "  state.consumed.push(result.id);",
      "  return state;",
      "}",
      "",
    ].join("\n"));
    await write(path.join(workspace, "test", "continuation.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { applyResult } from '../src/continuation.mjs';",
      "test('replayed result is idempotent', () => { const state = { writes: [], consumed: [] }; applyResult(state, { id: 'r1', value: 'patch' }); applyResult(state, { id: 'r1', value: 'patch' }); assert.deepEqual(state.writes, ['patch']); assert.deepEqual(state.consumed, ['r1']); });",
      "",
    ].join("\n"));
  } else if (family === "security") {
    await write(path.join(workspace, "src", "receipt.mjs"), [
      "export function sanitizeReceipt(input) { return { ...input }; }",
      "export function freeEligible(route) { return route.free || route.byok || route.paid; }",
      "",
    ].join("\n"));
    await write(path.join(workspace, "test", "receipt.test.mjs"), [
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { sanitizeReceipt, freeEligible } from '../src/receipt.mjs';",
      "test('receipt excludes credential material', () => assert.deepEqual(sanitizeReceipt({ providerId: 'p', apiKey: 'secret' }), { providerId: 'p' }));",
      "test('free eligibility is strict', () => assert.equal(freeEligible({ free: false, byok: true, paid: false }), false));",
      "",
    ].join("\n"));
  } else if (family === "localization") {
    await write(path.join(workspace, "src", "runtime", "owner.mjs"), "export function normalize(value) { return value.trim(); }\n");
    await write(path.join(workspace, "src", "generated", "owner.mjs"), "// generated: do not edit\nexport function normalize(value) { return value.trim().toLowerCase(); }\n");
    for (let index = 0; index < 24; index += 1) await write(path.join(workspace, "src", "noise", `module-${index}.mjs`), `export const value${index} = ${index};\n`);
    await write(path.join(workspace, "test", "owner.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { normalize } from '../src/runtime/owner.mjs'; test('runtime owner normalizes', () => assert.equal(normalize('  ALPHA  '), 'alpha'));\n");
  } else if (family === "verification") {
    await write(path.join(workspace, "src", "authorize.mjs"), "export function authorize(role) { return role === 'admin' || role === 'guest'; }\n");
    await write(path.join(workspace, "test", "authorize.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { authorize } from '../src/authorize.mjs'; test('admin allowed', () => assert.equal(authorize('admin'), true));\n");
    await fs.appendFile(path.join(workspace, "TASK.md"), "\nThe complete contract is: admin is allowed; guest and unknown roles must be denied. Add focused negative-path coverage.\n", "utf8");
  } else {
    await write(path.join(workspace, "src", "calculator.mjs"), "export function add(a, b) { return a - b; }\n");
    await write(path.join(workspace, "test", "calculator.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/calculator.mjs'; test('adds positive values', () => assert.equal(add(2, 3), 5));\n");
    await fs.appendFile(path.join(workspace, "TASK.md"), "\nRepair the seeded add implementation without changing its public signature.\n", "utf8");
  }

  return { family };
}

async function initializeHarness() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
  const provider = createOpenRouterAdapter({ timeoutMs: 120_000 });
  const liveModels = await provider.listModels();
  const registry = new NormalizedModelRegistry();
  registry.loadSnapshot();
  const { records } = discoverAndVerifyFree(registry, provider.providerId, liveModels.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    isFree: model.isFree,
    contextWindow: model.contextWindow,
    toolCalling: model.capabilities.toolCalling,
    vision: model.capabilities.vision,
  })));
  const selected = records.find((record) => record.modelId === ROUTE && record.freeStatus === "verified_free" && record.costProfile?.isFree === true);
  if (!selected) throw new Error(`Exact verified-free route ${ROUTE} is unavailable; no substitution is permitted`);
  const firewall = new ForgeZero(); records.forEach((record) => firewall.register(record));
  const catalog = new InMemoryProviderCatalog(); catalog.register(provider);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-r11-r2-server-"));
  const server = new CodeForgeServer({ port: 0, dbPath: path.join(root, "sessions.db"), providerCatalog: catalog, firewall, useRealRuntime: true });
  await server.start();
  return { root, server, base: `http://127.0.0.1:${server.httpPort}`, selected };
}

async function harness() {
  harnessPromise ??= initializeHarness();
  return harnessPromise;
}

export async function executeCase(context) {
  const live = await harness();
  const started = Date.now();
  const capacityWaitMs = Math.max(0, routeNotBefore - Date.now());
  if (capacityWaitMs > 0) await sleep(capacityWaitMs);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `codeforge-r2-${context.case.id.toLowerCase()}-`));
  const workspace = path.join(tempRoot, "workspace");
  const evidenceDir = path.join(EVIDENCE_ROOT, context.case.id, context.runId);
  let cleanup = "completed";
  let result;
  await fs.mkdir(workspace, { recursive: true });
  try {
    const fixture = await materializeFixture(workspace, context.case);
    await run("git", ["init", "--initial-branch=main"], workspace);
    await run("git", ["add", "."], workspace);
    const committed = await run("git", ["-c", "user.name=CodeForgeBench", "-c", "user.email=benchmark@invalid", "commit", "-m", "frozen fixture"], workspace);
    if (committed.exitCode !== 0) throw new Error(`fixture commit failed: ${committed.stderr}`);
    const startingCommit = (await run("git", ["rev-parse", "HEAD"], workspace)).stdout.trim();
    const preserved = { generatedOwner: await fs.readFile(path.join(workspace, "src", "generated", "owner.mjs"), "utf8").catch(() => undefined) };
    if (context.case.category === "git_safety") {
      preserved.stagedUser = "preserve staged user work\n";
      preserved.untrackedUser = "preserve untracked user work\n";
      await write(path.join(workspace, "USER-STAGED.txt"), preserved.stagedUser);
      await run("git", ["add", "USER-STAGED.txt"], workspace);
      await write(path.join(workspace, "USER-SCRATCH.txt"), preserved.untrackedUser);
    }

    await requestJson(live.base, "/api/workspace/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: workspace }) });
    const sessionId = `r2-${context.case.id.toLowerCase()}-${context.runId}`;
    await requestJson(live.base, "/api/model-selection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, providerId: "openrouter", modelId: ROUTE }) });
    const prompt = [
      `CodeForgeBench R2 case ${context.case.id}.`,
      context.case.instructions,
      context.case.expectedBehavior,
      "Read TASK.md and the repository before acting. Complete the concrete fixture task with the smallest safe change. Do not change acceptance tests. Run npm test. Do not merely describe the fix.",
    ].join("\n\n");
    const hiddenVerifierPath = path.resolve("scripts/r11-codeforge-bench-r2-hidden-verifier.mjs").replaceAll("\\", "/");
    const hiddenVerifierCommand = `node -- ${JSON.stringify(hiddenVerifierPath)} ${JSON.stringify(workspace.replaceAll("\\", "/"))} ${fixture.family}`;
    const send = await requestJson(live.base, "/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, executionMode: "agent", message: prompt, verificationCommands: ["npm test", hiddenVerifierCommand] }) });
    const approved = new Set();
    let snapshot;
    const deadline = Date.now() + CASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      snapshot = await requestJson(live.base, `/api/sessions/${encodeURIComponent(sessionId)}`);
      for (const approval of snapshot.pendingApprovals ?? []) {
        if (approved.has(approval.approvalId)) continue;
        approved.add(approval.approvalId);
        await requestJson(live.base, `/api/approvals/${encodeURIComponent(approval.approvalId)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "allow_once" }) });
      }
      const turn = (snapshot.turns ?? []).find((candidate) => candidate.id === send.turnId);
      if (turn && ["completed", "failed", "blocked", "cancelled"].includes(turn.status)) break;
      await sleep(300);
    }
    snapshot ??= await requestJson(live.base, `/api/sessions/${encodeURIComponent(sessionId)}`);
    const terminalTurn = (snapshot.turns ?? []).find((candidate) => candidate.id === send.turnId);
    const visible = await run(process.execPath, ["--test"], workspace);
    const hidden = await verifyWorkspace(workspace, fixture.family, preserved);
    const diff = (await run("git", ["diff", "--binary", "HEAD"], workspace)).stdout;
    const changedFiles = (await run("git", ["status", "--short"], workspace)).stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
    const events = snapshot.events ?? [];
    const inspections = (snapshot.workItems ?? []).filter((item) => item.kind === "run_inspection");
    const forgeVerifyPassed = inspections.some((item) => item.verification?.verificationComplete === true && item.completion?.outcome === "completed");
    const status = ["completed", "blocked", "failed", "cancelled"].includes(terminalTurn?.status) ? terminalTurn.status : "failed";
    const verified = status === "completed" && visible.exitCode === 0 && hidden.passed && forgeVerifyPassed;
    const toolStarted = events.filter((event) => event.type === "tool.execution_started");
    const tokenUsage = events.filter((event) => event.type === "token.usage");
    const routeSelections = events.filter((event) => event.type === "router.selection");
    const payloadTool = (event) => String(event.payload?.toolName ?? event.payload?.tool ?? "");
    const terminalError = safeDiagnostic(terminalTurn?.error);
    const providerFailure = /429|rate.?limit|quota|provider|temporarily unavailable|bad gateway|service unavailable|ineligible/i.test(terminalError);
    if (providerFailure) routeNotBefore = Math.max(routeNotBefore, Date.now() + 65_000);
    const providerCalls = Math.max(tokenUsage.length, routeSelections.length > 0 ? 1 : 0);
    const inputTokens = tokenUsage.reduce((sum, event) => sum + Number(event.payload?.inputTokens ?? 0), 0);
    const outputTokens = tokenUsage.reduce((sum, event) => sum + Number(event.payload?.outputTokens ?? 0), 0);
    const verifierOutput = `${visible.stdout}\n${visible.stderr}`.trim().slice(-4_000);
    const evidence = {
      schemaVersion: 1,
      caseId: context.case.id,
      runId: context.runId,
      fixtureFamily: fixture.family,
      startingCommit,
      selectedRoute: { providerId: "openrouter", modelId: ROUTE, verifiedFree: true },
      taskId: send.taskId,
      turnId: send.turnId,
      terminalStatus: terminalTurn?.status ?? "timeout",
      terminalError,
      approvedActions: approved.size,
      changedFiles,
      diffHash: sha256(diff),
      visible: { passed: visible.exitCode === 0, exitCode: visible.exitCode, output: verifierOutput },
      hidden,
      forgeVerifyPassed,
      eventTypeCounts: Object.fromEntries([...new Set(events.map((event) => event.type))].map((type) => [type, events.filter((event) => event.type === type).length])),
      wallTimeMs: Date.now() - started,
    };
    await fs.mkdir(evidenceDir, { recursive: true });
    await write(path.join(evidenceDir, "attempt.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    if (diff) await write(path.join(evidenceDir, "diff.patch"), diff.slice(0, 1_000_000));
    result = {
      status,
      verified,
      hiddenAcceptance: hidden.passed ? "passed" : "failed",
      model: { providerId: "openrouter", modelId: ROUTE },
      topology: "solo-production-workflow",
      reason: verified ? "Production workflow and independent verifier passed." : `terminal=${terminalTurn?.status ?? "timeout"}; visible=${visible.exitCode === 0}; hidden=${hidden.passed}; forgeVerify=${forgeVerifyPassed}`,
      routing: { requestedMode: "exact", selectedProviderId: "openrouter", selectedModelId: ROUTE, alternativesConsidered: 0, fallbackCount: 0, topology: "solo" },
      verification: { verifierId: "r11-r2-independent-fixture-verifier", visibleAcceptance: visible.exitCode === 0 ? "passed" : "failed", protectedAcceptance: "not_run", forgeVerify: forgeVerifyPassed ? "passed" : status === "completed" ? "failed" : "blocked" },
      metrics: {
        providerCalls,
        contextTokens: inputTokens,
        outputTokens,
        toolCalls: toolStarted.length,
        fileReads: toolStarted.filter((event) => payloadTool(event) === "read_file").length,
        searches: toolStarted.filter((event) => /search/.test(payloadTool(event))).length,
        repeatedSearches: 0,
        retries: events.filter((event) => /retry|failover/.test(event.type)).length,
        capacityWaitMs,
        wallTimeMs: Date.now() - started,
        estimatedCostUsd: 0,
      },
      ...(verified ? {} : { failure: {
        failureMode: terminalTurn?.status === undefined
          ? "timeout"
          : providerFailure
            ? /429|rate.?limit|quota|temporarily ineligible/i.test(terminalError) ? "provider_rate_limited" : "provider_failure"
            : !hidden.passed
              ? "hidden_verifier_failure"
              : !forgeVerifyPassed
                ? "forgeverify_or_completion_gate"
                : "visible_verifier_failure",
        lastCorrectState: routeSelections.length > 0 ? "exact verified-free route selected" : "fixture prepared and exact route requested",
        incorrectAction: terminalError || undefined,
        verifierFindings: hidden.findings,
        hypothesizedLayer: providerFailure ? "provider" : fixture.family,
      } }),
      fixtureEvidence: { fixtureId: `${context.case.id}-${fixture.family}-v1`, startingCommit, changedFiles, diffHash: sha256(diff), verifierCommand: "node --test", verifierExitCode: visible.exitCode, verifierOutput, cleanup: "completed" },
    };
  } finally {
    try { await fs.rm(tempRoot, { recursive: true, force: true }); } catch { cleanup = "failed"; }
  }
  if (result?.fixtureEvidence) result.fixtureEvidence.cleanup = cleanup;
  return result;
}

export async function dispose() {
  if (!harnessPromise) return;
  const live = await harnessPromise.catch(() => undefined);
  if (!live) return;
  await live.server.stop();
  await fs.rm(live.root, { recursive: true, force: true });
  harnessPromise = undefined;
}

export default { executeCase };
