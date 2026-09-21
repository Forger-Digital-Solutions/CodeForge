import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * R23 task corpus (protocol §4): frozen task directories with a fixture tree the agent works on,
 * a hidden verifier tree injected only after the run, and a `task.json` contract. The manifest
 * pins every task's content hash so a task cannot change after its first run without the
 * harness noticing.
 */

export const TaskClassSchema = z.enum(["small_fix", "bug_fix", "feature", "refactor", "build_config_dependency", "investigation", "large_context", "tiny", "ambiguous", "review_heavy", "test_fix"]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

export const TaskRecordSchema = z.object({
  taskId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  class: TaskClassSchema,
  language: z.string(),
  repoSizeClass: z.enum(["small", "medium", "large"]),
  /** Goal text shown to the agent, verbatim. Must not mention ForgeGreen/efficiency/tokens. */
  goal: z.string().min(10),
  role: z.enum(["coder", "explorer", "reviewer", "planner"]).default("coder"),
  /** Read-only roles may pin the structured contract the run must deliver (R25 review tasks). */
  structuredOutput: z.enum(["explorer", "reviewer"]).optional(),
  permissions: z.object({
    read: z.boolean().default(true),
    search: z.boolean().default(true),
    write: z.boolean(),
    executeCommand: z.boolean().default(false),
    network: z.literal(false).default(false),
  }),
  /** Fixture subdirectory copied into the fresh workspace. */
  fixture: z.string().default("fixture"),
  /** Hidden subdirectory injected into a copy of the resulting workspace before verification. */
  hidden: z.string().default("hidden"),
  /**
   * Commands CodeForge's own ForgeVerify runs on the agent's output inside the run (the repo's
   * own checks, identical in both arms). Never the hidden verifier.
   */
  visibleVerification: z.array(z.string()).default([]),
  verifier: z.object({
    /** Command line executed with cwd = the verification workspace; exit 0 = pass. */
    command: z.string(),
    timeoutMs: z.number().int().positive().default(120_000),
  }),
  /** Investigation tasks: the agent's final summary must satisfy this rule (hidden key). */
  answerKey: z
    .object({
      mode: z.enum(["all_substrings", "regex"]),
      values: z.array(z.string()).min(1),
      caseInsensitive: z.boolean().default(true),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
  /** Optional per-task cap overriding the role default (never raised above the protocol cap). */
  maxModelTurns: z.number().int().positive().max(25).optional(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export interface LoadedTask {
  record: TaskRecord;
  dir: string;
  fixtureDir: string;
  hiddenDir: string;
  /** sha256 over every file in the task directory (relative path + content), sorted. */
  digest: string;
}

export const TaskManifestSchema = z.object({
  manifestVersion: z.union([z.literal("r23-task-manifest-1"), z.literal("r25-task-manifest-1")]),
  frozenAt: z.string(),
  tasks: z.array(z.object({ taskId: z.string(), class: TaskClassSchema, digest: z.string().length(64), batch: z.string() })),
});
export type TaskManifest = z.infer<typeof TaskManifestSchema>;

const FORBIDDEN_GOAL_TERMS = [/forge\s*green/i, /\befficien/i, /\btokens?\b/i, /\bbenchmark/i];

export async function loadTask(dir: string): Promise<LoadedTask> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8")) as unknown;
  const record = TaskRecordSchema.parse(raw);
  for (const term of FORBIDDEN_GOAL_TERMS) {
    if (term.test(record.goal)) throw new Error(`task ${record.taskId}: goal text matches forbidden term ${term} (protocol §4.3)`);
  }
  if (path.basename(dir) !== record.taskId) throw new Error(`task directory ${dir} does not match taskId ${record.taskId}`);
  const fixtureDir = path.join(dir, record.fixture);
  const hiddenDir = path.join(dir, record.hidden);
  await fs.access(fixtureDir);
  await fs.access(hiddenDir);
  return { record, dir, fixtureDir, hiddenDir, digest: await hashTree(dir) };
}

export async function loadTaskCorpus(root: string): Promise<LoadedTask[]> {
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const tasks: LoadedTask[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    tasks.push(await loadTask(path.join(root, name)));
  }
  return tasks;
}

export async function freezeManifest(root: string, batch = "batch-1", now: () => Date = () => new Date(), manifestVersion: TaskManifest["manifestVersion"] = "r23-task-manifest-1"): Promise<TaskManifest> {
  const tasks = await loadTaskCorpus(root);
  return {
    manifestVersion,
    frozenAt: now().toISOString(),
    tasks: tasks.map((task) => ({ taskId: task.record.taskId, class: task.record.class, digest: task.digest, batch })),
  };
}

/** Every manifest entry must match the on-disk task byte-for-byte; extra on-disk tasks are reported. */
export async function verifyManifest(root: string, manifest: TaskManifest): Promise<{ ok: boolean; mismatches: string[]; unlisted: string[] }> {
  const tasks = await loadTaskCorpus(root);
  const byId = new Map(tasks.map((task) => [task.record.taskId, task]));
  const mismatches: string[] = [];
  for (const entry of manifest.tasks) {
    const task = byId.get(entry.taskId);
    if (!task) mismatches.push(`${entry.taskId}: missing on disk`);
    else if (task.digest !== entry.digest) mismatches.push(`${entry.taskId}: digest ${task.digest.slice(0, 12)} != manifest ${entry.digest.slice(0, 12)}`);
  }
  const listed = new Set(manifest.tasks.map((entry) => entry.taskId));
  const unlisted = tasks.map((task) => task.record.taskId).filter((id) => !listed.has(id));
  return { ok: mismatches.length === 0, mismatches, unlisted };
}

export async function hashTree(dir: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const full = path.join(directory, child.name);
      // `.git` is a directory in the target repository but a FILE inside a git worktree; neither is
      // part of the task tree.
      if (child.name === ".git") continue;
      if (child.isDirectory()) {
        if (child.name === "node_modules") continue;
        await visit(full);
      } else {
        const content = await fs.readFile(full);
        entries.push(`${path.relative(dir, full).replace(/\\/g, "/")}:${crypto.createHash("sha256").update(content).digest("hex")}`);
      }
    }
  };
  await visit(dir);
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

/** Snapshot of every file (relative path → content) for exact diff stats afterwards. */
export async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, child.name);
      if (child.name === ".git") continue;
      if (child.isDirectory()) {
        if (child.name === "node_modules") continue;
        await visit(full);
      } else {
        files.set(path.relative(dir, full).replace(/\\/g, "/"), await fs.readFile(full, "utf8"));
      }
    }
  };
  await visit(dir);
  return files;
}

export interface DiffStats {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
}

/** Line-level diff stats (LCS-free: counts lines present in one side but not the other, per file). */
export function diffStats(before: Map<string, string>, after: Map<string, string>): DiffStats {
  const filesChanged: string[] = [];
  let added = 0;
  let removed = 0;
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const file of [...paths].sort()) {
    const b = before.get(file);
    const a = after.get(file);
    if (b === a) continue;
    filesChanged.push(file);
    const bLines = b === undefined ? [] : b.split(/\r?\n/);
    const aLines = a === undefined ? [] : a.split(/\r?\n/);
    const counts = new Map<string, number>();
    for (const line of bLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of aLines) {
      const count = counts.get(line) ?? 0;
      if (count > 0) {
        counts.set(line, count - 1);
        common += 1;
      }
    }
    added += aLines.length - common;
    removed += bLines.length - common;
  }
  return { filesChanged, linesAdded: added, linesRemoved: removed };
}

export interface HiddenVerifierOutcome {
  ran: true;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  testsPassed?: number;
  testsFailed?: number;
}

/**
 * Run the task's hidden verifier in a verification copy: fixture result + hidden files. The
 * agent never sees the hidden tree, and the copy means verification cannot mutate the run's
 * ending tree. A trailing JSON line `{"passed":n,"failed":m}` on stdout is parsed when present.
 */
export async function runHiddenVerifier(task: LoadedTask, resultWorkspace: string, verificationRoot: string, options: { signal?: AbortSignal } = {}): Promise<HiddenVerifierOutcome> {
  await copyTree(resultWorkspace, verificationRoot);
  // The hidden tree keeps its directory name so verifier commands address it as `<hidden>/…`.
  await copyTree(task.hiddenDir, path.join(verificationRoot, task.record.hidden));
  const startedAt = Date.now();
  const [command, ...args] = splitCommand(task.record.verifier.command);
  return new Promise<HiddenVerifierOutcome>((resolve) => {
    // The command line comes from the frozen task record (trusted, hash-pinned). On Windows a
    // shell is needed for `.cmd` shims, so the whole line is handed to the shell as one string.
    const child = process.platform === "win32"
      ? spawn(task.record.verifier.command, { cwd: verificationRoot, shell: true, windowsHide: true, env: { ...process.env, CI: "1", NO_COLOR: "1" } })
      : spawn(command!, args, { cwd: verificationRoot, windowsHide: true, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, task.record.verifier.timeoutMs);
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-64_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-64_000); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ran: true, passed: false, exitCode: null, timedOut, durationMs: Date.now() - startedAt, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const counts = parseTestCounts(stdout);
      resolve({ ran: true, passed: !timedOut && code === 0, exitCode: code, timedOut, durationMs: Date.now() - startedAt, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000), ...counts });
    });
  });
}

function parseTestCounts(stdout: string): { testsPassed?: number; testsFailed?: number } {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines.slice(0, 5)) {
    try {
      const parsed = JSON.parse(line) as { passed?: unknown; failed?: unknown };
      if (typeof parsed.passed === "number" && typeof parsed.failed === "number") return { testsPassed: parsed.passed, testsFailed: parsed.failed };
    } catch {
      // not a JSON summary line
    }
  }
  return {};
}

export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parts;
}

/** Investigation tasks: check the agent's final summary against the hidden key. */
export function answerMatches(summary: string, key: NonNullable<TaskRecord["answerKey"]>): boolean {
  const haystack = key.caseInsensitive ? summary.toLowerCase() : summary;
  if (key.mode === "all_substrings") return key.values.every((value) => haystack.includes(key.caseInsensitive ? value.toLowerCase() : value));
  return key.values.every((value) => new RegExp(value, key.caseInsensitive ? "i" : "").test(summary));
}
