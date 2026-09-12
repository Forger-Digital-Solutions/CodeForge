import { describe, it, expect } from "vitest";
import { classifyGitWorkspace } from "../src/renderer/git-workspace-info.js";

describe("classifyGitWorkspace", () => {
  it("reports not-a-git-repo truthfully instead of rendering a bogus branch", () => {
    const result = classifyGitWorkspace(128, "");
    expect(result).toEqual({ isGitRepo: false, branch: null, isDetached: false, isWorktree: false });
  });

  it("parses a normal repository on a named branch, not a worktree", () => {
    const stdout = "feat/forgegreen\n/repo/.git\n/repo/.git\n";
    const result = classifyGitWorkspace(0, stdout);
    expect(result).toEqual({ isGitRepo: true, branch: "feat/forgegreen", isDetached: false, isWorktree: false });
  });

  it("reports detached HEAD truthfully with a null branch", () => {
    const stdout = "HEAD\n/repo/.git\n/repo/.git\n";
    const result = classifyGitWorkspace(0, stdout);
    expect(result.isGitRepo).toBe(true);
    expect(result.isDetached).toBe(true);
    expect(result.branch).toBeNull();
  });

  it("detects a linked worktree by git-dir/git-common-dir divergence", () => {
    const stdout = "feature-x\n/main-repo/.git/worktrees/feature-x\n/main-repo/.git\n";
    const result = classifyGitWorkspace(0, stdout);
    expect(result.isGitRepo).toBe(true);
    expect(result.isWorktree).toBe(true);
    expect(result.branch).toBe("feature-x");
  });

  it("normalizes Windows backslash paths and trailing slashes before comparing", () => {
    const stdout = "main\nC:\\repo\\.git\\\nC:\\repo\\.git\n";
    const result = classifyGitWorkspace(0, stdout);
    expect(result.isWorktree).toBe(false);
  });

  it("treats a worktree with the same branch name pattern as still detectable via dir divergence", () => {
    const stdout = "main\nC:\\main\\.git\\worktrees\\wt1\nC:\\main\\.git\n";
    const result = classifyGitWorkspace(0, stdout);
    expect(result.isWorktree).toBe(true);
  });

  it("does not crash or misclassify on empty stdout despite exit code 0", () => {
    const result = classifyGitWorkspace(0, "");
    expect(result.isGitRepo).toBe(false);
  });
});
