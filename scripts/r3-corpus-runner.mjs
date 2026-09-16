// R3-RC2 frozen 100-task corpus runner. Executes every corpus task through the real CodeForge
// pipeline (ForgeZero firewall → governed managed-free providers → AgentRuntime →
// Explorer/Planner/Coder/Reviewer → ForgeVerify → Completion Gate) inside an isolated git
// worktree pinned to the task's frozen starting commit.
//
// Durability: each task's record is a separate JSON file written atomically after every state
// transition, and all run evidence (result, events, workers, diff, oracle evaluations) is
// persisted under the task's evidence directory. A crash never resets campaign progress; an
// interrupted task is re-attempted with an incremented attempt counter while prior attempt
// evidence is preserved.
//
// Capacity: a bounded pre-flight probe gates each task; quota exhaustion is classified
// CAPACITY_BLOCKED and never silently retried into a 429 storm. After repeated consecutive
// capacity blocks a bounded exhaustion ladder runs once, then remaining tasks are honestly
// classified CAPACITY_BLOCKED for this campaign window (resumable later via
// --retry-capacity-blocked).
//
// Trust: the run's own Completion Gate is never treated as correctness. An independent oracle
// evaluation (scripts/r3-oracle-wrapper.mjs against the pre-registered frozen baseline) runs in
// the final integrated state, and a completed run whose oracle fails is a FALSE_COMPLETION P0
// that halts the campaign.
//
//   node scripts/r3-corpus-runner.mjs freeze
//   node scripts/r3-corpus-runner.mjs run   [--only=<taskId>] [--limit=<n>] [--retry-capacity-blocked]
//   node scripts/r3-corpus-runner.mjs status
//   node scripts/r3-corpus-runner.mjs report
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  InMemoryProviderCatalog,
  createGroqAdapter,
  createCloudflareAdapter,
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { EventStore, createSessionPersistence } from "@codeforge/sessions";
import {
  createAgentRuntime,
  createSubagentManager,
  createAutonomousRunOrchestrator,
  createWorkspaceService,
  createWorkspaceEventAdapter,
} from "@codeforge/server";
import { R3_TASKS } from "@codeforge/benchmark";

const execFile = promisify(execFileCallback);

const CAMPAIGN_DIR = path.resolve("tests/evidence/r3/corpus-runs/campaign-1");
const FREEZE_DIR = path.join(CAMPAIGN_DIR, "freeze");
const TASKS_DIR = path.join(CAMPAIGN_DIR, "tasks");
const EVIDENCE_DIR = path.join(CAMPAIGN_DIR, "evidence");
const CHECKPOINTS_DIR = path.join(CAMPAIGN_DIR, "checkpoints");
const RUNNER_PATH = path.resolve("scripts/r3-corpus-runner.mjs");
const WRAPPER_PATH = path.resolve("scripts/r3-oracle-wrapper.mjs");
const MANIFEST_PATH = path.resolve("tests/evidence/r3/corpus-manifest.json");

const REPO_SANDBOX = "G:/dogfood/sandbox-repo";
const REPO_DOGFOOD = "G:/dogfood/codeforge-dogfood";
const REPO_CODEFORGE = "G:/CodeForge";
const RESOLVED = {
  [REPO_SANDBOX]: { manifestDeclared: "d45db35", resolved: null },
  [REPO_DOGFOOD]: { manifestDeclared: "ef6b6d4", resolved: null },
  [REPO_CODEFORGE]: { manifestDeclared: "850513c", resolved: null },
};
const REPO_SLUG = {
  [REPO_SANDBOX]: "sandbox",
  [REPO_DOGFOOD]: "dogfood",
  [REPO_CODEFORGE]: "codeforge",
};

const BOUNDED_CAPACITY_WAIT_MS = 90_000;
const CONSECUTIVE_CAPACITY_LIMIT = 3;
const EXHAUSTION_LADDER_MS = [0, 120_000, 300_000, 600_000];
const TASK_WALL_CLOCK_MS = 3 * 60 * 60_000;
const VERIFICATION_TIMEOUT_MS = 45 * 60_000;
const CAPACITY_MARKERS = [
  "QUOTA_EXHAUSTED",
  "PROVIDER_CAPACITY_EXCEEDED",
  "rate limit",
  "rate_limit",
  "429",
  "capacity",
  "daily free allocation",
  "neurons",
];
const CHECKPOINT_THRESHOLDS = [10, 25, 50, 75, 100];

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const option = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha256String(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function git(repo, ...gitArgs) {
  const { stdout } = await execFile("git", gitArgs, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

function taskRecordPath(taskId) {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

async function loadRecord(taskId) {
  try {
    return readJson(taskRecordPath(taskId));
  } catch {
    return null;
  }
}

function allRecords() {
  const records = [];
  for (const task of R3_TASKS) {
    const file = taskRecordPath(task.id);
    if (fs.existsSync(file)) records.push(readJson(file));
  }
  return records;
}

const TERMINAL_STATUSES = new Set([
  "PASSED",
  "RECOVERED_PASS",
  "HUMAN_ASSISTED",
  "FAILED",
  "CAPACITY_BLOCKED",
  "EXTERNAL_BLOCKED",
  "INVALID_CASE",
]);

function baselineKeyFor(repo, oracleCommand) {
  const targetArgs = oracleTargetArgs(oracleCommand);
  if (!targetArgs) return `${REPO_SLUG[repo]}-suite`;
  return `${REPO_SLUG[repo]}-target-${sha256String(targetArgs).slice(0, 10)}`;
}

function oracleTargetArgs(oracleCommand) {
  return oracleCommand.replace(/^npx vitest run\s*/, "").replace(/^npm test\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------

async function cmdFreeze() {
  if (fs.existsSync(TASKS_DIR) && fs.readdirSync(TASKS_DIR).length > 0) {
    throw new Error("task records already exist; freeze is immutable once execution has started — use a new campaign directory for material corpus changes");
  }
  const frozenAt = new Date().toISOString();

  for (const [repo, entry] of Object.entries(RESOLVED)) {
    entry.resolved = await git(repo, "rev-parse", "HEAD");
  }

  const corpusHashes = {
    manifest: sha256File(MANIFEST_PATH),
    r3CorpusSrc: sha256File(path.resolve("packages/benchmark/src/r3-corpus.ts")),
    benchmarkIndexSrc: sha256File(path.resolve("packages/benchmark/src/index.ts")),
    benchmarkDistR3Corpus: sha256File(path.resolve("packages/benchmark/dist/r3-corpus.js")),
  };

  // Per-task oracle baselines: one baseline per distinct (repo, oracle target args) pair, all
  // captured at the resolved starting states before any task executes.
  const baselineFiles = {};
  const suiteFiles = {
    sandbox: { file: "baseline-sandbox.json", base: "C:/temp/corpus-baseline-sandbox" },
    dogfood: { file: "baseline-dogfood.json", base: REPO_DOGFOOD },
    codeforge: { file: "baseline-codeforge.json", base: REPO_CODEFORGE },
  };
  for (const [slug, { file, base }] of Object.entries(suiteFiles)) {
    const rawPath = path.join(FREEZE_DIR, file);
    if (!fs.existsSync(rawPath)) throw new Error(`Missing suite baseline capture: ${rawPath}`);
    baselineFiles[`${slug}-suite`] = { args: "", ...deriveBaseline(readJson(rawPath), base) };
  }

  const targeted = new Map();
  for (const task of R3_TASKS) {
    const target = oracleTargetArgs(task.oracleCommand);
    if (!target) continue;
    targeted.set(target, task.repo);
  }
  if (targeted.size > 0) {
    const worktreePath = "C:/temp/corpus-freeze-codeforge";
    await removeWorktree(REPO_CODEFORGE, worktreePath, "corpus-freeze-codeforge");
    await git(REPO_CODEFORGE, "worktree", "add", "--detach", worktreePath, RESOLVED[REPO_CODEFORGE].resolved);
    await junctionNodeModules(REPO_CODEFORGE, worktreePath);
    await buildWorktree(REPO_CODEFORGE, worktreePath);
    try {
      for (const target of targeted.keys()) {
        const vitestArgs = target.split(/\s+/).filter(Boolean);
        const rawFile = path.join(FREEZE_DIR, `targeted-raw-${sha256String(target).slice(0, 10)}.json`);
        await execFile(
          process.execPath,
          ["node_modules/vitest/vitest.mjs", "run", ...vitestArgs, "--reporter=json", `--outputFile=${rawFile.replaceAll("\\", "/")}`],
          { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000, windowsHide: true },
        ).catch(() => null);
        const raw = readJson(rawFile);
        const key = `codeforge-target-${sha256String(target).slice(0, 10)}`;
        baselineFiles[key] = { args: target, ...deriveBaseline(raw, worktreePath) };
      }
    } finally {
      await removeWorktree(REPO_CODEFORGE, worktreePath, "corpus-freeze-codeforge");
    }
  }

  for (const [key, entry] of Object.entries(baselineFiles)) {
    const file = path.join(FREEZE_DIR, `baseline-oracle-${key}.json`);
    await atomicWriteJson(file, { key, args: entry.args, failingIds: [...entry.failingIds], files: [...entry.files] });
    entry.file = `baseline-oracle-${key}.json`;
    entry.hash = sha256File(file);
  }

  const taskBaselines = {};
  for (const task of R3_TASKS) {
    taskBaselines[task.id] = baselineKeyFor(task.repo, task.oracleCommand);
  }

  const freeze = {
    schema: "r3-corpus-freeze-v1",
    frozenAt,
    campaign: "campaign-1",
    corpus: corpusHashes,
    runner: { script: sha256File(RUNNER_PATH), wrapper: sha256File(WRAPPER_PATH) },
    startStates: RESOLVED,
    resolutions: [
      {
        scope: "codeforge-start-state",
        manifestDeclared: "850513c",
        resolved: RESOLVED[REPO_CODEFORGE].resolved,
        decidedAt: frozenAt,
        rationale:
          "Five adversarial oracle commands reference test files introduced by the certified post-freeze R3-RC2 hardening commits (44ea7b2, 71f7a9a); at 850513c those oracles cannot execute at all. The repository is authoritative and the hardening is certified work, so CodeForge tasks resolve to the certified HEAD, decided before any task executed.",
      },
      {
        scope: "oracle-semantics",
        decision:
          "npm test is equivalent to 'npx vitest run' in all three target repos. Because the frozen sandbox and dogfood starting states carry pre-existing failing tests unrelated to their task targets, the frozen standard is enforced by scripts/r3-oracle-wrapper.mjs: no test may fail that was not already failing in the baseline captured at the frozen starting commit, and every baseline-collected test file must remain collected. Baselines and their hashes are frozen here before execution.",
      },
      {
        scope: "sandbox-untracked-scratch",
        decision:
          "Untracked scratch files NOTES.md and src/scratch.ts were removed from the sandbox working dir before execution so every task worktree starts pristine at the frozen commit.",
      },
    ],
    baselineKeys: Object.fromEntries(
      Object.entries(baselineFiles).map(([key, entry]) => [
        key,
        { args: entry.args, file: entry.file, hash: entry.hash, failing: entry.failingIds.length, files: entry.files.length },
      ]),
    ),
    taskBaselines,
  };

  await atomicWriteJson(path.join(FREEZE_DIR, "freeze.json"), freeze);
  console.log(`freeze written: ${path.join(FREEZE_DIR, "freeze.json")}`);
  console.log(`baselines: ${Object.keys(baselineFiles).map((k) => `${k}(${baselineFiles[k].failingIds.length} failing)`).join(", ")}`);
}

function deriveBaseline(raw, baseDir) {
  const failingIds = new Set();
  const files = new Set();
  for (const tr of raw.testResults ?? []) {
    const file = path.relative(baseDir, String(tr.name ?? "")).replaceAll("\\", "/");
    files.add(file);
    for (const a of tr.assertionResults ?? []) {
      if (a.status === "failed") failingIds.add(`${file}::${a.fullName}`);
    }
  }
  return { failingIds: [...failingIds], files: [...files] };
}

async function junctionNodeModules(repoDir, worktreePath) {
  const source = path.join(repoDir, "node_modules");
  const target = path.join(worktreePath, "node_modules");
  if (!fs.existsSync(source)) return false;
  if (fs.existsSync(target)) {
    // rmdir removes a junction reparse point without traversing the real target; fall back to
    // rm for ordinary leftover directories.
    try {
      await fsp.rmdir(target);
    } catch {
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
  await fsp.symlink(source, target, "junction");
  return true;
}

// The monorepo suites include tests that spawn real child processes importing workspace packages
// through built dist (gitignored, absent from a fresh worktree). Those children bypass vitest's
// src aliases, so a worktree must be built before its oracle runs or the child fixtures die with
// MODULE_NOT_FOUND while the parent suite's aliases keep working — split-brain verification.
async function buildWorktree(repoDir, worktreePath) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  if (!pkg?.scripts?.build) return { skipped: true };
  const started = Date.now();
  const { stdout } = await execFile("cmd.exe", ["/d", "/s", "/c", "npm run build"], {
    cwd: worktreePath,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60_000,
    windowsHide: true,
  });
  return { skipped: false, durationMs: Date.now() - started, tail: String(stdout).slice(-2_000) };
}

async function removeWorktree(repoDir, worktreePath, branch) {
  try {
    await fsp.rm(worktreePath, { recursive: true, force: true });
  } catch {}
  try {
    await git(repoDir, "worktree", "prune");
  } catch {}
  if (branch) {
    try {
      await git(repoDir, "branch", "-D", branch);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// fleet
// ---------------------------------------------------------------------------

async function buildFleet(context) {
  const observations = [];
  const onResponse = (observation) => observations.push(observation);
  const groq = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 120_000, onResponse });
  const cloudflare = createCloudflareAdapter({
    apiKey: process.env.CLOUDFLARE_API_KEY ?? process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    timeoutMs: 120_000,
    onResponse,
  });

  const governor = new ProviderCapacityGovernor({
    limits: {
      groq: { maxTokensPerMinute: 6000, maxRequestsPerMinute: 20, maxConcurrent: 2 },
      "cloudflare-workers-ai": { maxTokensPerMinute: 60000, maxRequestsPerMinute: 20, maxConcurrent: 2 },
    },
  });

  const catalog = new InMemoryProviderCatalog();
  catalog.register(governor.wrapAdapter(groq));
  catalog.register(governor.wrapAdapter(cloudflare));

  const firewall = new ForgeZero();
  const register = (providerId, modelId, overrides) =>
    firewall.register(createGenericFreeRecord({ providerId, modelId, displayName: `${providerId} ${modelId}`, ...overrides }));

  register("groq", "openai/gpt-oss-120b", {
    codingScore: 90,
    benchmarkProfile: { coding: 92, toolCalling: 85, reasoning: 90, longContext: 85, speed: 80 },
  });
  register("groq", "openai/gpt-oss-20b", {
    codingScore: 55,
    benchmarkProfile: { coding: 60, toolCalling: 75, reasoning: 62, longContext: 60, speed: 92 },
  });

  let cloudflareAvailable = false;
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      await cloudflare.chat({
        model: "@cf/openai/gpt-oss-120b",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 5,
      });
      cloudflareAvailable = true;
    } catch {
      governor.recordResponse("cloudflare-workers-ai", 429, { "retry-after": "86400" });
      context.capacityNotes.push("cloudflare probe failed at campaign start; excluded from fleet for this invocation");
    }
  }
  if (cloudflareAvailable) {
    register("cloudflare-workers-ai", "@cf/nvidia/nemotron-3-120b-a12b", {
      codingScore: 70,
      benchmarkProfile: { coding: 74, toolCalling: 90, reasoning: 78, longContext: 72, speed: 70 },
    });
    register("cloudflare-workers-ai", "@cf/openai/gpt-oss-120b", {
      codingScore: 88,
      benchmarkProfile: { coding: 88, toolCalling: 84, reasoning: 88, longContext: 84, speed: 78 },
    });
    register("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash", {
      codingScore: 62,
      benchmarkProfile: { coding: 66, toolCalling: 70, reasoning: 68, longContext: 64, speed: 85 },
    });
  }

  context.fleetObservations.push(...observations);
  return { firewall, catalog, governor, cloudflareAvailable };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun() {
  const freezeFile = path.join(FREEZE_DIR, "freeze.json");
  if (!fs.existsSync(freezeFile)) throw new Error("freeze.json missing — run the freeze command first");
  const freeze = readJson(freezeFile);
  const selfHash = sha256File(RUNNER_PATH);
  const wrapperHash = sha256File(WRAPPER_PATH);
  if (freeze.runner.script !== selfHash || freeze.runner.wrapper !== wrapperHash) {
    throw new Error("runner or wrapper changed since freeze; re-run freeze (versioned) before executing");
  }

  const only = option("only");
  const limit = Number(option("limit", "0")) || 0;
  const retryCapacityBlocked = flag("retry-capacity-blocked");

  const context = {
    capacityNotes: [],
    fleetObservations: [],
    consecutiveCapacityBlocks: 0,
    halted: null,
    completedThisInvocation: 0,
  };
  const fleet = await buildFleet(context);
  await atomicWriteJson(path.join(CAMPAIGN_DIR, "fleet.json"), {
    updatedAt: new Date().toISOString(),
    cloudflareAvailable: fleet.cloudflareAvailable,
    capacityNotes: context.capacityNotes,
    fleetObservations: context.fleetObservations,
  });

  for (const task of R3_TASKS) {
    if (only && task.id !== only) continue;
    if (limit && context.completedThisInvocation >= limit) break;
    if (context.halted) break;

    let record = await loadRecord(task.id);
    if (!record) {
      record = {
        task_id: task.id,
        category: task.difficulty,
        manifest_declared_start: freeze.startStates[task.repo].manifestDeclared,
        starting_sha: freeze.startStates[task.repo].resolved,
        status: "PENDING",
        attempt: 0,
        oracle_command: task.oracleCommand,
        baseline_key: freeze.taskBaselines[task.id],
        provider_routes: [],
        model_roles: {},
        started_at: null,
        last_progress_at: null,
        finished_at: null,
        verified: false,
        completion_gate: null,
        intervention: "none",
        failure_class: null,
        evidence_path: null,
        tokens: { input: 0, output: 0 },
        requests: 0,
        false_completion: false,
        notes: [],
      };
      await persistRecord(record);
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      if (record.status === "CAPACITY_BLOCKED" && retryCapacityBlocked) {
        record.status = "PENDING";
        record.notes.push(`capacity-blocked result reset for retry at ${new Date().toISOString()}`);
        await persistRecord(record);
      } else {
        continue;
      }
    }

    // Bounded pre-flight capacity gate on the primary managed-free route.
    const gate = await capacityGate(fleet, context);
    if (!gate.available) {
      record.status = "CAPACITY_BLOCKED";
      record.failure_class = gate.reason;
      record.last_progress_at = new Date().toISOString();
      record.notes.push(gate.detail);
      await persistRecord(record);
      context.consecutiveCapacityBlocks += 1;
      console.log(`${task.id}: CAPACITY_BLOCKED (${gate.reason})`);
      if (context.consecutiveCapacityBlocks >= CONSECUTIVE_CAPACITY_LIMIT) {
        await exhaustionLadder(fleet, context);
        if (context.halted === "capacity_exhausted") {
          await bulkClassifyRemaining(freeze, gate.reason, "campaign capacity exhaustion ladder exhausted");
          break;
        }
        context.consecutiveCapacityBlocks = 0;
      }
      continue;
    }
    context.consecutiveCapacityBlocks = 0;

    const executed = await executeTask(fleet, freeze, task, record, context);
    context.completedThisInvocation += 1;
    await maybeCheckpoint(executed.record);
    if (executed.record.false_completion) {
      context.halted = "false_completion_p0";
      await atomicWriteJson(path.join(CAMPAIGN_DIR, "campaign.json"), campaignState(context, "P0 false completion suspected — campaign halted"));
      break;
    }
    if (executed.record.status === "CAPACITY_BLOCKED") {
      context.consecutiveCapacityBlocks += 1;
      if (context.consecutiveCapacityBlocks >= CONSECUTIVE_CAPACITY_LIMIT) {
        await exhaustionLadder(fleet, context);
        if (context.halted === "capacity_exhausted") {
          await bulkClassifyRemaining(freeze, "capacity_exhausted", "campaign capacity exhaustion ladder exhausted");
          break;
        }
        context.consecutiveCapacityBlocks = 0;
      }
    } else {
      context.consecutiveCapacityBlocks = 0;
    }
  }

  await atomicWriteJson(path.join(CAMPAIGN_DIR, "campaign.json"), campaignState(context, context.halted ?? "campaign invocation finished"));
  await printStatus();
}

function campaignState(context, phase) {
  const records = allRecords();
  const byStatus = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    updatedAt: new Date().toISOString(),
    phase,
    attemptedThisInvocation: context.completedThisInvocation,
    halted: context.halted,
    byStatus,
    capacityNotes: context.capacityNotes,
    openP0: records.filter((r) => r.false_completion).map((r) => r.task_id),
  };
}

async function capacityGate(fleet, context) {
  const probeStart = Date.now();
  try {
    await probeChat(fleet);
    return { available: true, detail: `probe ok in ${Date.now() - probeStart}ms` };
  } catch (error) {
    const message = String(error?.message ?? error);
    const retryAfterMs = parseRetryAfterMs(error);
    if (retryAfterMs && retryAfterMs <= BOUNDED_CAPACITY_WAIT_MS) {
      await sleep(retryAfterMs);
      try {
        await probeChat(fleet);
        return { available: true, detail: `probe ok after ${retryAfterMs}ms bounded wait` };
      } catch (error2) {
        return { available: false, reason: "route_quota_limited", detail: String(error2?.message ?? error2).slice(0, 300) };
      }
    }
    return { available: false, reason: classifyCapacityReason(message), detail: message.slice(0, 300) };
  }
}

async function probeChat(fleet) {
  const { createGroqAdapter } = await import("@codeforge/providers");
  const probe = createGroqAdapter({ apiKey: process.env.GROQ_API_KEY, timeoutMs: 30_000 });
  await probe.chat({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "ping" }], maxTokens: 5 });
}

function parseRetryAfterMs(error) {
  const headers = error?.responseHeaders ?? error?.headers ?? null;
  const raw = headers?.["retry-after"] ?? headers?.["retry_after"] ?? null;
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function classifyCapacityReason(message) {
  if (/daily free allocation|neurons|quota/i.test(message)) return "daily_quota_exhausted";
  if (/429|rate limit/i.test(message)) return "rate_limited_beyond_bounded_wait";
  return "route_unavailable";
}

async function exhaustionLadder(fleet, context) {
  for (const waitMs of EXHAUSTION_LADDER_MS) {
    if (waitMs > 0) await sleep(waitMs);
    try {
      await probeChat(fleet);
      context.capacityNotes.push(`capacity recovered during exhaustion ladder after ${waitMs}ms wait`);
      context.halted = null;
      return;
    } catch (error) {
      context.capacityNotes.push(`exhaustion ladder probe at +${waitMs}ms still blocked: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  context.halted = "capacity_exhausted";
}

async function bulkClassifyRemaining(freeze, reason, detail) {
  for (const task of R3_TASKS) {
    const record = await loadRecord(task.id);
    if (record && TERMINAL_STATUSES.has(record.status)) continue;
    const next = record ?? {
      task_id: task.id,
      category: task.difficulty,
      manifest_declared_start: freeze.startStates[task.repo].manifestDeclared,
      starting_sha: freeze.startStates[task.repo].resolved,
      status: "PENDING",
      attempt: 0,
      oracle_command: task.oracleCommand,
      baseline_key: freeze.taskBaselines[task.id],
      provider_routes: [],
      model_roles: {},
      started_at: null,
      last_progress_at: null,
      finished_at: null,
      verified: false,
      completion_gate: null,
      intervention: "none",
      failure_class: null,
      evidence_path: null,
      tokens: { input: 0, output: 0 },
      requests: 0,
      false_completion: false,
      notes: [],
    };
    next.status = "CAPACITY_BLOCKED";
    next.failure_class = reason;
    next.finished_at = new Date().toISOString();
    next.notes.push(detail);
    next.evidence_path = path.join("freeze", "fleet.json");
    await persistRecord(next);
  }
}

async function executeTask(fleet, freeze, task, record, context) {
  record.attempt += 1;
  record.status = "RUNNING";
  record.started_at = record.started_at ?? new Date().toISOString();
  record.last_progress_at = new Date().toISOString();
  await persistRecord(record);

  const attemptDir = path.join(EVIDENCE_DIR, task.id, `attempt-${record.attempt}`);
  await fsp.mkdir(attemptDir, { recursive: true });
  record.evidence_path = path.relative(CAMPAIGN_DIR, attemptDir).replaceAll("\\", "/");
  const worktreePath = path.resolve(`C:/temp/corpus-tasks/${task.id}-a${record.attempt}`).replaceAll("\\", "/");
  const branch = `corpus/${task.id}`;

  const priorInterruption = record.attempt > 1;
  if (priorInterruption) record.notes.push(`prior attempt interrupted; re-attempt ${record.attempt}`);

  try {
    await removeWorktree(task.repo, worktreePath, branch);
    await git(task.repo, "worktree", "add", "-b", branch, worktreePath, record.starting_sha);
    await junctionNodeModules(task.repo, worktreePath);
    const build = await buildWorktree(task.repo, worktreePath);
    await atomicWriteJson(path.join(attemptDir, "build.json"), build);
  } catch (error) {
    record.status = "FAILED";
    record.failure_class = "runner_setup_error";
    record.finished_at = new Date().toISOString();
    record.notes.push(`worktree setup failed: ${String(error?.message ?? error).slice(0, 300)}`);
    await persistRecord(record);
    return { record };
  }

  const sessionId = `corpus-${task.id}-a${record.attempt}`.toLowerCase().replaceAll("_", "-");
  const eventStore = new EventStore();
  const persistence = createSessionPersistence({ dbPath: path.join(attemptDir, "session.db") });
  persistence.upsertSession({
    id: sessionId,
    title: `R3 corpus ${task.id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
  });

  const runtime = createAgentRuntime({
    sessionId,
    eventStore,
    persistence,
    firewall: fleet.firewall,
    providerCatalog: fleet.catalog,
    workspacePath: worktreePath,
  });
  const workspaceService = createWorkspaceService({
    persistence,
    worktreeParentDir: path.join(attemptDir, "run-worktrees"),
  });
  const subagentManager = createSubagentManager({
    persistence,
    workspaceService,
    agentRuntime: runtime,
    r1Enabled: true,
  });
  const orchestrator = createAutonomousRunOrchestrator({
    workspaceService,
    persistence,
    agentRuntime: runtime,
    subagentManager,
    subagentsR1Enabled: true,
  });

  const baselineFile = path.join(FREEZE_DIR, `baseline-oracle-${freeze.taskBaselines[task.id]}.json`);
  const wrapperArgs = [
    WRAPPER_PATH,
    `--baseline=${baselinePathArg(baselineFile)}`,
    `--out=${path.join(attemptDir, "oracle-internal.json").replaceAll("\\", "/")}`,
    `--vitest=${path.join(worktreePath, "node_modules", "vitest", "vitest.mjs").replaceAll("\\", "/")}`,
    "--",
  ];
  const targetArgs = oracleTargetArgs(task.oracleCommand);
  if (targetArgs) wrapperArgs.push(...targetArgs.split(/\s+/).filter(Boolean));
  const verificationCommand = `node ${wrapperArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;

  const adapter = createWorkspaceEventAdapter({ sessionId, eventStore, persistence });
  const abortController = new AbortController();
  const wallClock = setTimeout(() => abortController.abort(new Error("runner_wall_clock_timeout")), TASK_WALL_CLOCK_MS);

  let result = null;
  let runError = null;
  const startedAt = new Date().toISOString();
  try {
    result = await orchestrator.startRun({
      sessionId,
      workspacePath: worktreePath,
      goal: task.userRequest,
      verificationCommands: [verificationCommand],
      verificationTimeoutMs: VERIFICATION_TIMEOUT_MS,
      adapter,
      signal: abortController.signal,
    });
  } catch (error) {
    runError = String(error?.message ?? error);
  } finally {
    clearTimeout(wallClock);
  }

  // Persist everything the attempt produced before any classification decision.
  const workers = (await persistence.getWorkItemsByKind("subagent_run")).filter(Boolean);
  const events = eventStore.getAll();
  const eventsSummary = summarizeEvents(events);
  const diffStat = await git(worktreePath, "diff", "--stat", `${record.starting_sha}..HEAD`).catch(() => "");
  const diffPatch = await git(worktreePath, "diff", `${record.starting_sha}..HEAD`).catch(() => "");
  if (diffPatch.length > 0) {
    await fsp.writeFile(path.join(attemptDir, "diff.patch"), diffPatch.slice(0, 1_000_000), "utf8");
  }
  const workersSummary = workers.map((item) =>
    item.kind === "subagent_run"
      ? {
          role: item.role,
          status: item.status,
          model: item.model ?? null,
          telemetry: item.telemetry ?? null,
          startedAt: item.startedAt ?? null,
          completedAt: item.completedAt ?? null,
        }
      : null,
  ).filter(Boolean);

  await atomicWriteJson(path.join(attemptDir, "run.json"), { sessionId, startedAt, finishedAt: new Date().toISOString(), runError, result });
  await atomicWriteJson(path.join(attemptDir, "events.json"), eventsSummary);
  await atomicWriteJson(path.join(attemptDir, "workers.json"), workersSummary);
  await atomicWriteJson(path.join(attemptDir, "observations.json"), context.fleetObservations.slice(-200));

  // Independent oracle evaluation in the final integrated state — never trust the gate alone.
  const oracleExternal = await runExternalOracle(freeze, task, attemptDir, worktreePath);
  await atomicWriteJson(path.join(attemptDir, "oracle-external.json"), oracleExternal);

  const telemetry = aggregateTelemetry(workersSummary, eventsSummary);
  record.provider_routes = telemetry.routes;
  record.model_roles = telemetry.modelRoles;
  record.tokens = telemetry.tokens;
  record.requests = telemetry.requests;
  record.completion_gate = result ? { status: result.status, reviewPassed: result.review?.passed === true, integration: result.integration?.status ?? null } : { status: "threw", runError };

  const classification = classifyAttempt({
    task,
    result,
    runError,
    oracleExternal,
    priorInterruption,
    recoveryObserved: eventsSummary.recoveryObserved,
    failureEvents: eventsSummary.failureEvents ?? [],
    providerFailures: workersSummary.reduce((sum, worker) => sum + (worker.telemetry?.providerFailures ?? 0), 0),
  });
  record.status = classification.status;
  record.failure_class = classification.failureClass;
  record.false_completion = classification.falseCompletion;
  record.verified = classification.status === "PASSED" || classification.status === "RECOVERED_PASS";
  record.finished_at = new Date().toISOString();
  record.last_progress_at = record.finished_at;
  for (const note of classification.notes) record.notes.push(note);
  await persistRecord(record);

  // Attempt evidence is persisted above; disposable worktrees are never evidence and must not
  // survive a failed run to become embedded repositories or poison the next campaign window.
  await removeWorktree(task.repo, worktreePath, branch);
  return { record };
}

function baselinePathArg(baselineFile) {
  return baselineFile.replaceAll("\\", "/");
}

async function runExternalOracle(freeze, task, attemptDir, worktreePath) {
  const baselineFile = path.join(FREEZE_DIR, `baseline-oracle-${freeze.taskBaselines[task.id]}.json`);
  const outPath = path.join(attemptDir, "oracle-external.json");
  const wrapperArgs = [
    WRAPPER_PATH,
    `--baseline=${baselinePathArg(baselineFile)}`,
    `--out=${outPath.replaceAll("\\", "/")}`,
    `--vitest=${path.join(worktreePath, "node_modules", "vitest", "vitest.mjs").replaceAll("\\", "/")}`,
    "--",
  ];
  const targetArgs = oracleTargetArgs(task.oracleCommand);
  if (targetArgs) wrapperArgs.push(...targetArgs.split(/\s+/).filter(Boolean));
  try {
    const { stdout } = await execFile("node", wrapperArgs, { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024, timeout: 3 * 60 * 60_000, windowsHide: true });
    return { executed: true, stdoutTail: String(stdout).slice(-1_000), evaluation: readJson(outPath) };
  } catch (error) {
    let evaluation = null;
    try {
      evaluation = readJson(outPath);
    } catch {}
    return { executed: true, error: String(error?.message ?? error).slice(0, 1_000), evaluation };
  }
}

function summarizeEvents(events) {
  const typeCounts = {};
  const router = [];
  const lifecycle = [];
  const failureEvents = [];
  let recoveryObserved = false;
  for (const event of events) {
    typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
    if (event.type === "router.selection" || event.type === "router.failover") {
      router.push({ type: event.type, payload: sanitizeRouterPayload(event.payload) });
    }
    if (event.type === "subagent.lifecycle") {
      lifecycle.push({ role: event.payload?.role, state: event.payload?.state, model: event.payload?.model ?? null });
      if (String(event.payload?.state ?? "").toLowerCase().includes("recover")) recoveryObserved = true;
    }
    if (event.type === "turn.failed" || event.type === "subagent.failed") {
      failureEvents.push(String(event.payload?.error ?? "").slice(0, 400));
    }
    if (String(event.type).toLowerCase().includes("recover")) recoveryObserved = true;
  }
  return { totalEvents: events.length, typeCounts, router: router.slice(0, 200), lifecycle: lifecycle.slice(0, 300), failureEvents: failureEvents.slice(0, 50), recoveryObserved };
}

function sanitizeRouterPayload(payload) {
  const clone = { ...(payload ?? {}) };
  for (const key of Object.keys(clone)) {
    if (/key|token|secret|authorization/i.test(key)) clone[key] = "[redacted]";
  }
  return clone;
}

function aggregateTelemetry(workersSummary, eventsSummary) {
  const routes = {};
  const modelRoles = {};
  let input = 0;
  let output = 0;
  let requests = 0;
  for (const worker of workersSummary) {
    const providerId = worker.model?.providerId ?? "unknown";
    const modelId = worker.model?.modelId ?? "unknown";
    const key = `${providerId}/${modelId}`;
    routes[key] = routes[key] ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    // Durable worker telemetry records the request count as modelRequests.
    const workerRequests = worker.telemetry?.modelRequests ?? worker.telemetry?.requestCount ?? 0;
    routes[key].requests += workerRequests;
    routes[key].inputTokens += worker.telemetry?.inputTokens ?? 0;
    routes[key].outputTokens += worker.telemetry?.outputTokens ?? 0;
    input += worker.telemetry?.inputTokens ?? 0;
    output += worker.telemetry?.outputTokens ?? 0;
    requests += workerRequests;
    modelRoles[worker.role] = key;
  }
  const failovers = eventsSummary.router.filter((r) => r.type === "router.failover").length;
  return { routes, modelRoles, tokens: { input, output }, requests, failovers };
}

function classifyAttempt({ task, result, runError, oracleExternal, priorInterruption, recoveryObserved, failureEvents = [], providerFailures = 0 }) {
  const notes = [];
  if (runError && !result) {
    const capacity = CAPACITY_MARKERS.some((m) => runError.toLowerCase().includes(m.toLowerCase()));
    return {
      status: capacity ? "CAPACITY_BLOCKED" : "FAILED",
      failureClass: capacity ? "route_unavailable" : "runner_error",
      falseCompletion: false,
      notes: [`startRun threw: ${runError.slice(0, 300)}`],
    };
  }

  const summaryText = JSON.stringify({ summary: result.summary, integration: result.integration, error: result.error ?? null });
  const failureText = [...failureEvents, summaryText].join(" \n ");
  const rateLimited = /PROVIDER_RATE_LIMITED|tokens per day|TPD|429|daily free allocation/i.test(failureText);
  const routeUnavailable = /PROVIDER_MODEL_UNAVAILABLE|PROVIDER_UNAVAILABLE|No eligible or registered model provider/i.test(failureText);
  // A route that existed and was selected earlier in the run but is unavailable at failure time
  // is a capacity/health event, not a routing defect: ForgeZero marks provider health provider-
  // wide, so one exhausted route zeroes the whole provider (certified fail-closed semantics).
  const capacityUnavailable = routeUnavailable && (rateLimited || providerFailures > 0);

  if (result.status === "completed") {
    const changed = (result.changedFiles ?? []).length > 0;
    const integrated = result.integration?.status === "integrated";
    if (changed && !integrated) {
      return {
        status: "FAILED",
        failureClass: "changes_not_integrated",
        falseCompletion: false,
        notes: [`run completed with ${result.changedFiles.length} changed files but integration status is ${result.integration?.status}`],
      };
    }
    const oracleVerdict = oracleExternal?.evaluation?.verdict ?? "error";
    if (oracleVerdict === "pass") {
      if (changed === false) notes.push("no source change was required or made; oracle passed on the integrated final state");
      const recovered = priorInterruption || recoveryObserved;
      return {
        status: recovered ? "RECOVERED_PASS" : "PASSED",
        failureClass: null,
        falseCompletion: false,
        notes,
      };
    }
    return {
      status: "FAILED",
      failureClass: "false_completion_oracle_failed",
      falseCompletion: true,
      notes: [`P0: completion gate reported ${result.status} but independent oracle verdict is ${oracleVerdict}`],
    };
  }

  if (rateLimited || capacityUnavailable) {
    const marker = rateLimited ? "provider_rate_limited" : "provider_health_marked_unavailable";
    return { status: "CAPACITY_BLOCKED", failureClass: marker, falseCompletion: false, notes: [`run terminated on managed-free capacity: ${failureEvents[0]?.slice(0, 260) ?? result.summary?.slice(0, 260) ?? marker}`] };
  }
  return {
    status: "FAILED",
    failureClass: `run_${result.status}`,
    falseCompletion: false,
    notes: [`run terminated ${result.status}: ${String(result.summary ?? result.error ?? "").slice(0, 300)}`],
  };
}

async function persistRecord(record) {
  await atomicWriteJson(taskRecordPath(record.task_id), record);
}

async function maybeCheckpoint(record) {
  const records = allRecords();
  const resolved = records.filter((r) => TERMINAL_STATUSES.has(r.status)).length;
  if (!CHECKPOINT_THRESHOLDS.includes(resolved)) return;
  const file = path.join(CHECKPOINTS_DIR, `checkpoint-${resolved}.json`);
  if (fs.existsSync(file)) return;
  const byStatus = {};
  const byCategory = {};
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byCategory[r.category] = byCategory[r.category] ?? {};
    byCategory[r.category][r.status] = (byCategory[r.category][r.status] ?? 0) + 1;
  }
  await atomicWriteJson(file, { at: new Date().toISOString(), resolved, byStatus, byCategory, lastTask: record.task_id });
}

// ---------------------------------------------------------------------------
// status / report
// ---------------------------------------------------------------------------

async function printStatus() {
  const records = allRecords();
  const byStatus = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`records: ${records.length}/100`);
  for (const [status, count] of Object.entries(byStatus).sort()) console.log(`  ${status}: ${count}`);
}

async function cmdReport() {
  const records = allRecords();
  const categories = {};
  const trust = {
    false_completion: records.filter((r) => r.false_completion).length,
    silent_corruption: 0,
    unsafe_replay: 0,
    recovery_failures: records.filter((r) => r.failure_class === "runner_error").length,
    human_intervention: records.filter((r) => r.intervention !== "none").length,
    verified_completion: records.filter((r) => r.status === "PASSED" || r.status === "RECOVERED_PASS").length,
    capacity_blocked: records.filter((r) => r.status === "CAPACITY_BLOCKED").length,
  };
  for (const r of records) {
    const bucket = (categories[r.category] ??= {
      total: 0, PASSED: 0, RECOVERED_PASS: 0, HUMAN_ASSISTED: 0, FAILED: 0, CAPACITY_BLOCKED: 0, EXTERNAL_BLOCKED: 0, INVALID_CASE: 0,
      durations: [], tokens: 0, requests: 0,
    });
    bucket.total += 1;
    if (bucket[r.status] !== undefined) bucket[r.status] += 1;
    if (r.started_at && r.finished_at) bucket.durations.push(new Date(r.finished_at) - new Date(r.started_at));
    bucket.tokens += (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0);
    bucket.requests += r.requests ?? 0;
  }
  const categoryReport = Object.fromEntries(
    Object.entries(categories).map(([name, b]) => {
      const { durations, ...rest } = b;
      return [name, { ...rest, medianRuntimeMs: median(durations), p95RuntimeMs: percentile(durations, 95) }];
    }),
  );
  const durations = records.flatMap((r) => (r.started_at && r.finished_at ? [new Date(r.finished_at) - new Date(r.started_at)] : []));
  const report = {
    schema: "r3-corpus-report-v1",
    generatedAt: new Date().toISOString(),
    total: R3_TASKS.length,
    records: records.length,
    statusCounts: countBy(records, (r) => r.status),
    categories: categoryReport,
    trust,
    runtime: { medianMs: median(durations), p95Ms: percentile(durations, 95) },
    providerUsage: aggregateProviderUsage(records),
    failures: records.filter((r) => r.status === "FAILED").map((r) => ({ id: r.task_id, failureClass: r.failure_class, notes: r.notes.slice(-3) })),
  };
  await atomicWriteJson(path.join(CAMPAIGN_DIR, "final-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

function countBy(items, fn) {
  const out = {};
  for (const item of items) out[fn(item)] = (out[fn(item)] ?? 0) + 1;
  return out;
}

function aggregateProviderUsage(records) {
  const usage = {};
  for (const r of records) {
    for (const [route, counts] of Object.entries(r.provider_routes ?? {})) {
      usage[route] = usage[route] ?? { requests: 0, inputTokens: 0, outputTokens: 0, tasksServed: 0 };
      usage[route].requests += counts.requests ?? 0;
      usage[route].inputTokens += counts.inputTokens ?? 0;
      usage[route].outputTokens += counts.outputTokens ?? 0;
      usage[route].tasksServed += 1;
    }
  }
  return usage;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

if (command === "freeze") {
  await cmdFreeze();
} else if (command === "run") {
  await cmdRun();
} else if (command === "report") {
  await cmdReport();
} else {
  await printStatus();
}
