import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { PUBLICATION_ERROR_CODES, PublicationError } from "./publication-errors.js";

export const MAX_PUBLICATION_ARTIFACT_BYTES = 256 * 1024 * 1024;

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bundle$/;
const TEMP_PREFIX = "upload-";

export interface ArtifactStoreOptions {
  rootDir: string;
  maxBytes?: number;
}

export interface StoredArtifact {
  key: string;
  bytes: number;
  sha256: string;
}

/**
 * Bounded, server-addressed artifact storage.
 *
 * SQL holds only the key; the bundle bytes live on disk under a root the server owns. The key is
 * derived solely from the publication's own UUID — no client-supplied filename or path ever
 * reaches the filesystem — and every read re-validates the key shape and the resolved path.
 */
export class PublicationArtifactStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private ready?: Promise<void>;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? MAX_PUBLICATION_ARTIFACT_BYTES;
  }

  /** Server-controlled key. Rejects anything that is not a bare UUID. */
  keyForPublication(publicationId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicationId)) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_STORAGE_PATH_INVALID);
    }
    return `${publicationId.toLowerCase()}.bundle`;
  }

  /**
   * Resolves a key to an absolute path. Traversal is impossible by construction (the key must match
   * `<uuid>.bundle`) and the resolved path is re-checked to be inside the root regardless.
   */
  resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_STORAGE_PATH_INVALID);
    const resolved = path.resolve(this.rootDir, key);
    const prefix = this.rootDir.endsWith(path.sep) ? this.rootDir : this.rootDir + path.sep;
    if (!resolved.startsWith(prefix)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_STORAGE_PATH_INVALID);
    return resolved;
  }

  async init(): Promise<void> {
    this.ready ??= fs.mkdir(this.rootDir, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  async has(key: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Streams an upload into a temporary file, enforcing the declared byte length and digest as the
   * bytes arrive. Only a complete, matching artifact is renamed into its final key; a failure at
   * any point removes the partial file, so a partial upload can never become executable.
   */
  async store(params: {
    publicationId: string;
    expectedBytes: number;
    expectedSha256: string;
    source: AsyncIterable<Uint8Array> | Readable;
  }): Promise<StoredArtifact> {
    await this.init();
    if (!Number.isSafeInteger(params.expectedBytes) || params.expectedBytes < 0) {
      throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
    }
    if (params.expectedBytes > this.maxBytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_TOO_LARGE);
    if (!/^[0-9a-f]{64}$/.test(params.expectedSha256)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH);

    const key = this.keyForPublication(params.publicationId);
    const finalPath = this.resolve(key);
    if (await this.has(key)) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_ALREADY_STORED);

    const tempPath = path.join(this.rootDir, `${TEMP_PREFIX}${params.publicationId}-${crypto.randomBytes(8).toString("hex")}.part`);
    const handle = await fs.open(tempPath, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let written = 0;
    try {
      for await (const chunk of params.source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written += buffer.byteLength;
        // Enforced during streaming: an oversized body is cut off, never buffered whole.
        if (written > params.expectedBytes || written > this.maxBytes) {
          throw new PublicationError(written > this.maxBytes ? PUBLICATION_ERROR_CODES.ARTIFACT_TOO_LARGE : PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
        }
        hash.update(buffer);
        await handle.write(buffer);
      }
      if (written !== params.expectedBytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
      const digest = hash.digest("hex");
      if (digest !== params.expectedSha256) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH);
      await handle.sync().catch(() => undefined);
      await handle.close();
      try {
        // `link` + `unlink` is the atomic, no-clobber finalize: an existing final artifact makes
        // this fail rather than silently replacing immutable content.
        await fs.link(tempPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_ALREADY_STORED);
        throw error;
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      return { key, bytes: written, sha256: digest };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Reads a stored artifact and re-verifies its digest before any consumer sees the bytes. */
  async read(key: string, expected: { bytes: number; sha256: string }): Promise<Buffer> {
    let bundle: Buffer;
    try {
      bundle = await fs.readFile(this.resolve(key));
    } catch {
      throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_MISSING);
    }
    if (bundle.byteLength !== expected.bytes) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_LENGTH_MISMATCH);
    const digest = crypto.createHash("sha256").update(bundle).digest("hex");
    if (digest !== expected.sha256) throw new PublicationError(PUBLICATION_ERROR_CODES.ARTIFACT_DIGEST_MISMATCH);
    return bundle;
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.resolve(key)).catch(() => undefined);
  }

  /**
   * Restart hygiene: abandoned `.part` files from an interrupted upload carry no durable record and
   * can never be finalized, so they are removed once older than the grace window.
   */
  async sweepPartialUploads(olderThanMs = 60 * 60 * 1000): Promise<number> {
    await this.init();
    let removed = 0;
    const cutoff = Date.now() - olderThanMs;
    for (const entry of await fs.readdir(this.rootDir).catch(() => [] as string[])) {
      if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith(".part")) continue;
      const target = path.join(this.rootDir, entry);
      const stats = await fs.stat(target).catch(() => undefined);
      if (stats && stats.mtimeMs < cutoff) {
        await fs.unlink(target).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }
}
