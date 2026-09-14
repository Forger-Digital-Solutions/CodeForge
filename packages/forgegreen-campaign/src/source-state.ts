import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * FG-11 source-state and campaign-harness identity.
 *
 * Two distinct ids are tracked deliberately (FG-11 hardening amendment §1): `certifiedSourceStateId`
 * covers the certified ForgeGreen B/C/D implementation surface (unchanged detector semantics plus
 * their real evidence-producing seams); `campaignHarnessId` covers the FG-11 campaign code itself
 * (observers, store, aggregator, fixtures, tasks, orchestration). Either one drifting must stop
 * that bucket rather than silently mixing observations across implementations.
 */

export interface FileHashEntry {
  readonly path: string;
  readonly blobHash: string;
}

export interface ContentStateId {
  readonly id: string;
  readonly entries: readonly FileHashEntry[];
}

/** Git blob hash of a file's current on-disk content (works for tracked and untracked files;
 * throws if the file does not exist — a missing material file is itself a hard drift signal). */
function blobHash(repoRoot: string, relativePath: string): string {
  return execFileSync("git", ["hash-object", relativePath], { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** `sha256(JSON.stringify(files sorted lexicographically, each as [path, gitBlobHash]))` —
 * matches `idAlgorithm` recorded in the active lineage source-state document. */
export function computeContentStateId(repoRoot: string, files: readonly string[]): ContentStateId {
  const entries = [...files]
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ path: file, blobHash: blobHash(repoRoot, file) }));
  const id = createHash("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.blobHash]))).digest("hex");
  return { id, entries };
}

export interface CertifiedSourceStateDocument {
  sourceStateId: string;
  surfaceVersion: string;
  materialFiles: readonly string[];
  candidateA: { kind: string; status: string };
  candidateB: { kind: string; status: string };
  candidateC: { kind: string; status: string };
  candidateD: { kind: string; status: string };
}

/** The historical ForgeGreen certificate remains immutable; active work binds to its own
 * explicitly named lineage document so evidence is never silently re-labeled. */
function certifiedSourceStatePath(repoRoot: string): string {
  const active = path.join(repoRoot, "docs", "certification", "codeforge-adaptive-intelligence-r1-source-state.json");
  return fs.existsSync(active) ? active : path.join(repoRoot, "docs", "codeforge-forgegreen-certified-source-state.json");
}

export function loadCertifiedSourceState(repoRoot: string): CertifiedSourceStateDocument {
  return JSON.parse(fs.readFileSync(certifiedSourceStatePath(repoRoot), "utf8")) as CertifiedSourceStateDocument;
}

export interface SourceStateCheckResult {
  stable: boolean;
  expectedId: string;
  currentId: string;
  /** Paths whose current blob hash no longer matches the certified document's recorded hash —
   * empty and meaningless when `stable` is true. */
  changedFiles: string[];
}

/** Verifies the live repository's material files still hash to the certified `sourceStateId`.
 * A drift here means `FG11_SOURCE_STATE_DRIFT` for whatever bucket is currently open (spec §25) —
 * never a silent continuation. */
export function verifyCertifiedSourceState(repoRoot: string, certified: CertifiedSourceStateDocument): SourceStateCheckResult {
  const current = computeContentStateId(repoRoot, certified.materialFiles);
  const docPath = certifiedSourceStatePath(repoRoot);
  const raw = JSON.parse(fs.readFileSync(docPath, "utf8")) as { materialFileHashes?: Record<string, string> };
  const priorHashes = new Map(Object.entries(raw.materialFileHashes ?? {}));
  const changedFiles = current.entries.filter((entry) => priorHashes.get(entry.path) !== entry.blobHash).map((entry) => entry.path);
  return { stable: current.id === certified.sourceStateId, expectedId: certified.sourceStateId, currentId: current.id, changedFiles };
}

/** The FG-11 campaign harness's own files — observers, store, aggregator, fixtures, tasks, and
 * the orchestration entrypoint. Listed explicitly (not glob-derived) so an accidental new file
 * silently entering scope is impossible; adding a real harness file is a deliberate edit here. */
export const CAMPAIGN_HARNESS_FILES: readonly string[] = [
  "packages/forgegreen-campaign/src/candidate-a-observer.ts",
  "packages/forgegreen-campaign/src/candidate-b-observer.ts",
  "packages/forgegreen-campaign/src/candidate-c-observer.ts",
  "packages/forgegreen-campaign/src/candidate-d-observer.ts",
  "packages/forgegreen-campaign/src/observation-store.ts",
  "packages/forgegreen-campaign/src/aggregator.ts",
  "packages/forgegreen-campaign/src/fixtures.ts",
  "packages/forgegreen-campaign/src/tasks.ts",
  "packages/forgegreen-campaign/src/source-state.ts",
  "scripts/forgegreen-fg11-campaign.mjs",
  // FG-12D controlled-trial harness additions.
  "packages/forgegreen-campaign/src/fg12d/trial-receipt.ts",
  "packages/forgegreen-campaign/src/fg12d/trial-runner.ts",
  "packages/forgegreen-campaign/src/fg12d/case-matrix.ts",
  "packages/forgegreen-campaign/src/fg12d/special-cases.ts",
  "scripts/forgegreen-fg12d-trial.mjs",
];

export function computeCampaignHarnessId(repoRoot: string): ContentStateId {
  return computeContentStateId(repoRoot, CAMPAIGN_HARNESS_FILES);
}

/** Frozen identity pair a whole campaign run binds to (amendment §1/§5). Computed once at
 * orchestration start; every observation in the run carries both ids verbatim. */
export interface CampaignIdentity {
  certifiedSourceStateId: string;
  campaignHarnessId: string;
}

export function freezeCampaignIdentity(repoRoot: string): CampaignIdentity {
  const certified = loadCertifiedSourceState(repoRoot);
  const sourceState = verifyCertifiedSourceState(repoRoot, certified);
  if (!sourceState.stable) {
    throw new SourceStateDriftError("FG11_SOURCE_STATE_DRIFT", sourceState);
  }
  const harness = computeCampaignHarnessId(repoRoot);
  return { certifiedSourceStateId: sourceState.currentId, campaignHarnessId: harness.id };
}

export class SourceStateDriftError extends Error {
  constructor(
    message: string,
    public readonly detail: SourceStateCheckResult,
  ) {
    super(message);
    this.name = "SourceStateDriftError";
  }
}
