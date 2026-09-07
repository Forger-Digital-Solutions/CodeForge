import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createForgeGreenCacheStore } from "@codeforge/sessions";
import { buildFilePage, buildFilePageIdentity, createContextPageStore } from "../src/pages.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** FG-2 exposes `repositoryNamespace` as stable across worktrees of one repository (shared Git
 * common directory); this is the exact fixture pattern FG-2's own certification suite uses. */
function createRepoWithWorktree(): { main: string; worktree: string; cache: string } {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-xwt-main-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-xwt-cache-"));
  cleanupDirs.push(main, cache);
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  fs.writeFileSync(path.join(main, "src", "shared.ts"), "export function shared(): number { return 42; }\n");
  git(main, ["init", "-q"]);
  git(main, ["config", "user.name", "CodeForge"]);
  git(main, ["config", "user.email", "codeforge@test.local"]);
  // Deterministic bytes: a worktree checkout must be byte-identical to the primary, matching
  // FG-2's own certified cross-worktree fixture pattern (this machine has autocrlf active).
  git(main, ["config", "core.autocrlf", "false"]);
  git(main, ["add", "."]);
  git(main, ["commit", "-qm", "Initial"]);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fg3-xwt-side-"));
  fs.rmdirSync(worktree); // git worktree add requires the target not to exist
  cleanupDirs.push(worktree);
  git(main, ["worktree", "add", "-b", "fg3-side-branch", worktree]);

  return { main, worktree, cache };
}

describe("FG-3D cross-worktree Context Page reuse (FG-2 repositoryNamespace)", () => {
  it("[PASS] a file page built in the main worktree is reused, byte-identical, in a sibling worktree of the same repository", async () => {
    const { main, worktree, cache } = createRepoWithWorktree();
    const intelMain = createRepositoryIntelligence({ cacheRoot: cache });
    await intelMain.openWorkspace(main);
    await intelMain.indexWorkspace();
    const intelSide = createRepositoryIntelligence({ cacheRoot: cache });
    await intelSide.openWorkspace(worktree);
    await intelSide.indexWorkspace();

    const identityMain = await buildFilePageIdentity(intelMain, "src/shared.ts");
    const identitySide = await buildFilePageIdentity(intelSide, "src/shared.ts");
    expect(identityMain!.namespace).toBe(identitySide!.namespace);

    const store = createContextPageStore(await createForgeGreenCacheStore(path.join(cache, "pages.db")));
    const built = await buildFilePage(intelMain, "src/shared.ts", store);
    expect(built?.reused).toBe(false);

    const reused = await buildFilePage(intelSide, "src/shared.ts", store);
    expect(reused?.reused).toBe(true);
    expect(reused?.page.id).toBe(built?.page.id);

    await intelMain.closeWorkspace();
    await intelSide.closeWorkspace();
  });

  it("[PASS] a worktree-local change invalidates only that worktree's page; the unchanged worktree keeps reusing its valid one", async () => {
    const { main, worktree, cache } = createRepoWithWorktree();
    const intelMain = createRepositoryIntelligence({ cacheRoot: cache });
    await intelMain.openWorkspace(main);
    await intelMain.indexWorkspace();
    const intelSide = createRepositoryIntelligence({ cacheRoot: cache });
    await intelSide.openWorkspace(worktree);
    await intelSide.indexWorkspace();
    const store = createContextPageStore(await createForgeGreenCacheStore(path.join(cache, "pages2.db")));

    const original = await buildFilePage(intelMain, "src/shared.ts", store);

    // Dirty the side worktree only.
    fs.writeFileSync(path.join(worktree, "src", "shared.ts"), "export function shared(): number { return 999; }\n");
    await intelSide.refresh(["src/shared.ts"]);
    const dirtySide = await buildFilePage(intelSide, "src/shared.ts", store);
    expect(dirtySide?.page.id).not.toBe(original?.page.id);

    // The main worktree's page is untouched and still validly reusable.
    const stillMain = await buildFilePage(intelMain, "src/shared.ts", store);
    expect(stillMain?.reused).toBe(true);
    expect(stillMain?.page.id).toBe(original?.page.id);

    await intelMain.closeWorkspace();
    await intelSide.closeWorkspace();
  });
});
