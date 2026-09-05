import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PUBLICATION_ERROR_CODES, PublicationError } from "./publication-errors.js";
import { cloudGitEnvironment } from "./publication-executor.js";

const execFile = promisify(execFileCallback);

/** The only ref namespace CodeForge will ever create. A user branch is never a push target. */
export const PUBLICATION_REF_PREFIX = "refs/heads/codeforge/publication/";

export function publicationRefFor(publicationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicationId)) {
    throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
  }
  return `${PUBLICATION_REF_PREFIX}${publicationId.toLowerCase()}`;
}

export function isPublicationRef(ref: string): boolean {
  return ref.startsWith(PUBLICATION_REF_PREFIX) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.slice(PUBLICATION_REF_PREFIX.length));
}

export interface GitTransportOptions {
  /** Test-only seam: permits pushing to a controlled local bare repository. */
  allowLocalRemotes?: boolean;
  timeoutMs?: number;
}

export interface PublicationPushRequest {
  /** The disposable bare object database produced by the materializer. */
  sourceRepositoryPath: string;
  /** Built Cloud-side from durable authorization. Never accepted from Desktop. */
  remoteUrl: string;
  /** Ephemeral installation token; held only for the duration of this call. */
  token?: string;
  certifiedHead: string;
  pushRef: string;
  targetBranch: string;
  /** The CF-10-certified target SHA. Re-checked against the live remote immediately before push. */
  expectedTargetSha: string;
}

export interface PublicationPushResult {
  pushRef: string;
  remoteSha: string;
  /** True when the ref already carried the certified commit — a crash-after-push retry. */
  alreadyPresent: boolean;
}

/**
 * Cloud-only privileged Git transport.
 *
 * The installation token reaches Git through an ephemeral askpass helper that reads it from the
 * child's environment. It is therefore absent from argv, from the remote URL, and from any Git
 * config: nothing on disk ever contains it, and the helper script itself is credential-free.
 */
export class GitTransportService {
  private readonly allowLocalRemotes: boolean;
  private readonly timeoutMs: number;

  constructor(options: GitTransportOptions = {}) {
    this.allowLocalRemotes = options.allowLocalRemotes ?? false;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Rejects anything but a bare https GitHub-style URL (or a local path in tests). */
  assertRemoteUrl(remoteUrl: string): void {
    if (typeof remoteUrl !== "string" || !remoteUrl || remoteUrl.length > 512 || /[\s\x00-\x1f]/.test(remoteUrl)) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
    }
    if (this.allowLocalRemotes && (path.isAbsolute(remoteUrl) || remoteUrl.startsWith("file://"))) return;
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
    }
    // A URL carrying userinfo would be a credential in the remote: refuse it outright.
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
    }
  }

  /** Reads one remote ref without mutating anything. Used for the pre-push divergence re-check. */
  async lsRemote(remoteUrl: string, ref: string, token?: string): Promise<string | undefined> {
    this.assertRemoteUrl(remoteUrl);
    return this.withCredentials(token, async (env) => {
      const stdout = await this.git(["ls-remote", "--", remoteUrl, ref], env);
      const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
      if (!line) return undefined;
      const [sha] = line.split(/\s+/);
      if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
      return sha;
    });
  }

  /**
   * The single privileged mutation in CF-11B.
   *
   * The remote target is re-read here, immediately before the push, so a certification that was
   * valid minutes ago cannot publish against a target that has since moved. The push itself is
   * never forced and only ever writes the CodeForge-managed publication ref.
   */
  async publishCertifiedCommit(request: PublicationPushRequest): Promise<PublicationPushResult> {
    this.assertRemoteUrl(request.remoteUrl);
    if (!isPublicationRef(request.pushRef)) throw new PublicationError(PUBLICATION_ERROR_CODES.REF_NAME_INVALID);
    if (!/^[0-9a-f]{40}$/.test(request.certifiedHead) || !/^[0-9a-f]{40}$/.test(request.expectedTargetSha)) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.CERTIFIED_COMMIT_MISMATCH);
    }

    return this.withCredentials(request.token, async (env) => {
      // 1. Target divergence, re-checked against the authoritative remote right before mutating.
      const targetRef = `refs/heads/${request.targetBranch}`;
      const liveTarget = await this.readRef(request.remoteUrl, targetRef, env);
      if (liveTarget !== request.expectedTargetSha) {
        throw new PublicationError(PUBLICATION_ERROR_CODES.PROMOTION_TARGET_DIVERGED);
      }

      // 2. Idempotency: a managed ref already at the certified commit is a completed push.
      const existing = await this.readRef(request.remoteUrl, request.pushRef, env);
      if (existing === request.certifiedHead) {
        return { pushRef: request.pushRef, remoteSha: existing, alreadyPresent: true };
      }
      if (existing) throw new PublicationError(PUBLICATION_ERROR_CODES.PUBLICATION_REF_CONFLICT);

      // 3. Exactly one refspec, no force, no delete, no user branch.
      try {
        await this.git(
          ["push", "--atomic", "--porcelain", "--", request.remoteUrl, `${request.certifiedHead}:${request.pushRef}`],
          env,
          request.sourceRepositoryPath,
        );
      } catch (error) {
        throw this.classifyGitFailure(error);
      }

      // 4. Confirm the remote now holds exactly the certified commit.
      const confirmed = await this.readRef(request.remoteUrl, request.pushRef, env);
      if (confirmed !== request.certifiedHead) throw new PublicationError(PUBLICATION_ERROR_CODES.GIT_PUSH_REJECTED);
      return { pushRef: request.pushRef, remoteSha: confirmed, alreadyPresent: false };
    });
  }

  private async readRef(remoteUrl: string, ref: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    let stdout: string;
    try {
      stdout = await this.git(["ls-remote", "--", remoteUrl, ref], env);
    } catch (error) {
      throw this.classifyGitFailure(error);
    }
    const line = stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
    if (!line) return undefined;
    const [sha] = line.split(/\s+/);
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }

  /**
   * Materialises a credential-free askpass helper for the duration of one operation. The token is
   * passed only through the child environment and the helper is deleted afterwards.
   */
  private async withCredentials<T>(token: string | undefined, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const base = cloudGitEnvironment();
    // The transport must reach the network, so the verifier's protocol lockdown is lifted here and
    // replaced by an explicit allowlist.
    delete base.GIT_CONFIG_COUNT;
    delete base.GIT_CONFIG_KEY_2;
    delete base.GIT_CONFIG_VALUE_2;
    const env: NodeJS.ProcessEnv = {
      ...base,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: path.join(os.tmpdir(), "codeforge-nonexistent-hooks"),
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    };
    if (!token) return run(env);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeforge-git-askpass-"));
    try {
      const helper = path.join(dir, "askpass.cjs");
      // The script reads the secret from its own environment; the file contains no credential.
      await fs.writeFile(
        helper,
        [
          "const prompt = String(process.argv[2] || \"\");",
          "if (/username/i.test(prompt)) { process.stdout.write(\"x-access-token\\n\"); }",
          "else { process.stdout.write(String(process.env.CODEFORGE_GIT_CREDENTIAL || \"\") + \"\\n\"); }",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const entry = process.platform === "win32" ? path.join(dir, "askpass.cmd") : path.join(dir, "askpass.sh");
      await fs.writeFile(
        entry,
        process.platform === "win32"
          ? `@echo off\r\n"%CODEFORGE_GIT_ASKPASS_NODE%" "%~dp0askpass.cjs" %*\r\n`
          : `#!/bin/sh\nexec "$CODEFORGE_GIT_ASKPASS_NODE" "$(dirname "$0")/askpass.cjs" "$@"\n`,
        { mode: 0o700 },
      );
      return await run({
        ...env,
        GIT_ASKPASS: entry,
        CODEFORGE_GIT_ASKPASS_NODE: process.execPath,
        CODEFORGE_GIT_CREDENTIAL: token,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async git(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
    const { stdout } = await execFile("git", args, {
      ...(cwd ? { cwd } : {}),
      env,
      timeout: this.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  /**
   * Git's stderr can echo a URL, a prompt, or an upstream error body. None of it is propagated:
   * the failure becomes a fixed code, and the original error object is dropped entirely.
   */
  private classifyGitFailure(error: unknown): PublicationError {
    const raw = error instanceof Error ? `${error.message} ${(error as { stderr?: string }).stderr ?? ""}` : "";
    if (/authentication|403 forbidden|401|could not read username|terminal prompts disabled/i.test(raw)) {
      return new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_AUTH_FAILED);
    }
    if (/timed out|timeout|could not resolve host|connection reset|502|503|504/i.test(raw)) {
      return new PublicationError(PUBLICATION_ERROR_CODES.GITHUB_TEMPORARY_FAILURE);
    }
    return new PublicationError(PUBLICATION_ERROR_CODES.GIT_PUSH_REJECTED);
  }
}
