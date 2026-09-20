import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reviewDiff } from "../src/diff-review.js";

/**
 * R21 git-fallback review (no beforeSnapshots). The pre-R21 fallback collapsed the whole
 * `git diff` into a single entry named after the first porcelain row, so path-scoped findings
 * (sensitive files, verification manifests) silently misattributed or missed files entirely,
 * and untracked-only changes collapsed to "No diffs". The fallback now diffs per file against
 * the run base and reports untracked additions as created entries.
 */
describe("reviewDiff git fallback (R21)", () => {
  let ws: string;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: ws, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "r21-diff-git-"));
    git(["init", "-q"]);
    git(["config", "user.name", "r21"]);
    git(["config", "user.email", "r21@codeforge.test"]);
    git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(ws, "README.md"), "# demo\n\ntpyo\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("produces per-file entries so verification-config findings bind to the right path", async () => {
    await writeFile(join(ws, "README.md"), "# demo\n\ntypo\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }, null, 2));
    const review = await reviewDiff(ws);
    const paths = review.diffs.map((d) => d.path).sort();
    expect(paths).toEqual(["README.md", "package.json"]);
    const finding = review.findings.find((f) => f.code === "verification_config_modified");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.path).toBe("package.json");
    expect(review.approved).toBe(false);
  });

  it("reports an untracked sensitive file as a created entry with a blocking finding", async () => {
    await writeFile(join(ws, "README.md"), "# demo\n\ntypo\n");
    await writeFile(join(ws, ".env"), "API_KEY=leaked\n");
    const review = await reviewDiff(ws);
    const created = review.diffs.find((d) => d.path === ".env");
    expect(created?.changeType).toBe("created");
    expect(review.findings.some((f) => f.code === "sensitive_file" && f.path === ".env" && f.severity === "blocking")).toBe(true);
  });

  it("an untracked-only change is still reviewed instead of collapsing to 'No diffs'", async () => {
    await writeFile(join(ws, ".env"), "API_KEY=leaked\n");
    const review = await reviewDiff(ws);
    expect(review.diffs.length).toBe(1);
    expect(review.approved).toBe(false);
  });

  it("diffs against base so changes committed inside the worktree are still reviewed", async () => {
    const base = git(["rev-parse", "HEAD"]).trim();
    await writeFile(join(ws, ".env"), "API_KEY=leaked\n");
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }, null, 2));
    git(["add", ".env", "package.json"]);
    git(["commit", "-q", "-m", "committed-by-coder"]);
    // Uncommitted-state views see nothing; the base diff still binds the whole change.
    const review = await reviewDiff(ws, { base });
    expect(review.findings.some((f) => f.code === "verification_config_modified" && f.path === "package.json")).toBe(true);
    // A committed .env is tracked in the diff, not untracked — path still fires the check.
    expect(review.diffs.some((d) => d.path === ".env")).toBe(true);
    expect(review.approved).toBe(false);
  });

  it("covers staged-but-uncommitted changes via the HEAD fallback", async () => {
    await writeFile(join(ws, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }, null, 2));
    git(["add", "package.json"]);
    const review = await reviewDiff(ws);
    expect(review.findings.some((f) => f.code === "verification_config_modified")).toBe(true);
  });

  it("sinceMs leaves untouched pre-existing untracked files out of the snapshot review", async () => {
    await writeFile(join(ws, ".env"), "API_KEY=pre-existing\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(ws, ".env"), old, old);
    const snapshotTakenAt = Date.now();
    await writeFile(join(ws, "README.md"), "# demo\n\ntypo\n");
    const before = new Map([["README.md", "# demo\n\ntpyo\n"]]);
    const review = await reviewDiff(ws, { beforeSnapshots: before, sinceMs: snapshotTakenAt });
    // .env predates the snapshot: not part of this change, so no sensitive_file finding.
    expect(review.findings.some((f) => f.code === "sensitive_file")).toBe(false);
    // The actual edit is still reported.
    expect(review.diffs.some((d) => d.path === "README.md")).toBe(true);
  });

  it("sinceMs still flags an untracked sensitive file created during the task", async () => {
    const snapshotTakenAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(join(ws, ".env"), "API_KEY=leaked\n");
    const review = await reviewDiff(ws, { beforeSnapshots: new Map([["README.md", "# demo\n\ntpyo\n"]]), sinceMs: snapshotTakenAt });
    expect(review.findings.some((f) => f.code === "sensitive_file" && f.path === ".env")).toBe(true);
  });
});
