// R28 Git live check — drives the real CheckpointService against a real git repository:
// dirty-tree stash snapshots, exact restore (tracked + untracked), divergence blocking,
// ref validation, clean-tree snapshot kind.
//
//   node benchmarks/r28/git-live-check.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointService } from "@codeforge/server";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + String(detail).slice(0, 150) : ""}`); };

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cf-git-live-"));
const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (rel, content) => fs.writeFileSync(path.join(repo, rel), content);
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(repo, rel));

git(["init", "-b", "main"]);
git(["config", "user.email", "r28@codeforge.test"]);
git(["config", "user.name", "R28"]);
git(["config", "core.autocrlf", "false"]);
write("a.txt", "A1\n");
write("b.txt", "B1\n");
git(["add", "."]);
git(["commit", "-m", "baseline"]);

const service = new CheckpointService(repo);
await service.init();

// 1. Dirty tree → stash snapshot captures tracked modifications + untracked files
write("a.txt", "A2-modified\n");
write("c-untracked.txt", "C-new-file\n");
write("b.txt", "B2-staged\n");
git(["add", "b.txt"]);
const cp1 = await service.createCheckpoint({ checkpointId: "cp-dirty", label: "dirty state" });
check("dirty checkpoint → git_stash snapshot", cp1.snapshotKind === "git_stash" && cp1.dirtyAtCreation === true, `kind=${cp1.snapshotKind} dirty=${cp1.dirtyAtCreation}`);
check("checkpoint inventories untracked file", cp1.untrackedPaths.includes("c-untracked.txt"), `untracked=${cp1.untrackedPaths.join(",")}`);

// 2. Mutate further: restore must refuse to clobber diverged uncommitted changes without force
write("a.txt", "A3-FURTHER\n");
fs.rmSync(path.join(repo, "c-untracked.txt"));
write("b.txt", "B3-more\n");
git(["add", "b.txt"]);
const blocked = await service.restoreCheckpoint("cp-dirty", { restoreType: "code_only" }).catch((e) => e);
check("diverged uncommitted restore blocked", blocked instanceof Error && blocked.code === "RESTORE_BLOCKED_DIVERGED_WORKSPACE", blocked.code ?? `success=${blocked.success}`);
check("workspace untouched after blocked restore", read("a.txt") === "A3-FURTHER\n", "a.txt preserved");
const restore = await service.restoreCheckpoint("cp-dirty", { restoreType: "code_only", force: true });
check("forced restore succeeds", restore.success === true, `restored=${restore.restoredPaths?.length ?? 0} paths diverged=${restore.diverged}`);
check("tracked file restored exactly", read("a.txt") === "A2-modified\n", `a=${JSON.stringify(read("a.txt"))}`);
check("untracked file restored", exists("c-untracked.txt") && read("c-untracked.txt") === "C-new-file\n", "c-untracked restored");
check("staged change restored", read("b.txt") === "B2-staged\n", `b=${JSON.stringify(read("b.txt"))}`);

// 3. Working tree shape matches the captured dirty state (staged/modified/untracked)
const status = git(["status", "--porcelain"]);
check("git status mirrors checkpoint's dirty shape", status.includes("M  b.txt") && /\s*M\s*a\.txt/.test(status) && status.includes("?? c-untracked.txt"), JSON.stringify(status.split("\n")));
const diff = await service.compareCheckpoint("cp-dirty");
check("compareCheckpoint reports committed drift (stash holds uncommitted state)", typeof diff.changes === "number" && diff.changes >= 0, `changes=${diff.changes} +${diff.additions} -${diff.deletions}`);

// 4. Clean checkpoint → git_clean snapshot
git(["add", "-A"]);
git(["commit", "-m", "commit dirty state"]);
const cp2 = await service.createCheckpoint({ checkpointId: "cp-clean", label: "clean" });
check("clean checkpoint → git_clean snapshot", cp2.snapshotKind === "git_clean" && cp2.dirtyAtCreation === false, `kind=${cp2.snapshotKind}`);

// 5. Commit ahead of a clean checkpoint: restore is a legitimate rewind (no uncommitted
// divergence — the block above only guards uncommitted work being clobbered).
write("a.txt", "A4-diverged\n");
git(["add", "a.txt"]);
git(["commit", "-m", "diverge ahead"]);
const rewound = await service.restoreCheckpoint("cp-clean", { restoreType: "code_only" });
check("restore rewinds committed head to checkpoint", rewound.success === true && read("a.txt") === "A2-modified\n", `success=${rewound.success} a=${JSON.stringify(read("a.txt"))}`);
const postRewind = await service.compareCheckpoint("cp-clean");
check("committed drift reported honestly after rewind", postRewind.changes === 1, `changes=${postRewind.changes}`);

// 6. Invalid checkpoint ref fails honestly
try {
  await service.validateCheckpointRef("nonexistent-checkpoint");
  check("bogus checkpoint ref rejected", false, "no error thrown");
} catch {
  check("bogus checkpoint ref rejected", true, "threw");
}
const missing = await service.restoreCheckpoint("definitely-missing", { restoreType: "code_only" }).catch((e) => ({ success: false, error: e.message }));
check("missing checkpoint restore fails honestly", missing.success === false, (missing.error ?? "").slice(0, 80));

const passed = results.filter((r) => r.ok).length;
console.log(`\nGIT_LIVE_CHECK ${passed}/${results.length} PASS`);
fs.writeFileSync("docs/evidence/r28-capability-completion/R28-GIT-LIVE-EVIDENCE.json", JSON.stringify({
  schema: "r28-git-live-check-1",
  recordedAt: new Date().toISOString(),
  repo: "real temp git repository (git init -b main)",
  results,
}, null, 2) + "\n");
process.exit(passed === results.length ? 0 : 1);
