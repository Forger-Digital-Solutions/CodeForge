/**
 * Remote marketplace catalog — fetch a publisher-signed index over HTTPS, verify it against
 * pinned ed25519 keys, and install integrity-verified extension packages into the managed
 * extensions dir.
 *
 * Trust model (fail closed on every check):
 *  - The index is a `codeforge-marketplace-index-1` document carrying a detached ed25519
 *    signature over the canonical JSON of everything except the signature itself. Unsigned
 *    indexes, unknown key ids, and bad signatures are all rejected — there is no "warn and
 *    continue" path.
 *  - Sources pin their trusted keys in client config; the index cannot introduce new keys.
 *  - Transport is HTTPS-only. Loopback HTTP (127.0.0.1/localhost) is allowed only when a
 *    caller explicitly opts into `allowInsecureLoopback` for local development.
 *  - Packages are `codeforge-extension-package-1` JSON bundles: the downloaded bytes must
 *    match the entry's sha256, every file inside must match its own sha256, and every path
 *    must be a safe relative path inside the extension folder.
 *  - Size caps bound the index, the package, and each extracted file.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseExtensionManifest, type ExtensionManifest } from "./manifest.js";

export const MARKETPLACE_INDEX_SCHEMA = "codeforge-marketplace-index-1";
export const MARKETPLACE_PACKAGE_SCHEMA = "codeforge-extension-package-1";

export const MARKETPLACE_ERRORS = {
  MARKETPLACE_TRANSPORT: "MARKETPLACE_TRANSPORT",
  MARKETPLACE_UNSIGNED: "MARKETPLACE_UNSIGNED",
  MARKETPLACE_BAD_SIGNATURE: "MARKETPLACE_BAD_SIGNATURE",
  MARKETPLACE_UNTRUSTED_KEY: "MARKETPLACE_UNTRUSTED_KEY",
  MARKETPLACE_INVALID_INDEX: "MARKETPLACE_INVALID_INDEX",
  MARKETPLACE_INVALID_PACKAGE: "MARKETPLACE_INVALID_PACKAGE",
  MARKETPLACE_HASH_MISMATCH: "MARKETPLACE_HASH_MISMATCH",
  MARKETPLACE_UNSAFE_PATH: "MARKETPLACE_UNSAFE_PATH",
  MARKETPLACE_TOO_LARGE: "MARKETPLACE_TOO_LARGE",
} as const;
export type MarketplaceErrorCode = (typeof MARKETPLACE_ERRORS)[keyof typeof MARKETPLACE_ERRORS];

export class MarketplaceError extends Error {
  constructor(public readonly code: MarketplaceErrorCode, message: string) {
    super(message);
    this.name = "MarketplaceError";
  }
}

const CatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/).max(120),
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().max(500).default(""),
  publisher: z.string().min(1).max(100),
  downloadUrl: z.string().url().max(2000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive().max(64 * 1024 * 1024),
  permissions: z.array(z.string().max(80)).max(20).default([]),
  engines: z.object({ codeforge: z.string().max(40) }).optional(),
});
export type MarketplaceCatalogEntry = z.infer<typeof CatalogEntrySchema>;

const IndexSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: z.string().min(1).max(120),
  value: z.string().min(1).max(4000),
});

const IndexSchema = z
  .object({
    schema: z.literal(MARKETPLACE_INDEX_SCHEMA),
    publisher: z.string().min(1).max(200),
    generatedAt: z.string().min(1).max(60),
    extensions: z.array(CatalogEntrySchema).max(500),
    signature: IndexSignatureSchema,
  })
  .strict();
export type MarketplaceIndex = z.infer<typeof IndexSchema>;

const PackageFileSchema = z.object({
  path: z.string().min(1).max(400),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  content: z.string(),
});
const PackageSchema = z
  .object({
    schema: z.literal(MARKETPLACE_PACKAGE_SCHEMA),
    manifest: z.unknown(),
    files: z.array(PackageFileSchema).min(1).max(200),
  })
  .strict();
export interface ExtensionPackageFile { path: string; sha256: string; content: string }
export interface ExtensionPackage { manifest: ExtensionManifest; files: ExtensionPackageFile[] }

/** A configured catalog source: an index URL plus the ed25519 keys (base64 SPKI DER) trusted for it. */
export interface MarketplaceSource {
  url: string;
  trustedKeys: Record<string, string>;
  enabled?: boolean;
}

export interface FetchResponse {
  status: number;
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: { redirect: "follow"; signal: AbortSignal }) => Promise<FetchResponse>;

export interface MarketplaceClientOptions {
  fetchImpl?: FetchLike;
  /** keyId -> base64-encoded ed25519 public key (DER SPKI). */
  trustedKeys: Record<string, string>;
  /** Dev/test only: permits http:// on 127.0.0.1/localhost/[::1]. Never set in production. */
  allowInsecureLoopback?: boolean;
  maxIndexBytes?: number;
  maxPackageBytes?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
}

/** Deterministic JSON: sorted object keys at every depth, no insignificant whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/** Relative POSIX-style path only: no traversal, absolutes, drives, or backslash tricks. */
function assertSafeRelativePath(relPath: string): string {
  if (/^[a-zA-Z]:/.test(relPath) || relPath.startsWith("/") || relPath.startsWith("\\") || relPath.includes("\\")) {
    throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_UNSAFE_PATH, `Unsafe package path "${relPath.slice(0, 80)}"`);
  }
  const segments = relPath.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_UNSAFE_PATH, `Unsafe package path "${relPath.slice(0, 80)}"`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(relPath)) {
    throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_UNSAFE_PATH, `Disallowed characters in package path "${relPath.slice(0, 80)}"`);
  }
  return segments.join("/");
}

export class MarketplaceClient {
  private readonly fetchImpl: FetchLike;
  private readonly trustedKeys: Record<string, string>;
  private readonly allowInsecureLoopback: boolean;
  private readonly maxIndexBytes: number;
  private readonly maxPackageBytes: number;
  private readonly maxFileBytes: number;
  private readonly timeoutMs: number;

  constructor(opts: MarketplaceClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
    this.trustedKeys = opts.trustedKeys;
    this.allowInsecureLoopback = opts.allowInsecureLoopback === true;
    this.maxIndexBytes = opts.maxIndexBytes ?? 1024 * 1024;
    this.maxPackageBytes = opts.maxPackageBytes ?? 8 * 1024 * 1024;
    this.maxFileBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private assertTransport(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT, `Malformed URL "${url.slice(0, 120)}"`);
    }
    if (parsed.protocol === "https:") return parsed;
    if (parsed.protocol === "http:" && this.allowInsecureLoopback && isLoopbackHost(parsed.hostname)) return parsed;
    throw new MarketplaceError(
      MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT,
      `Refusing ${parsed.protocol}//${parsed.hostname} — marketplace transport is HTTPS only`,
    );
  }

  private async get(url: string, cap: number, what: string): Promise<Buffer> {
    this.assertTransport(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: FetchResponse;
    try {
      res = await this.fetchImpl(url, { redirect: "follow", signal: controller.signal });
    } catch (error) {
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT,
        `${what} fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    this.assertTransport(res.url || url);
    if (res.status !== 200) {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_TRANSPORT, `${what} fetch returned HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > cap) {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_TOO_LARGE, `${what} is ${bytes.length} bytes (cap ${cap})`);
    }
    return bytes;
  }

  /** Fetch + fully verify a source index. Throws MarketplaceError on any trust failure. */
  async fetchIndex(sourceUrl: string): Promise<MarketplaceIndex> {
    const bytes = await this.get(sourceUrl, this.maxIndexBytes, "Catalog index");
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_INVALID_INDEX, "Index is not valid JSON");
    }
    const parsed = IndexSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_INVALID_INDEX,
        `Index failed schema validation — ${issue ? `${issue.path.join(".") || "index"}: ${issue.message}` : "unknown"}`,
      );
    }
    const index = parsed.data;
    this.verifyIndexSignature(index);
    return index;
  }

  private verifyIndexSignature(index: MarketplaceIndex): void {
    const { signature, ...unsigned } = index;
    const keyB64 = this.trustedKeys[signature.keyId];
    if (!keyB64) {
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_UNTRUSTED_KEY,
        `Index signed with unknown key "${signature.keyId}"`,
      );
    }
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature.value, "base64");
      if (signatureBytes.length !== 64) throw new Error("bad length");
    } catch {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_BAD_SIGNATURE, "Signature is not valid base64 ed25519");
    }
    const publicKey = createPublicKey({ key: Buffer.from(keyB64, "base64"), format: "der", type: "spki" });
    const ok = cryptoVerify(null, Buffer.from(canonicalize(unsigned), "utf8"), publicKey, signatureBytes);
    if (!ok) {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_BAD_SIGNATURE, "Index signature does not verify");
    }
  }

  /** Download + hash-verify + parse a catalog entry's package bundle. */
  async fetchPackage(entry: MarketplaceCatalogEntry): Promise<ExtensionPackage> {
    this.assertTransport(entry.downloadUrl);
    const bytes = await this.get(entry.downloadUrl, this.maxPackageBytes, `Package ${entry.id}`);
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_HASH_MISMATCH,
        `Package ${entry.id} sha256 ${actual} does not match catalog ${entry.sha256}`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE, "Package is not valid JSON");
    }
    const parsed = PackageSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE,
        `Package failed schema validation — ${issue ? `${issue.path.join(".") || "package"}: ${issue.message}` : "unknown"}`,
      );
    }
    const manifest = parseExtensionManifest(parsed.data.manifest);
    if (manifest.id !== entry.id) {
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE,
        `Package manifest id "${manifest.id}" does not match catalog entry "${entry.id}"`,
      );
    }
    const seen = new Set<string>();
    const files: ExtensionPackageFile[] = parsed.data.files.map((file) => {
      const rel = assertSafeRelativePath(file.path);
      if (seen.has(rel)) {
        throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE, `Duplicate package path "${rel}"`);
      }
      seen.add(rel);
      const content = Buffer.from(file.content, "base64");
      if (content.length > this.maxFileBytes) {
        throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_TOO_LARGE, `Package file "${rel}" is ${content.length} bytes (cap ${this.maxFileBytes})`);
      }
      if (sha256Hex(content) !== file.sha256) {
        throw new MarketplaceError(MARKETPLACE_ERRORS.MARKETPLACE_HASH_MISMATCH, `Package file "${rel}" failed its sha256 check`);
      }
      return { path: rel, sha256: file.sha256, content: file.content };
    });
    // The manifest itself must be inside the package — an index of files with no manifest is not installable.
    if (!files.some((f) => f.path === "codeforge-extension.json")) {
      files.push({ path: "codeforge-extension.json", sha256: "", content: Buffer.from(JSON.stringify(parsed.data.manifest)).toString("base64") });
    }
    return { manifest, files };
  }

  /**
   * Download, verify, and extract a package under `extensionsDir/<entry.id>`.
   * The extension dir is written atomically-ish: files go to a temp sibling dir first, then
   * rename — a failed install never leaves a half-written extension in the managed dir.
   */
  async install(entry: MarketplaceCatalogEntry, extensionsDir: string): Promise<{ dir: string; manifest: ExtensionManifest }> {
    const pkg = await this.fetchPackage(entry);
    const destDir = path.join(extensionsDir, entry.id);
    if (fs.existsSync(destDir)) {
      throw new MarketplaceError(
        MARKETPLACE_ERRORS.MARKETPLACE_INVALID_PACKAGE,
        `Extension "${entry.id}" is already installed — uninstall it before installing a catalog version`,
      );
    }
    const tmpDir = path.join(extensionsDir, `.tmp-${entry.id}-${Date.now().toString(36)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      for (const file of pkg.files) {
        const target = path.join(tmpDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(file.content, "base64"));
      }
      fs.renameSync(tmpDir, destDir);
    } catch (error) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw error;
    }
    return { dir: destDir, manifest: pkg.manifest };
  }
}

/** Sign an unsigned index payload — used by catalog publishers and by tests. */
export function signMarketplaceIndex(
  unsigned: Omit<MarketplaceIndex, "signature">,
  privateKeyDerBase64: string,
  keyId: string,
): MarketplaceIndex {
  const key = createPrivateKey({ key: Buffer.from(privateKeyDerBase64, "base64"), format: "der", type: "pkcs8" });
  const signature = cryptoSign(null, Buffer.from(canonicalize(unsigned), "utf8"), key);
  return { ...unsigned, signature: { algorithm: "ed25519", keyId, value: signature.toString("base64") } };
}
