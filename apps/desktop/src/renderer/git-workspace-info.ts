/**
 * The single source of truth for "what Git state is this workspace in" — branch AND worktree
 * status computed together from one git invocation, instead of the sidebar/header/composer each
 * running their own ad hoc `git` shell-outs and potentially disagreeing with each other.
 *
 * Worktree detection: a normal repository's `--git-dir` and `--git-common-dir` are the same path
 * (both `<repo>/.git`). A linked worktree's `--git-dir` points at
 * `<main-repo>/.git/worktrees/<name>` while `--git-common-dir` still points at the main repo's
 * shared `.git` — so the two paths differing IS the definition of "this is a worktree." This is
 * the standard mechanism `git worktree` itself relies on; nothing here is invented.
 */

export interface GitWorkspaceInfo {
  isGitRepo: boolean;
  /** null when detached HEAD or not a git repo. */
  branch: string | null;
  isDetached: boolean;
  isWorktree: boolean;
}

const NOT_A_GIT_REPO: GitWorkspaceInfo = { isGitRepo: false, branch: null, isDetached: false, isWorktree: false };

/** One invocation covers branch + both dir paths: `git rev-parse --abbrev-ref HEAD --git-dir --git-common-dir`. */
export const GIT_WORKSPACE_INFO_ARGS = ["rev-parse", "--abbrev-ref", "HEAD", "--git-dir", "--git-common-dir"];

function normalizeDirPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function classifyGitWorkspace(exitCode: number, stdout: string): GitWorkspaceInfo {
  if (exitCode !== 0) return NOT_A_GIT_REPO;
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const [branchRaw, gitDir, gitCommonDir] = lines;
  if (!branchRaw) return NOT_A_GIT_REPO;

  const isDetached = branchRaw === "HEAD";
  const branch = isDetached ? null : branchRaw;
  const isWorktree = Boolean(gitDir && gitCommonDir && normalizeDirPath(gitDir) !== normalizeDirPath(gitCommonDir));

  return { isGitRepo: true, branch, isDetached, isWorktree };
}
