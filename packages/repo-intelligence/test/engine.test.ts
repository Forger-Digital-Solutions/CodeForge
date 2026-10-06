import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence, REPOSITORY_INDEX_VERSION } from "../src/index.js";
import { openSqliteDatabase } from "@codeforge/sessions";

const roots: string[] = [];

function fixture(): { root: string; cache: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-repo-intelligence-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-repo-index-cache-"));
  roots.push(root, cache);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.ts\nnode_modules/\n", "utf8");
  fs.writeFileSync(path.join(root, "ignored.ts"), "export const forbiddenNeedle = true;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "util.ts"), "export function helper(value: string): string { return value; }\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "service.ts"), "import { helper } from './util.js';\nexport class AuthService {\n  verifyToken(token: string): string { return helper(token); }\n}\n", "utf8");
  fs.writeFileSync(path.join(root, "tests", "service.test.ts"), "import { AuthService } from '../src/service.js';\ndescribe('AuthService', () => { it('verifies', () => new AuthService().verifyToken('x')); });\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET_TOKEN=do-not-index\n", "utf8");
  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 3]));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, cache };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalRepositoryIntelligence", () => {
  it("keeps control-plane work responsive during a sparse symbol search and preserves late matches", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    const identity = await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    await intelligence.closeWorkspace();
    const { db } = openSqliteDatabase(path.join(cache, identity.id, "repository-index.sqlite"));
    try {
      const insert = db.prepare("INSERT INTO symbols(id,name,qualified_name,kind,path,start_line,end_line,exported) VALUES($id,$name,$qualified,'variable','src/util.ts',$line,$line,0)");
      db.exec("BEGIN");
      for (let index = 0; index < 6_000; index++) {
        insert.run({ $id: `bulk-${index}`, $name: `bulk${index}`, $qualified: index === 5_999 ? "Scope.LateSearchNeedle" : `Scope.bulk${index}`, $line: index + 1 });
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    await intelligence.openWorkspace(root);
    let controlPlaneRan = false;
    const heartbeat = setImmediate(() => { controlPlaneRan = true; });
    try {
      const late = await intelligence.searchSymbols("latesearchneedle");
      expect(controlPlaneRan).toBe(true);
      expect(late.items.map(symbol => symbol.id)).toEqual(["bulk-5999"]);
      const first = await intelligence.searchSymbols("bulk", { limit: 2 });
      const next = await intelligence.searchSymbols("bulk", { limit: 2, cursor: first.nextCursor });
      expect(first.truncated).toBe(true);
      expect(next.items).toHaveLength(2);
      expect(next.items.every(symbol => !first.items.some(previous => previous.id === symbol.id))).toBe(true);
    } finally {
      clearImmediate(heartbeat);
      await intelligence.closeWorkspace();
    }
  });
  it("keeps the event loop available while Git workspace identity is discovered", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    let controlPlaneRan = false;
    const heartbeat = setImmediate(() => { controlPlaneRan = true; });
    try {
      await intelligence.openWorkspace(root);
      expect(controlPlaneRan).toBe(true);
    } finally {
      clearImmediate(heartbeat);
      await intelligence.closeWorkspace();
    }
  });
  it("replaces FTS rows by indexed identity and migrates legacy caches without stale results", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    const identity = await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    await intelligence.closeWorkspace();
    const databasePath = path.join(cache, identity.id, "repository-index.sqlite");
    const { db } = openSqliteDatabase(databasePath);
    try {
      expect(db.prepare("SELECT COUNT(*) count FROM content_fts_paths").get()).toEqual(db.prepare("SELECT COUNT(*) count FROM content_fts").get());
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT row_id FROM content_fts_paths WHERE path=$path").all({ $path: "src/util.ts" });
      expect(JSON.stringify(plan)).toContain("SEARCH");
      db.exec("DROP TABLE content_fts_paths; DELETE FROM meta WHERE key='fts_paths_ready'");
    } finally { db.close(); }
    try {
      await intelligence.openWorkspace(root);
      fs.writeFileSync(path.join(root, "src", "util.ts"), "export const replacementLexicalNeedle = true;\n");
      await intelligence.refresh(["src/util.ts"]);
      expect((await intelligence.searchText("replacementLexicalNeedle")).items.map(item => item.path)).toEqual(["src/util.ts"]);
      expect((await intelligence.searchText("helper")).items.some(item => item.path === "src/util.ts")).toBe(false);
      expect((await intelligence.searchText("AuthService")).items.some(item => item.path === "src/service.ts")).toBe(true);
      fs.unlinkSync(path.join(root, "src", "util.ts"));
      await intelligence.refresh(["src/util.ts"]);
      expect((await intelligence.searchText("replacementLexicalNeedle")).items).toHaveLength(0);
    } finally { await intelligence.closeWorkspace(); }
  });
  it("rebinds index writes when the same intelligence instance switches repositories", async () => {
    const first = fixture();
    const second = fixture();
    fs.writeFileSync(path.join(first.root, "src", "first.ts"), "export const firstRepositoryOnly = true;\n");
    fs.writeFileSync(path.join(second.root, "src", "second.ts"), "export const secondRepositoryOnly = true;\n");
    const intelligence = createRepositoryIntelligence({ cacheRoot: first.cache });
    try {
      await intelligence.openWorkspace(first.root);
      await intelligence.indexWorkspace();
      expect((await intelligence.searchSymbols("firstRepositoryOnly")).items).toHaveLength(1);
      await intelligence.closeWorkspace();
      await intelligence.openWorkspace(second.root);
      await intelligence.indexWorkspace();
      expect((await intelligence.searchSymbols("firstRepositoryOnly")).items).toHaveLength(0);
      expect((await intelligence.searchSymbols("secondRepositoryOnly")).items).toHaveLength(1);
      fs.writeFileSync(path.join(second.root, "src", "second.ts"), "export const renamedRepositoryOnly = true;\n");
      await intelligence.refresh(["src/second.ts"]);
      expect((await intelligence.searchSymbols("secondRepositoryOnly")).items).toHaveLength(0);
      expect((await intelligence.searchSymbols("renamedRepositoryOnly")).items).toHaveLength(1);
    } finally { await intelligence.closeWorkspace(); }
  });

  it("refreshes cached status counts after another connection commits an index generation", async () => {
    const { root, cache } = fixture();
    const writer = createRepositoryIntelligence({ cacheRoot: cache });
    const reader = createRepositoryIntelligence({ cacheRoot: cache });
    await writer.openWorkspace(root);
    await writer.indexWorkspace();
    await reader.openWorkspace(root);
    try {
      const before = reader.status();
      expect(reader.status().symbolCount).toBe(before.symbolCount);
      fs.writeFileSync(path.join(root, "src", "extra.ts"), "export function addedFunction() { return 1; }\n");
      await writer.refresh(["src/extra.ts"]);
      const after = reader.status();
      expect(after.fileCount).toBe(before.fileCount + 1);
      expect(after.symbolCount).toBe(before.symbolCount + 1);
      expect(after.generation).toBeGreaterThan(before.generation);
      fs.unlinkSync(path.join(root, "src", "extra.ts"));
      await writer.refresh(["src/extra.ts"]);
      expect(reader.status().fileCount).toBe(before.fileCount);
      expect(reader.status().symbolCount).toBe(before.symbolCount);
    } finally {
      await reader.closeWorkspace();
      await writer.closeWorkspace();
    }
  });

  it("retains text-search pagination, scores and redacted previews when only the selected page is rendered", async () => {
    const { root, cache } = fixture();
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(path.join(root, `note${index}.md`), `paginationNeedle sk-abcdefghijklmnopqrst note ${index}\n`);
    }
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    try {
      const all = await intelligence.searchText("paginationNeedle", { limit: 10 });
      const first = await intelligence.searchText("paginationNeedle", { limit: 2 });
      const second = await intelligence.searchText("paginationNeedle", { limit: 2, cursor: first.nextCursor });
      const third = await intelligence.searchText("paginationNeedle", { limit: 2, cursor: second.nextCursor });
      expect([...first.items, ...second.items, ...third.items]).toEqual(all.items);
      expect(all.items).toHaveLength(5);
      expect(third.nextCursor).toBeUndefined();
      for (const match of all.items) {
        expect(match.preview).toContain("paginationNeedle");
        expect(match.preview).toContain("[REDACTED]");
        expect(match.preview).not.toContain("sk-abcdefghijklmnopqrst");
        expect(match.score).toBeGreaterThan(0);
      }
    } finally { await intelligence.closeWorkspace(); }
  });

  it("lets the control plane run between relevance queries and retains useful context", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    let controlPlaneRan = false;
    const pending = setImmediate(() => { controlPlaneRan = true; });
    try {
      const context = await intelligence.findRelevantContext("AuthService verifyToken helper");
      expect(context.items.some(item => item.path === "src/service.ts")).toBe(true);
      expect(controlPlaneRan).toBe(true);
    } finally {
      clearImmediate(pending);
      await intelligence.closeWorkspace();
    }
  });

  it("can cancel while indexing the symbols of one large file without publishing a partial index", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-single-file-index-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-single-file-cache-"));
    roots.push(root, cache);
    fs.writeFileSync(path.join(root, "large.json"), JSON.stringify(Object.fromEntries(
      Array.from({ length: 12_000 }, (_, index) => [`property${index}`, index]),
    ), null, 2));
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const intelligence = createRepositoryIntelligence({
      cacheRoot: cache,
      onProgress: progress => {
        if (progress.phase === "discover") timer = setTimeout(() => controller.abort(), 0);
      },
    });
    await intelligence.openWorkspace(root);
    try {
      await expect(intelligence.indexWorkspace(controller.signal)).rejects.toThrow("cancelled");
      expect(intelligence.status().state).toBe("STALE");
      expect(intelligence.status().symbolCount).toBe(0);
      expect((await intelligence.searchSymbols("property11999")).items).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      await intelligence.closeWorkspace();
    }
  });

  it("persists symbols and dependency/test graphs while respecting ignore, binary, and secret boundaries", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    const identity = await intelligence.openWorkspace(root);
    const status = await intelligence.indexWorkspace();
    expect(status.state).toBe("READY");
    expect(status.indexVersion).toBe(REPOSITORY_INDEX_VERSION);
    expect(status.fileCount).toBeGreaterThanOrEqual(5);
    expect(identity.id).toHaveLength(40);

    const symbols = await intelligence.searchSymbols("AuthService");
    expect(symbols.items[0]?.path).toBe("src/service.ts");
    expect((await intelligence.findDependencies("src/service.ts")).items).toEqual(expect.arrayContaining([expect.objectContaining({ targetPath: "src/util.ts", kind: "imports" })]));
    expect((await intelligence.findDependents("src/service.ts")).items).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePath: "tests/service.test.ts" })]));
    expect((await intelligence.findRelatedTests("src/service.ts")).items[0]?.path).toBe("tests/service.test.ts");
    expect((await intelligence.searchText("forbiddenNeedle")).items).toHaveLength(0);
    expect((await intelligence.searchText("do-not-index")).items).toHaveLength(0);
    expect((await intelligence.getFile("asset.bin"))?.binary).toBe(true);
    await intelligence.closeWorkspace();
  });

  it("refreshes only changed content and removes deleted or renamed symbols", async () => {
    const { root, cache } = fixture();
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    const original = fs.readFileSync(path.join(root, "src", "service.ts"), "utf8");
    fs.writeFileSync(path.join(root, "src", "service.ts"), original, "utf8");
    const touched = await intelligence.refresh(["src/service.ts"]);
    expect(touched.changed).toHaveLength(0);
    expect(touched.unchanged).toBe(1);

    fs.writeFileSync(path.join(root, "src", "service.ts"), original.replace("verifyToken", "validateToken"), "utf8");
    const edited = await intelligence.refresh(["src/service.ts"]);
    expect(edited.changed).toEqual(["src/service.ts"]);
    expect((await intelligence.searchSymbols("verifyToken")).items).toHaveLength(0);
    expect((await intelligence.searchSymbols("validateToken")).items).toHaveLength(1);

    fs.renameSync(path.join(root, "src", "service.ts"), path.join(root, "src", "auth.ts"));
    const renamed = await intelligence.refresh(["src/service.ts", "src/auth.ts"]);
    expect(renamed.deleted).toContain("src/service.ts");
    expect(renamed.added).toContain("src/auth.ts");
    fs.unlinkSync(path.join(root, "src", "auth.ts"));
    const deleted = await intelligence.refresh(["src/auth.ts"]);
    expect(deleted.deleted).toContain("src/auth.ts");
    expect((await intelligence.searchSymbols("validateToken")).items).toHaveLength(0);
    await intelligence.closeWorkspace();
  });

  it("recovers a corrupt disposable index without touching source", async () => {
    const { root, cache } = fixture();
    const first = createRepositoryIntelligence({ cacheRoot: cache });
    await first.openWorkspace(root);
    await first.indexWorkspace();
    const indexPath = first.status().indexPath;
    await first.closeWorkspace();
    fs.writeFileSync(indexPath, "not sqlite", "utf8");
    const second = createRepositoryIntelligence({ cacheRoot: cache });
    await second.openWorkspace(root);
    expect(second.status().state).toBe("NOT_INDEXED");
    expect(fs.readFileSync(path.join(root, "src", "util.ts"), "utf8")).toContain("helper");
    expect((await second.indexWorkspace()).state).toBe("READY");
    await second.closeWorkspace();
  });

  it("indexes a contained workspace even when its parent repository ignores the whole directory", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-ignored-parent-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-ignored-cache-"));
    roots.push(parent, cache);
    const root = path.join(parent, "ignored-workspace");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(parent, ".gitignore"), "ignored-workspace/\n");
    fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"ignored-workspace\"}\n");
    fs.writeFileSync(path.join(root, "src", "index.ts"), "export function nestedNeedle(): boolean { return true; }\n");
    execFileSync("git", ["init", "-q"], { cwd: parent });
    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    const status = await intelligence.indexWorkspace();
    expect(status.fileCount).toBe(2);
    expect((await intelligence.searchSymbols("nestedNeedle")).items[0]?.path).toBe("src/index.ts");
    await intelligence.closeWorkspace();
  });

  it("converges after a branch switch without returning stale symbols", async () => {
    const { root, cache } = fixture();
    fs.writeFileSync(path.join(root, "src", "branch.ts"), "export const branchAOnly = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=CodeForge", "-c", "user.email=codeforge@example.invalid", "commit", "-qm", "branch a"], { cwd: root });
    const branchA = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-qb", "branch-b"], { cwd: root });
    fs.writeFileSync(path.join(root, "src", "branch.ts"), "export const branchBOnly = true;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=CodeForge", "-c", "user.email=codeforge@example.invalid", "commit", "-qm", "branch b"], { cwd: root });
    execFileSync("git", ["checkout", "-q", branchA], { cwd: root });

    const intelligence = createRepositoryIntelligence({ cacheRoot: cache });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    expect((await intelligence.searchSymbols("branchAOnly")).items).toHaveLength(1);
    execFileSync("git", ["checkout", "-q", "branch-b"], { cwd: root });
    await intelligence.refresh();
    expect((await intelligence.searchSymbols("branchAOnly")).items).toHaveLength(0);
    expect((await intelligence.searchSymbols("branchBOnly")).items).toHaveLength(1);
    await intelligence.closeWorkspace();
  });

  it("isolates moved repositories and sibling Git worktrees", async () => {
    const { root, cache } = fixture();
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=CodeForge", "-c", "user.email=codeforge@example.invalid", "commit", "-qm", "initial"], { cwd: root });
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-repo-worktree-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    roots.push(worktree);
    execFileSync("git", ["worktree", "add", "-qb", "parallel-index-test", worktree], { cwd: root });
    const primary = createRepositoryIntelligence({ cacheRoot: cache });
    const sibling = createRepositoryIntelligence({ cacheRoot: cache });
    const primaryIdentity = await primary.openWorkspace(root);
    const siblingIdentity = await sibling.openWorkspace(worktree);
    expect(siblingIdentity.id).not.toBe(primaryIdentity.id);
    expect(sibling.status().indexPath).not.toBe(primary.status().indexPath);
    await primary.closeWorkspace();
    await sibling.closeWorkspace();

    const moved = `${root}-moved`;
    fs.renameSync(root, moved);
    roots.splice(roots.indexOf(root), 1, moved);
    const rebound = createRepositoryIntelligence({ cacheRoot: cache });
    const movedIdentity = await rebound.openWorkspace(moved);
    expect(movedIdentity.id).not.toBe(primaryIdentity.id);
    expect((await rebound.indexWorkspace()).state).toBe("READY");
    await rebound.closeWorkspace();
  });

  it("bounds hostile files, rejects path escapes, supports cancellation, pagination, and concurrent reads", async () => {
    const { root, cache } = fixture();
    fs.writeFileSync(path.join(root, "huge.ts"), `export const hiddenHugeNeedle = true;\n${"x".repeat(1_024)}`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-repo-outside-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "escape.ts"), "export const escapedNeedle = true;\n");
    try { fs.symlinkSync(path.join(outside, "escape.ts"), path.join(root, "escape.ts"), "file"); } catch {}

    const cancelCache = fs.mkdtempSync(path.join(os.tmpdir(), "codeforge-cancel-cache-"));
    roots.push(cancelCache);
    const cancelled = createRepositoryIntelligence({ cacheRoot: cancelCache });
    await cancelled.openWorkspace(root);
    const controller = new AbortController();
    controller.abort();
    await expect(cancelled.indexWorkspace(controller.signal)).rejects.toThrow("cancelled");
    expect(cancelled.status().state).toBe("STALE");
    await cancelled.closeWorkspace();

    const intelligence = createRepositoryIntelligence({ cacheRoot: cache, maxFileBytes: 64 });
    await intelligence.openWorkspace(root);
    await intelligence.indexWorkspace();
    expect((await intelligence.getFile("huge.ts"))?.parserStatus).toBe("skipped");
    expect((await intelligence.searchText("hiddenHugeNeedle")).items).toHaveLength(0);
    expect((await intelligence.searchText("escapedNeedle")).items).toHaveLength(0);
    expect((await intelligence.getFile("../escape.ts"))).toBeUndefined();
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => intelligence.findRelevantContext("AuthService verifyToken", { limit: 2 })));
    expect(concurrent.every((result) => result.items.length > 0 && result.items.length <= 2)).toBe(true);
    const firstPage = await intelligence.listFiles({ limit: 2 });
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).toBe("2");
    await intelligence.closeWorkspace();
  });
});
