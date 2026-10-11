import { promises as fs } from "node:fs";
import path from "node:path";
import { createManifest, sha256Hex, validateManifest, type ForgeAaaAssetManifest } from "./manifest.js";
import { FORGE_AAA_ERRORS, ForgeAaaError } from "./types.js";

/**
 * Versioned asset store (mission §9): one directory per asset, one immutable revision
 * subdirectory per commit. An approved head is never silently replaced — commit() refuses
 * on top of an approved head unless the caller passes `replaceApproved: true` with an
 * explicit reason recorded in the manifest history. Rollback writes a NEW revision whose
 * content restores the target — history is append-only, so recovery itself is auditable.
 */
export class ForgeAaaAssetStore {
  constructor(private readonly rootDir: string) {}

  private assetDir(assetId: string): string {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(assetId)) {
      throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `unsafe assetId "${assetId}"`);
    }
    return path.join(this.rootDir, assetId);
  }

  async revisions(assetId: string): Promise<ForgeAaaAssetManifest[]> {
    const dir = this.assetDir(assetId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const manifests: ForgeAaaAssetManifest[] = [];
    for (const name of names.filter((n) => /^rev-\d+$/.test(n)).sort()) {
      try {
        const raw = await fs.readFile(path.join(dir, name, "manifest.json"), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (validateManifest(parsed).length === 0) manifests.push(parsed as ForgeAaaAssetManifest);
      } catch {
        // A torn write must not poison the store — the revision is simply not listed.
      }
    }
    return manifests.sort((a, b) => a.revision - b.revision);
  }

  async head(assetId: string): Promise<ForgeAaaAssetManifest | undefined> {
    const revs = await this.revisions(assetId);
    return revs.at(-1);
  }

  async revisionDir(assetId: string, revision: number): Promise<string> {
    const dir = path.join(this.assetDir(assetId), `rev-${revision}`);
    await fs.access(dir);
    return dir;
  }

  /**
   * Commit a new revision: files are copied into `rev-N/`, hashed, and the manifest is
   * validated before it becomes head. `approvedHead` marks the result protected.
   */
  async commit(input: {
    manifest: Omit<ForgeAaaAssetManifest, "manifestVersion" | "createdAt" | "revision" | "files"> & { files?: ForgeAaaAssetManifest["files"] };
    /** Absolute file paths to copy into the revision, as [{src, path, role}]. */
    files: { src: string; path: string; role: "source" | "output" | "preview" | "log" }[];
    replaceApproved?: { reason: string };
    approvedHead?: boolean;
  }): Promise<ForgeAaaAssetManifest> {
    const head = await this.head(input.manifest.assetId);
    if (head?.approved === true && !input.replaceApproved) {
      throw new ForgeAaaError(
        FORGE_AAA_ERRORS.ASSET_PROTECTED,
        `asset ${input.manifest.assetId} head rev-${head.revision} is approved — silent replacement refused`,
      );
    }
    const revision = (head?.revision ?? 0) + 1;
    const revDir = path.join(this.assetDir(input.manifest.assetId), `rev-${revision}`);
    await fs.mkdir(revDir, { recursive: true });

    const files: ForgeAaaAssetManifest["files"] = [];
    for (const file of input.files) {
      const safeName = file.path.replace(/[/\\]/g, "_");
      const dest = path.join(revDir, safeName);
      const data = await fs.readFile(file.src);
      await fs.writeFile(dest, data);
      files.push({ path: file.path, role: file.role, sha256: sha256Hex(data), bytes: data.byteLength });
    }
    const manifest = createManifest({
      ...input.manifest,
      revision,
      files: input.manifest.files ?? files,
      ...(head ? { supersedes: `${input.manifest.assetId}@rev-${head.revision}` } : {}),
      ...(input.approvedHead === true ? { approved: true } : {}),
      ...(input.replaceApproved ? { dependencies: [...(input.manifest.dependencies ?? []), `replaced-approved:${input.replaceApproved.reason}`] } : {}),
    });
    await fs.writeFile(path.join(revDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  /**
   * Roll back to an earlier revision by copying its files forward as a new head revision.
   * The rolled-back content is re-hashed and verified against its stored manifest first —
   * a corrupted historical revision blocks the rollback rather than propagating damage.
   */
  async rollback(assetId: string, toRevision: number, opts: { taskId: string; reason: string }): Promise<ForgeAaaAssetManifest> {
    const revs = await this.revisions(assetId);
    const target = revs.find((r) => r.revision === toRevision);
    if (!target) throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `no revision ${toRevision} for ${assetId}`);
    const dir = await this.revisionDir(assetId, toRevision);
    for (const f of target.files) {
      const safeName = f.path.replace(/[/\\]/g, "_");
      const data = await fs.readFile(path.join(dir, safeName));
      if (sha256Hex(data) !== f.sha256) {
        throw new ForgeAaaError(FORGE_AAA_ERRORS.MANIFEST_INVALID, `revision ${toRevision} file ${f.path} hash mismatch — refusing rollback`);
      }
    }
    const files = target.files.map((f) => ({ src: path.join(dir, f.path.replace(/[/\\]/g, "_")), path: f.path, role: f.role }));
    return this.commit({
      manifest: {
        ...target,
        taskId: opts.taskId,
        files: target.files,
        dependencies: [...(target.dependencies ?? []), `rollback-from-rev-${toRevision}:${opts.reason}`],
      },
      files,
      replaceApproved: { reason: `rollback:${opts.reason}` },
    });
  }
}
