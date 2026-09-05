import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PUBLICATION_ERROR_CODES, PublicationError } from "./publication-errors.js";

const execFile = promisify(execFileCallback);
export const MAX_CLOUD_PUBLICATION_ARTIFACT_BYTES = 256 * 1024 * 1024;

export interface CloudPublicationArtifactManifest {
  version: 1;
  publicationId: string;
  deliveryId: string;
  targetRef: string;
  targetSha: string;
  certifiedHead: string;
  certifiedTree: string;
  bytes: number;
  sha256: string;
}

export interface CloudMaterializationInput {
  manifest: CloudPublicationArtifactManifest;
  bundle: Uint8Array;
  maxBytes?: number;
  /** Optional callback receiving the disposable bare object database for a fenced remote push. */
  withRepository?: (bareRepositoryPath: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface CloudMaterializationReceipt {
  publicationId: string;
  certifiedHead: string;
  certifiedTree: string;
  artifactSha256: string;
  artifactBytes: number;
  /** Every ref carried by the bundle, for evidence that no extra ref was smuggled in. */
  bundleRefs: string[];
}

/**
 * Git invoked with every ambient configuration source disabled. Repository code is never checked
 * out and hooks are pointed at a path that cannot exist, so nothing from the bundle executes.
 */
export function cloudGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const hooksPath = path.join(os.tmpdir(), "codeforge-nonexistent-hooks");
  return {
    PATH: process.env.PATH,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
    HOME: path.join(os.tmpdir(), "codeforge-empty-home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: os.tmpdir(),
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksPath,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "protocol.allow",
    GIT_CONFIG_VALUE_2: "never",
    ...extra,
  };
}

const GIT_TIMEOUT_MS = 120_000;

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = cloudGitEnvironment()): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Git refuses to run in a directory it cannot resolve; `protocol.allow=never` blocks remote fetch. */
const SAFE_BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock(\/|$))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export function isSafeBranchName(value: string): boolean {
  if (!value || value.endsWith("/") || value.endsWith(".")) return false;
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value)) return false;
  return SAFE_BRANCH.test(value);
}

/**
 * Cloud-side artifact verifier.
 *
 * It treats bundle bytes as hostile input: everything happens inside a throwaway bare object
 * database with no worktree, no checkout, no hooks, and no ability to reach a network. It stops
 * before any remote side effect unless the caller supplies `withRepository`, which the executor
 * uses to push from the very repository that was just verified.
 */
export class CloudPublicationMaterializer {
  async verify(input: CloudMaterializationInput): Promise<CloudMaterializationReceipt> {
    const { manifest, bundle } = input;
    const maxBytes = input.maxBytes ?? MAX_CLOUD_PUBLICATION_ARTIFACT_BYTES;

    // 1. Metadata shape, before anything touches the filesystem.
    this.assertId(manifest.publicationId);
    this.assertId(manifest.deliveryId);
    this.assertSha(manifest.certifiedHead, PUBLICATION_ERROR_CODES.CERTIFIED_COMMIT_MISMATCH);
    this.assertSha(manifest.certifiedTree, PUBLICATION_ERROR_CODES.CERTIFIED_TREE_MISMATCH);
    this.assertSha(manifest.targetSha, PUBLICATION_ERROR_CODES.TARGET_COMMIT_MISSING);
    if (!isSafeBranchName(manifest.targetRef)) throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);

    // 2. Declared length, then real length, then digest.
    if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > maxBytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_TOO_LARGE);
    if (bundle.byteLength > maxBytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_TOO_LARGE);
    if (bundle.byteLength !== manifest.bytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
    const digest = crypto.createHash("sha256").update(bundle).digest("hex");
    if (digest !== manifest.sha256) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH);

    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-cloud-publication-"));
    const env = cloudGitEnvironment();
    try {
      const repository = path.join(temporary, "objects.git");
      const artifact = path.join(temporary, "delivery.bundle");
      await fs.writeFile(artifact, bundle, { mode: 0o600 });

      // 3. A bare repository: no worktree exists, so no repository content can be checked out.
      await git(temporary, ["init", "--bare", "--quiet", repository], env);

      // 4. The bundle must be structurally valid before it is opened.
      try {
        await git(repository, ["bundle", "verify", artifact], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
      }

      // 5. Unbundle into the disposable object database, then prove object connectivity.
      try {
        await git(repository, ["bundle", "unbundle", artifact], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
      }
      try {
        await git(repository, ["fsck", "--connectivity-only", "--no-dangling", "--strict"], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
      }

      // 6. The certified commit must exist exactly as certified.
      try {
        await git(repository, ["cat-file", "-e", `${manifest.certifiedHead}^{commit}`], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.CERTIFIED_COMMIT_MISMATCH);
      }

      // 7. Its tree must be exactly the certified tree — this is the CF-10 identity carried forward.
      const tree = await git(repository, ["rev-parse", `${manifest.certifiedHead}^{tree}`], env);
      if (tree !== manifest.certifiedTree) throw new PublicationError(PUBLICATION_ERROR_CODES.CERTIFIED_TREE_MISMATCH);
      try {
        await git(repository, ["cat-file", "-e", `${manifest.certifiedTree}^{tree}`], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.CERTIFIED_TREE_MISMATCH);
      }

      // 8. The certified target/base commit must be present…
      try {
        await git(repository, ["cat-file", "-e", `${manifest.targetSha}^{commit}`], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.TARGET_COMMIT_MISSING);
      }

      // 9. …and the certified head must descend from it.
      try {
        await git(repository, ["merge-base", "--is-ancestor", manifest.targetSha, manifest.certifiedHead], env);
      } catch {
        throw new PublicationError(PUBLICATION_ERROR_CODES.ANCESTRY_MISMATCH);
      }

      // 10. No ref beyond ordinary branches may ride along, and every branch tip must be an
      //     ancestor of (or equal to) the certified head: the bundle cannot smuggle a second line.
      const bundleRefs: string[] = [];
      const refOutput = await git(repository, ["show-ref"], env).catch(() => "");
      for (const line of refOutput.split(/\r?\n/).filter(Boolean)) {
        const [sha, ref] = line.split(/\s+/);
        if (!sha || !ref) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
        if (!ref.startsWith("refs/heads/")) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
        if (sha !== manifest.certifiedHead) {
          try {
            await git(repository, ["merge-base", "--is-ancestor", sha, manifest.certifiedHead], env);
          } catch {
            throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_INVALID_BUNDLE);
          }
        }
        bundleRefs.push(ref);
      }

      if (input.withRepository) await input.withRepository(repository, env);

      return {
        publicationId: manifest.publicationId,
        certifiedHead: manifest.certifiedHead,
        certifiedTree: tree,
        artifactSha256: digest,
        artifactBytes: bundle.byteLength,
        bundleRefs,
      };
    } finally {
      // Temporary materialization never survives the call, success or failure.
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private assertId(value: string): void {
    if (!value || value.length > 200 || /[\r\n\0]/.test(value)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_METADATA_MISMATCH);
  }

  private assertSha(value: string, code: (typeof PUBLICATION_ERROR_CODES)[keyof typeof PUBLICATION_ERROR_CODES]): void {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new PublicationError(code);
  }
}
