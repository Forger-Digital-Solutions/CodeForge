import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { terminateProcessTree } from "./child-process.js";
import { prepareShellCommand } from "./child-process.js";
import type { Verifier } from "./types.js";

export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type VerifierId = Brand<string, "VerifierId">;
export type VerifierVersion = Brand<string, "VerifierVersion">;
export type VerificationPlanId = Brand<string, "VerificationPlanId">;
export type VerificationAttemptId = Brand<string, "VerificationAttemptId">;
export type VerificationEvidenceId = Brand<string, "VerificationEvidenceId">;
export type VerificationInputStateHash = Brand<string, "VerificationInputStateHash">;
export type VerificationPolicyVersion = Brand<string, "VerificationPolicyVersion">;

export type VerifierCategory =
  | "typecheck" | "build" | "unit-test" | "integration-test" | "e2e-test"
  | "security" | "lint" | "format" | "git-integrity" | "database"
  | "publication" | "artifact-integrity" | "runtime" | "custom";
export type VerifierRequirement = "required" | "optional" | "advisory";
export type VerificationAttemptStatus =
  | "pending" | "running" | "passed" | "failed" | "cancelled" | "timed_out" | "infra_error" | "interrupted";

export interface StructuredCommand {
  executable: string;
  args: readonly string[];
}

export interface VerifierDefinition {
  id: VerifierId;
  version: VerifierVersion;
  name: string;
  category: VerifierCategory;
  description: string;
  execution: StructuredCommand;
  defaultRequirement: VerifierRequirement;
  timeoutMs: number;
  maxAttempts: number;
  supportedScopes: readonly ("workspace" | "integration" | "publication")[];
}

export interface VerificationPolicy {
  version: VerificationPolicyVersion;
  requiredVerifierIds?: readonly VerifierId[];
  requirementFor?: (definition: VerifierDefinition, input: VerificationPolicyInput) => VerifierRequirement;
}

export interface VerificationPolicyInput {
  runId: string;
  workspacePath: string;
  scope: "workspace" | "integration" | "publication";
  changedPaths?: readonly string[];
  deliveryIntent?: boolean;
  publicationIntent?: boolean;
}

export interface PlannedVerifier {
  verifierId: VerifierId;
  verifierVersion: VerifierVersion;
  definitionDigest: string;
  requirement: VerifierRequirement;
}

export interface VerificationPlan {
  planId: VerificationPlanId;
  runId: string;
  policyVersion: VerificationPolicyVersion;
  workspacePath: string;
  inputStateHash: VerificationInputStateHash;
  scope: "workspace" | "integration" | "publication";
  verifiers: readonly PlannedVerifier[];
  createdAt: string;
}

export interface VerificationAttempt {
  attemptId: VerificationAttemptId;
  planId: VerificationPlanId;
  verifierId: VerifierId;
  verifierVersion: VerifierVersion;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: VerificationAttemptStatus;
  exitCode?: number;
  elapsedMs?: number;
  terminationReason?: "timeout" | "cancelled" | "spawn_error" | "restart";
}

export interface VerificationEvidence {
  evidenceId: VerificationEvidenceId;
  attemptId: VerificationAttemptId;
  planId: VerificationPlanId;
  verifierId: VerifierId;
  verifierVersion: VerifierVersion;
  definitionDigest: string;
  runId: string;
  workspacePath: string;
  inputStateHash: VerificationInputStateHash;
  status: Exclude<VerificationAttemptStatus, "pending" | "running">;
  exitCode?: number;
  elapsedMs: number;
  commandDigest: string;
  outputDigest: string;
  outputExcerpt: string;
  outputTruncated: boolean;
  outputBytes: number;
  createdAt: string;
  evidenceHash: string;
}

export interface VerificationSummary {
  planId: VerificationPlanId;
  requiredCount: number;
  satisfiedCount: number;
  failedCount: number;
  missingCount: number;
  staleCount: number;
  verificationComplete: boolean;
  satisfiedEvidenceIds: readonly VerificationEvidenceId[];
  missingRequiredVerifiers: readonly VerifierId[];
  reasons: readonly VerificationSummaryReason[];
}

export type VerificationSummaryReason = "missing" | "failed" | "cancelled" | "timed_out" | "infra_error" | "interrupted" | "stale" | "definition_changed";

export interface VerificationReceipt {
  planId: VerificationPlanId;
  verifierId: VerifierId;
  evidenceId: VerificationEvidenceId;
  requirement: VerifierRequirement;
  status: VerificationEvidence["status"];
  inputStateHash: VerificationInputStateHash;
  durationMs: number;
}

export interface ForgeVerifyExecution {
  plan: VerificationPlan;
  attempts: readonly VerificationAttempt[];
  evidence: readonly VerificationEvidence[];
  summary: VerificationSummary;
}

export interface ForgeVerifyObserver {
  planCreated?(plan: VerificationPlan): void | Promise<void>;
  attemptStarted?(attempt: VerificationAttempt): void | Promise<void>;
  attemptTerminal?(attempt: VerificationAttempt): void | Promise<void>;
  evidenceCreated?(evidence: VerificationEvidence): void | Promise<void>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function commandDigest(command: StructuredCommand): string {
  return digest({ executable: command.executable, args: [...command.args] });
}

function definitionDigest(definition: VerifierDefinition): string {
  return digest({
    id: definition.id, version: definition.version, category: definition.category,
    execution: { executable: definition.execution.executable, args: [...definition.execution.args] },
    timeoutMs: definition.timeoutMs, maxAttempts: definition.maxAttempts,
  });
}

function redact(value: string): string {
  return value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");
}

function verifierEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "Path", "path", "PATHEXT", "ComSpec", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "USERPROFILE", "SHELL", "TERM", "LANG", "CI", "TMP", "TEMP", "TMPDIR", "SystemDrive", "SystemRoot", "SYSTEMROOT", "WINDIR", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key)));
}

function boundedOutput(value: string, limit = 64 * 1024): { excerpt: string; truncated: boolean; bytes: number } {
  const redacted = redact(value);
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes <= limit) return { excerpt: redacted, truncated: false, bytes };
  return { excerpt: `${Buffer.from(redacted).subarray(0, limit).toString("utf8")}\n[TRUNCATED]`, truncated: true, bytes };
}

export class VerifierRegistry {
  private readonly definitions = new Map<VerifierId, VerifierDefinition>();

  register(definition: VerifierDefinition): void {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(definition.id)) throw new Error("Verifier IDs must be stable lowercase machine identities.");
    if (!definition.version || !definition.execution.executable || definition.timeoutMs <= 0 || definition.maxAttempts < 1) throw new Error("Invalid verifier definition.");
    if (this.definitions.has(definition.id)) throw new Error(`Verifier '${definition.id}' is already registered.`);
    this.definitions.set(definition.id, Object.freeze({ ...definition, execution: Object.freeze({ executable: definition.execution.executable, args: Object.freeze([...definition.execution.args]) }), supportedScopes: Object.freeze([...definition.supportedScopes]) }));
  }

  get(id: VerifierId): VerifierDefinition | undefined { return this.definitions.get(id); }
  all(): readonly VerifierDefinition[] { return [...this.definitions.values()]; }
}

export function createVerifierRegistry(definitions: readonly VerifierDefinition[]): VerifierRegistry {
  const registry = new VerifierRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

function categoryForLegacy(kind: Verifier["kind"]): VerifierCategory {
  if (kind === "test") return "unit-test";
  if (kind === "typecheck") return "typecheck";
  if (kind === "build") return "build";
  if (kind === "lint") return "lint";
  return "custom";
}

/**
 * Transitional adapter for commands admitted by a trusted runtime boundary. It refuses shell-only
 * forms; repository prose and process output never call this function.
 */
export function adaptTrustedLegacyVerifiers(workspacePath: string, verifiers: readonly Verifier[]): readonly VerifierDefinition[] {
  return verifiers.map((legacy) => {
    const prepared = prepareShellCommand(legacy.command, verifierEnvironment(), workspacePath);
    if (prepared.shell) throw new Error(`Legacy verifier '${legacy.id}' requires a shell and cannot enter ForgeVerify.`);
    const execution = { executable: prepared.command, args: prepared.args };
    const stable = digest({ legacyId: legacy.id, kind: legacy.kind, execution }).slice(0, 16);
    return {
      id: `legacy.${legacy.kind}.${stable}` as VerifierId,
      version: `legacy-${stable}` as VerifierVersion,
      name: legacy.id,
      category: categoryForLegacy(legacy.kind),
      description: `Compatibility adapter for trusted verifier '${legacy.id}'.`,
      execution,
      defaultRequirement: legacy.required ? "required" : "advisory",
      timeoutMs: legacy.timeoutMs ?? 60_000,
      maxAttempts: 1,
      supportedScopes: ["workspace", "integration", "publication"],
    } satisfies VerifierDefinition;
  });
}

function gitValue(workspacePath: string, args: readonly string[]): string | undefined {
  try { return execFileSync("git", [...args], { cwd: workspacePath, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; }
}

function directoryHash(root: string): string {
  const files: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push([path.relative(root, full).replaceAll("\\", "/"), createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  };
  visit(root);
  return digest(files.sort(([a], [b]) => a.localeCompare(b)));
}

function untrackedHash(workspacePath: string): string {
  const entries = gitValue(workspacePath, ["ls-files", "--others", "--exclude-standard"]);
  if (entries === undefined) return "no-git";
  return digest(entries.split("\n").filter(Boolean).sort().map((relative) => {
    const file = path.join(workspacePath, relative);
    try { return [relative, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]; } catch { return [relative, "unreadable"]; }
  }));
}

/** Binds evidence to HEAD, dirty tracked changes, untracked contents, and the canonical workspace path. */
export function createVerificationInputStateHash(workspacePath: string): VerificationInputStateHash {
  const resolved = path.resolve(workspacePath);
  const head = gitValue(resolved, ["rev-parse", "HEAD"]) ?? "no-git";
  const tracked = gitValue(resolved, ["diff", "--binary", "HEAD"]) ?? "no-git";
  const untracked = untrackedHash(resolved);
  return digest({ workspacePath: resolved, head, tracked, untracked, ...(head === "no-git" ? { directory: directoryHash(resolved) } : {}) }) as VerificationInputStateHash;
}

export function createVerificationPlan(registry: VerifierRegistry, policy: VerificationPolicy, input: VerificationPolicyInput): VerificationPlan {
  const state = createVerificationInputStateHash(input.workspacePath);
  const verifiers = registry.all().filter((definition) => definition.supportedScopes.includes(input.scope)).map((definition) => {
    const policyRequirement = policy.requirementFor?.(definition, input);
    const requiredByPolicy = policy.requiredVerifierIds?.includes(definition.id) === true;
    const requirement: VerifierRequirement = requiredByPolicy ? "required" : policyRequirement ?? definition.defaultRequirement;
    return { verifierId: definition.id, verifierVersion: definition.version, definitionDigest: definitionDigest(definition), requirement };
  });
  return Object.freeze({ planId: randomUUID() as VerificationPlanId, runId: input.runId, policyVersion: policy.version, workspacePath: path.resolve(input.workspacePath), inputStateHash: state, scope: input.scope, verifiers: Object.freeze(verifiers), createdAt: new Date().toISOString() });
}

export class VerificationEvidenceStore {
  private readonly attempts = new Map<VerificationAttemptId, VerificationAttempt>();
  private readonly evidence = new Map<VerificationAttemptId, VerificationEvidence>();

  start(plan: VerificationPlan, planned: PlannedVerifier): VerificationAttempt {
    const attempt: VerificationAttempt = { attemptId: randomUUID() as VerificationAttemptId, planId: plan.planId, verifierId: planned.verifierId, verifierVersion: planned.verifierVersion, runId: plan.runId, startedAt: new Date().toISOString(), status: "running" };
    this.attempts.set(attempt.attemptId, Object.freeze(attempt));
    return attempt;
  }

  terminal(attemptId: VerificationAttemptId, params: Omit<VerificationEvidence, "evidenceId" | "attemptId" | "planId" | "verifierId" | "verifierVersion" | "runId" | "workspacePath" | "inputStateHash" | "definitionDigest" | "evidenceHash" | "createdAt"> & { plan: VerificationPlan; planned: PlannedVerifier }): VerificationEvidence {
    const existing = this.evidence.get(attemptId);
    if (existing) return existing;
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.status !== "running") throw new Error("Only a running attempt can receive terminal evidence.");
    const base = { evidenceId: randomUUID() as VerificationEvidenceId, attemptId, planId: attempt.planId, verifierId: attempt.verifierId, verifierVersion: attempt.verifierVersion, definitionDigest: params.planned.definitionDigest, runId: attempt.runId, workspacePath: params.plan.workspacePath, inputStateHash: params.plan.inputStateHash, status: params.status, exitCode: params.exitCode, elapsedMs: params.elapsedMs, commandDigest: params.commandDigest, outputDigest: params.outputDigest, outputExcerpt: params.outputExcerpt, outputTruncated: params.outputTruncated, outputBytes: params.outputBytes, createdAt: new Date().toISOString() };
    const record = Object.freeze({ ...base, evidenceHash: digest(base) });
    this.attempts.set(attemptId, Object.freeze({ ...attempt, status: params.status, exitCode: params.exitCode, elapsedMs: params.elapsedMs, finishedAt: record.createdAt, ...(params.status === "timed_out" ? { terminationReason: "timeout" as const } : params.status === "cancelled" ? { terminationReason: "cancelled" as const } : params.status === "infra_error" ? { terminationReason: "spawn_error" as const } : {}) }));
    this.evidence.set(attemptId, record);
    return record;
  }

  recoverInterrupted(): readonly VerificationEvidence[] {
    return [...this.attempts.values()].filter((attempt) => attempt.status === "running").map((attempt) => {
      const evidence = this.terminal(attempt.attemptId, { plan: { planId: attempt.planId, runId: attempt.runId, policyVersion: "recovery" as VerificationPolicyVersion, workspacePath: "recovered", inputStateHash: "recovered" as VerificationInputStateHash, scope: "workspace", verifiers: [], createdAt: attempt.startedAt }, planned: { verifierId: attempt.verifierId, verifierVersion: attempt.verifierVersion, definitionDigest: "recovered", requirement: "required" }, status: "interrupted", elapsedMs: 0, commandDigest: "", outputDigest: digest("runtime restart"), outputExcerpt: "Verifier was interrupted by runtime restart.", outputTruncated: false, outputBytes: 0 });
      return evidence;
    });
  }

  allEvidence(): readonly VerificationEvidence[] { return [...this.evidence.values()]; }
  allAttempts(): readonly VerificationAttempt[] { return [...this.attempts.values()]; }
}

async function executeCommand(definition: VerifierDefinition, workspacePath: string, signal?: AbortSignal): Promise<{ status: VerificationEvidence["status"]; exitCode?: number; elapsedMs: number; output: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let reason: "cancelled" | "timed_out" | undefined;
    let output = "";
    let child: ReturnType<typeof spawn>;
    try { child = spawn(definition.execution.executable, [...definition.execution.args], { cwd: workspacePath, env: verifierEnvironment(), shell: false, windowsHide: true, detached: process.platform !== "win32" }); }
    catch (error) { resolve({ status: "infra_error", elapsedMs: Date.now() - started, output: error instanceof Error ? error.message : String(error) }); return; }
    const finish = (status: VerificationEvidence["status"], exitCode?: number): void => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ status, exitCode, elapsedMs: Date.now() - started, output }); };
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => finish("infra_error", undefined));
    child.once("close", (code) => finish(reason ?? (code === 0 ? "passed" : "failed"), code ?? undefined));
    const stop = (next: "cancelled" | "timed_out"): void => { if (settled || reason) return; reason = next; void terminateProcessTree(child); };
    const abort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), definition.timeoutMs);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function executeVerificationPlan(registry: VerifierRegistry, plan: VerificationPlan, store = new VerificationEvidenceStore(), options: { signal?: AbortSignal; observer?: ForgeVerifyObserver } = {}): Promise<{ attempts: readonly VerificationAttempt[]; evidence: readonly VerificationEvidence[]; summary: VerificationSummary }> {
  await options.observer?.planCreated?.(plan);
  for (const planned of plan.verifiers) {
    const definition = registry.get(planned.verifierId);
    if (!definition || definition.version !== planned.verifierVersion || definitionDigest(definition) !== planned.definitionDigest) continue;
    for (let index = 0; index < definition.maxAttempts; index += 1) {
      const attempt = store.start(plan, planned);
      await options.observer?.attemptStarted?.(attempt);
      const result = await executeCommand(definition, plan.workspacePath, options.signal);
      const output = boundedOutput(result.output);
      const evidence = store.terminal(attempt.attemptId, { plan, planned, status: result.status, exitCode: result.exitCode, elapsedMs: result.elapsedMs, commandDigest: commandDigest(definition.execution), outputDigest: digest(redact(result.output)), outputExcerpt: output.excerpt, outputTruncated: output.truncated, outputBytes: output.bytes });
      await options.observer?.attemptTerminal?.(store.allAttempts().find((candidate) => candidate.attemptId === attempt.attemptId)!);
      await options.observer?.evidenceCreated?.(evidence);
      if (result.status === "passed" || options.signal?.aborted) break;
    }
  }
  return { attempts: store.allAttempts(), evidence: store.allEvidence(), summary: summarizeVerification(plan, registry, store.allEvidence()) };
}

export function summarizeVerification(plan: VerificationPlan, registry: VerifierRegistry, evidence: readonly VerificationEvidence[], currentStateHash = createVerificationInputStateHash(plan.workspacePath)): VerificationSummary {
  const required = plan.verifiers.filter((planned) => planned.requirement === "required");
  const satisfiedEvidenceIds: VerificationEvidenceId[] = [];
  const missingRequiredVerifiers: VerifierId[] = [];
  const reasons: VerificationSummaryReason[] = [];
  let staleCount = 0;
  let failedCount = 0;
  for (const planned of required) {
    const currentDefinition = registry.get(planned.verifierId);
    const candidates = evidence.filter((item) => item.planId === plan.planId && item.verifierId === planned.verifierId && item.verifierVersion === planned.verifierVersion);
    const definitionChanged = !currentDefinition || definitionDigest(currentDefinition) !== planned.definitionDigest || candidates.some((item) => item.definitionDigest !== planned.definitionDigest);
    const stale = currentStateHash !== plan.inputStateHash || candidates.some((item) => item.inputStateHash !== currentStateHash || item.workspacePath !== plan.workspacePath);
    const passed = candidates.find((item) => item.status === "passed" && item.inputStateHash === currentStateHash && item.definitionDigest === planned.definitionDigest && item.workspacePath === plan.workspacePath);
    if (passed && !definitionChanged && !stale) { satisfiedEvidenceIds.push(passed.evidenceId); continue; }
    missingRequiredVerifiers.push(planned.verifierId);
    if (definitionChanged) { staleCount += 1; reasons.push("definition_changed"); }
    else if (stale) { staleCount += 1; reasons.push("stale"); }
    else if (candidates.length === 0) reasons.push("missing");
    else {
      const latest = candidates.at(-1)!;
      if (latest.status === "failed") failedCount += 1;
      reasons.push(latest.status === "passed" ? "missing" : latest.status);
    }
  }
  return Object.freeze({ planId: plan.planId, requiredCount: required.length, satisfiedCount: satisfiedEvidenceIds.length, failedCount, missingCount: missingRequiredVerifiers.length, staleCount, verificationComplete: required.length > 0 && missingRequiredVerifiers.length === 0, satisfiedEvidenceIds: Object.freeze(satisfiedEvidenceIds), missingRequiredVerifiers: Object.freeze(missingRequiredVerifiers), reasons: Object.freeze(reasons) });
}

export function verificationReceipt(plan: VerificationPlan, evidence: VerificationEvidence, requirement: VerifierRequirement): VerificationReceipt {
  return Object.freeze({ planId: plan.planId, verifierId: evidence.verifierId, evidenceId: evidence.evidenceId, requirement, status: evidence.status, inputStateHash: evidence.inputStateHash, durationMs: evidence.elapsedMs });
}
