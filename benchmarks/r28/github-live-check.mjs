// R28 GitHub live check — AUTHORIZED external mutation. Creates a disposable private
// repo, pushes a real branch, and exercises the production GitHubPullRequestClient
// (assertReady → createPullRequest → findOpenPullRequest) against live GitHub, then
// tears everything down.
//
//   node benchmarks/r28/github-live-check.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubPullRequestClient, normalizeGitHubRemote } from "../../packages/server/dist/github-pr-client.js";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const gh = (args, opts = {}) => execFileSync("gh", args, { encoding: "utf8", ...opts }).trim();
const token = gh(["auth", "token"]);
const owner = JSON.parse(gh(["api", "user"])).login;
const repoName = `cf-r28-proof-${Date.now().toString(36)}`;
const client = new GitHubPullRequestClient(() => token);
let repoCreated = false;

try {
  // 1. normalizeGitHubRemote on real remote forms
  const ident = normalizeGitHubRemote(`https://github.com/${owner}/${repoName}.git`);
  check("normalizeGitHubRemote parses real remote", ident?.owner === owner && ident?.name === repoName, JSON.stringify(ident));
  check("normalizeGitHubRemote rejects non-github", normalizeGitHubRemote("https://gitlab.com/x/y") === undefined, "gitlab rejected");

  // 2. assertReady against the live credential
  await client.assertReady();
  check("assertReady passes with live token", true, "token accepted");

  // 3. Create disposable repo + push a real branch
  gh(["repo", "create", repoName, "--private", "--add-readme"]);
  repoCreated = true;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cf-gh-live-"));
  const git = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.email", "r28@codeforge.test"]);
  git(["config", "user.name", "R28"]);
  git(["remote", "add", "origin", `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`]);
  git(["fetch", "origin"]);
  git(["reset", "--hard", "origin/main"]);
  git(["checkout", "-b", "r28-proof-branch"]);
  fs.writeFileSync(path.join(work, "r28-proof.txt"), `live proof ${new Date().toISOString()}\n`);
  git(["add", "r28-proof.txt"]);
  git(["commit", "-m", "r28 live proof commit"]);
  const headSha = git(["rev-parse", "HEAD"]);
  git(["push", "-u", "origin", "r28-proof-branch"]);
  check("real branch pushed to live repo", true, `sha=${headSha.slice(0, 8)}`);

  // 4. findOpenPullRequest before PR exists → undefined (honest empty)
  const before = await client.findOpenPullRequest(ident, "r28-proof-branch", "main");
  check("findOpenPullRequest before PR → honest empty", before === undefined, JSON.stringify(before));

  // 5. createPullRequest → real PR on live GitHub
  const pr = await client.createPullRequest({
    repository: ident,
    head: "r28-proof-branch",
    base: "main",
    title: "R28 live proof PR",
    body: "Disposable PR created by the R28 GitHub live check. Will be closed and the repo deleted.",
  });
  check("createPullRequest → real open PR", pr.state === "open" && pr.number > 0 && pr.url.includes(`/${repoName}/pull/`), `#${pr.number} ${pr.url}`);

  // 6. findOpenPullRequest now resolves the PR with matching head sha
  const found = await client.findOpenPullRequest(ident, "r28-proof-branch", "main");
  check("findOpenPullRequest resolves the created PR", found?.number === pr.number && found.state === "open", `#${found?.number} head=${found?.head}`);
  check("PR head sha matches pushed commit", found?.headSha === headSha, `${found?.headSha?.slice(0, 8)} vs ${headSha.slice(0, 8)}`);

  // 7. Auth failure path: bad token → REMOTE_AUTH_FAILED, not a silent success
  const badClient = new GitHubPullRequestClient(() => "gho_definitely_invalid_token");
  const badErr = await client.findOpenPullRequest.call(badClient, ident, "r28-proof-branch", "main").then(() => undefined, (e) => e);
  check("invalid token → REMOTE_AUTH_FAILED", badErr?.code === "REMOTE_AUTH_FAILED", badErr?.code ?? "no error");

  // 8. Close the PR via gh (client has no merge/close authority — by design)
  gh(["pr", "close", pr.url, "--comment", "R28 live check complete — closing."]);
  const closed = await client.findOpenPullRequest(ident, "r28-proof-branch", "main");
  check("closed PR no longer found open", closed === undefined, JSON.stringify(closed));
} finally {
  if (repoCreated) {
    try { gh(["repo", "delete", `${owner}/${repoName}`, "--yes"]); } catch (e) { console.error("repo delete failed:", e.message); }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nGITHUB_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-GITHUB-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-github-live-check-1",
  recordedAt: new Date().toISOString(),
  account: owner,
  repo: `${owner}/${repoName} (created + deleted in-check)`,
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);
