import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const MAX_PUBLICATION_ARTIFACT_BYTES = 256 * 1024 * 1024;

export interface PublicationArtifactManifest {
  version: 1;
  publicationId: string;
  deliveryId: string;
  missionId: string;
  repository: string;
  targetRef: string;
  targetSha: string;
  certifiedHead: string;
  certifiedTree: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface PublicationArtifact {
  manifest: PublicationArtifactManifest;
  /** Git bundle bytes are upload-only input for the Cloud executor and are never persisted locally. */
  bundle: Uint8Array;
}

export interface CreatePublicationArtifactOptions {
  workspacePath: string;
  publicationId: string;
  deliveryId: string;
  missionId: string;
  repository: string;
  targetRef: string;
  targetSha: string;
  certifiedHead: string;
  certifiedTree: string;
  maxBytes?: number;
}

function assertId(value: string, name: string): void {
  if (!value || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error(`Invalid publication artifact ${name}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

/**
 * Creates a read-only Git-object transfer.  It never checks out, writes refs, or touches the
 * caller's worktree; the bundle contains the certified commit and the objects needed to verify it.
 */
export async function createPublicationArtifact(options: CreatePublicationArtifactOptions): Promise<PublicationArtifact> {
  for (const [value, name] of Object.entries(options)) if (typeof value === "string") assertId(value, name);
  const [head, tree] = await Promise.all([
    git(options.workspacePath, ["rev-parse", "HEAD"]),
    git(options.workspacePath, ["rev-parse", "HEAD^{tree}"]),
  ]);
  if (head !== options.certifiedHead || tree !== options.certifiedTree) throw new Error("PUBLICATION_ARTIFACT_DELIVERY_CHANGED");
  try {
    await execFile("git", ["merge-base", "--is-ancestor", options.targetSha, options.certifiedHead], { cwd: options.workspacePath, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  } catch {
    throw new Error("PUBLICATION_LINEAGE_INVALID");
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-publication-artifact-"));
  try {
    const bundlePath = path.join(temp, "delivery.bundle");
    await git(options.workspacePath, ["bundle", "create", bundlePath, "HEAD"]);
    const bundle = await fs.readFile(bundlePath);
    const maxBytes = options.maxBytes ?? MAX_PUBLICATION_ARTIFACT_BYTES;
    if (bundle.byteLength > maxBytes) throw new Error("PUBLICATION_ARTIFACT_TOO_LARGE");
    const [finalHead, finalTree] = await Promise.all([
      git(options.workspacePath, ["rev-parse", "HEAD"]),
      git(options.workspacePath, ["rev-parse", "HEAD^{tree}"]),
    ]);
    if (finalHead !== options.certifiedHead || finalTree !== options.certifiedTree) throw new Error("PUBLICATION_ARTIFACT_DELIVERY_CHANGED");
    const sha256 = crypto.createHash("sha256").update(bundle).digest("hex");
    return { bundle, manifest: { version: 1, publicationId: options.publicationId, deliveryId: options.deliveryId, missionId: options.missionId, repository: options.repository, targetRef: options.targetRef, targetSha: options.targetSha, certifiedHead: options.certifiedHead, certifiedTree: options.certifiedTree, bytes: bundle.byteLength, sha256, createdAt: new Date().toISOString() } };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
