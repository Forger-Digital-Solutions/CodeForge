import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createForgeGreenCacheStore, type ForgeGreenCacheStore } from "@codeforge/sessions";
import {
  buildDependencyNeighborhoodPage,
  buildFilePage,
  buildFilePageIdentity,
  contextPageId,
  createContextPageStore,
} from "../src/pages.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function initRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "CodeForge"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codeforge@test.local"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Initial"], { cwd: root });
}

async function repo(): Promise<{ root: string; cacheDbPath: string; intelCache: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-repo-"));
  const intelCache = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-intel-cache-"));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-store-"));
  cleanupDirs.push(root, intelCache, cacheDir);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export function a(): number { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "import { a } from './a.js';\nexport function b(): number { return a() + 1; }\n");
  initRepo(root);
  return { root, cacheDbPath: path.join(cacheDir, "cache.db"), intelCache };
}

async function openIntelligence(root: string, cacheRoot: string): Promise<RepositoryIntelligence> {
  const intelligence = createRepositoryIntelligence({ cacheRoot });
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();
  return intelligence;
}

describe("FG-3D Context Pages — content/graph identity, persistent reuse, fail-safe corruption handling", () => {
  it("[content identity] a file page is a cache miss then a cache hit for identical content", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    const intelligence = await openIntelligence(root, intelCache);
    const store = createContextPageStore(await createForgeGreenCacheStore(cacheDbPath));

    const first = await buildFilePage(intelligence, "src/a.ts", store);
    const second = await buildFilePage(intelligence, "src/a.ts", store);
    expect(first?.reused).toBe(false);
    expect(second?.reused).toBe(true);
    expect(second?.page.id).toBe(first?.page.id);
    await intelligence.closeWorkspace();
  });

  it("[dirty-tree correctness] changed content produces a different page identity, not a stale reuse", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    let intelligence = await openIntelligence(root, intelCache);
    const store = createContextPageStore(await createForgeGreenCacheStore(cacheDbPath));
    const before = await buildFilePage(intelligence, "src/a.ts", store);

    fs.writeFileSync(path.join(root, "src", "a.ts"), "export function a(): number { return 999; }\n");
    await intelligence.refresh(["src/a.ts"]);
    const after = await buildFilePage(intelligence, "src/a.ts", store);

    expect(after?.page.id).not.toBe(before?.page.id);
    expect(after?.reused).toBe(false);
    await intelligence.closeWorkspace();
  });

  it("[cross-session reuse] a second, independently-opened store against the same database file reuses a page built by the first", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    const intelligenceA = await openIntelligence(root, intelCache);
    const storeA = createContextPageStore(await createForgeGreenCacheStore(cacheDbPath));
    const built = await buildFilePage(intelligenceA, "src/a.ts", storeA);
    expect(built?.reused).toBe(false);
    await intelligenceA.closeWorkspace();

    // Simulate a brand-new session/process: fresh RepositoryIntelligence, fresh cache-store
    // handle, same on-disk database file and same repository content.
    const intelligenceB = await openIntelligence(root, intelCache);
    const storeB = createContextPageStore(await createForgeGreenCacheStore(cacheDbPath));
    const reused = await buildFilePage(intelligenceB, "src/a.ts", storeB);
    expect(reused?.reused).toBe(true);
    expect(reused?.page.id).toBe(built?.page.id);
    await intelligenceB.closeWorkspace();
  });

  it("[graph-scoped identity] a comments-only edit does not invalidate the dependency neighborhood page, but an import change does", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    const intelligence = await openIntelligence(root, intelCache);
    const store = createContextPageStore(await createForgeGreenCacheStore(cacheDbPath));
    const before = await buildDependencyNeighborhoodPage(intelligence, "src/b.ts", store);
    expect(before?.reused).toBe(false);

    // Comments-only edit: content hash changes, but the call/import graph does not. A
    // TRAILING comment (not leading) so no existing symbol's line numbers shift — matching
    // FG-2's own certified "comments-only" fixture pattern exactly.
    fs.writeFileSync(path.join(root, "src", "b.ts"), "import { a } from './a.js';\nexport function b(): number { return a() + 1; }\n// a purely cosmetic trailing comment\n");
    await intelligence.refresh(["src/b.ts"]);
    const afterComment = await buildDependencyNeighborhoodPage(intelligence, "src/b.ts", store);
    expect(afterComment?.reused).toBe(true);
    expect(afterComment?.page.id).toBe(before?.page.id);

    // Structural edit: drop the import entirely — the graph generation must advance.
    fs.writeFileSync(path.join(root, "src", "b.ts"), "export function b(): number { return 42; }\n");
    await intelligence.refresh(["src/b.ts"]);
    const afterStructural = await buildDependencyNeighborhoodPage(intelligence, "src/b.ts", store);
    expect(afterStructural?.reused).toBe(false);
    expect(afterStructural?.page.id).not.toBe(before?.page.id);
    expect(afterStructural?.page.data.dependencies).toHaveLength(0);
    await intelligence.closeWorkspace();
  });

  it("[namespace isolation] two different repositories with byte-identical file content never share a page", async () => {
    const repoA = await repo();
    const repoB = await repo(); // independent mkdtemp -> different repositoryNamespace
    const intelA = await openIntelligence(repoA.root, repoA.intelCache);
    const intelB = await openIntelligence(repoB.root, repoB.intelCache);
    const sharedDb = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-shared-"));
    cleanupDirs.push(sharedDb);
    const cacheStore = await createForgeGreenCacheStore(path.join(sharedDb, "cache.db"));
    const store = createContextPageStore(cacheStore);

    const pageA = await buildFilePage(intelA, "src/a.ts", store);
    const pageB = await buildFilePage(intelB, "src/a.ts", store);
    expect(pageA?.reused).toBe(false);
    expect(pageB?.reused).toBe(false); // never served from repo A's namespace despite identical bytes
    const identityA = await buildFilePageIdentity(intelA, "src/a.ts");
    const identityB = await buildFilePageIdentity(intelB, "src/a.ts");
    expect(identityA!.namespace).not.toBe(identityB!.namespace);
    await intelA.closeWorkspace();
    await intelB.closeWorkspace();
  });

  it("[corrupt cache is a safe miss, never a crash] malformed cached JSON recomputes instead of throwing", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    const intelligence = await openIntelligence(root, intelCache);
    const cacheStore = await createForgeGreenCacheStore(cacheDbPath);
    const store = createContextPageStore(cacheStore);
    const identity = await buildFilePageIdentity(intelligence, "src/a.ts");
    expect(identity).toBeDefined();
    const id = contextPageId(identity!);
    await cacheStore.put(identity!.namespace, id, "{ not valid json !!");

    const result = await buildFilePage(intelligence, "src/a.ts", store);
    expect(result?.reused).toBe(false); // treated as a miss, safely recomputed
    expect(result?.page.data.path).toBe("src/a.ts");
    await intelligence.closeWorkspace();
  });

  it("[schema mismatch is a safe miss] a cached value missing required page fields is rejected, not trusted", async () => {
    const { root, cacheDbPath, intelCache } = await repo();
    const intelligence = await openIntelligence(root, intelCache);
    const cacheStore = await createForgeGreenCacheStore(cacheDbPath);
    const store = createContextPageStore(cacheStore);
    const identity = await buildFilePageIdentity(intelligence, "src/a.ts");
    const id = contextPageId(identity!);
    await cacheStore.put(identity!.namespace, id, JSON.stringify({ id, someUnrelatedShape: true }));

    const result = await buildFilePage(intelligence, "src/a.ts", store);
    expect(result?.reused).toBe(false);
    await intelligence.closeWorkspace();
  });

  it("[bounded one-hop] a dependency neighborhood page never exceeds the documented per-edge-kind cap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-fanout-"));
    const intelCache = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-pages-fanout-cache-"));
    cleanupDirs.push(root, intelCache);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const imports = Array.from({ length: 12 }, (_, i) => `import { dep${i} } from './dep${i}.js';`).join("\n");
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, "src", `dep${i}.ts`), `export function dep${i}(): number { return ${i}; }\n`);
    fs.writeFileSync(path.join(root, "src", "hub.ts"), `${imports}\nexport function hub(): number { return 0; }\n`);
    initRepo(root);
    const intelligence = await openIntelligence(root, intelCache);
    const result = await buildDependencyNeighborhoodPage(intelligence, "src/hub.ts");
    expect(result?.page.data.dependencies.length).toBeLessThanOrEqual(5);
    expect(result?.page.data.dependenciesTruncated).toBe(true);
    await intelligence.closeWorkspace();
  });
});
