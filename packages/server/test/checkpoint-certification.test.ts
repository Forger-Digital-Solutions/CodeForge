import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { createCheckpointService, CheckpointService } from "../src/checkpoint-service.js";
import { createSessionPersistence, SessionPersistence } from "@codeforge/sessions";

const execFile = promisify(execFileCallback);

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("CF-05 Final Certification — Exact Staging, Restart Recovery & Ref Validation", () => {
  let ws: string;
  let dbDir: string;
  let dbFile: string;

  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "cf-chk-cert-ws-"));
    dbDir = await mkdtemp(join(tmpdir(), "cf-chk-cert-db-"));
    dbFile = join(dbDir, "test-sessions.db");

    // Initialize clean git repository
    await execFile("git", ["init"], { cwd: ws });
    await execFile("git", ["config", "user.name", "CodeForge Tester"], { cwd: ws });
    await execFile("git", ["config", "user.email", "test@codeforge.ai"], { cwd: ws });
    await execFile("git", ["config", "commit.gpgsign", "false"], { cwd: ws });
    await execFile("git", ["config", "core.autocrlf", "false"], { cwd: ws });
    await execFile("git", ["config", "core.eol", "lf"], { cwd: ws });

    // Create initial base commit
    await writeFile(join(ws, "fileA.txt"), "A1\n");
    await writeFile(join(ws, "fileB.txt"), "B1\n");
    await execFile("git", ["add", "."], { cwd: ws });
    await execFile("git", ["commit", "-m", "initial commit"], { cwd: ws });
  });

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it("CF-05A: Real Restart Recovery across instance destruction with SQLite file persistence", async () => {
    // 1. SessionPersistence A connected to file-backed DB (outside repository)
    const persistenceA = createSessionPersistence({ dbPath: dbFile, driver: "sqlite" });
    await persistenceA.init();
    await persistenceA.upsertSession({
      id: "sess-cert-1",
      title: "Certification Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });

    const svcA = createCheckpointService(ws, persistenceA);
    await svcA.init();

    // Modify file and create checkpoint
    await writeFile(join(ws, "fileA.txt"), "A_modified\n");
    await writeFile(join(ws, "new_file.txt"), "untracked content\n");

    const chk = await svcA.createCheckpoint({
      checkpointId: "chk-cert-001",
      sessionId: "sess-cert-1",
      label: "Before breaking change",
    });

    expect(chk.checkpointId).toBe("chk-cert-001");
    expect(chk.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // 2. Destroy service A and close persistence A
    await persistenceA.close();

    // 3. Open NEW persistence B against same SQLite DB file and NEW service B
    const persistenceB = createSessionPersistence({ dbPath: dbFile, driver: "sqlite" });
    await persistenceB.init();
    const svcB = createCheckpointService(ws, persistenceB);
    await svcB.init();

    // Production discovery: service B rehydrates from DB automatically
    const recoveredChk = svcB.getCheckpoint("chk-cert-001");
    expect(recoveredChk).toBeDefined();
    expect(recoveredChk?.checkpointId).toBe("chk-cert-001");
    expect(recoveredChk?.commitSha).toBe(chk.commitSha);
    expect(recoveredChk?.durableRef).toBe("refs/codeforge/checkpoints/chk-cert-001");

    // All checkpoints list also discovers it
    const all = svcB.getAllCheckpoints();
    expect(all).toHaveLength(1);
    expect(all[0]?.checkpointId).toBe("chk-cert-001");

    // 4. Mutate workspace further
    await writeFile(join(ws, "fileA.txt"), "A_corrupted\n");
    await rm(join(ws, "new_file.txt"));

    // 5. Restore through service B
    const restoreRes = await svcB.restoreCheckpoint("chk-cert-001", { force: true });
    expect(restoreRes.success).toBe(true);

    // Verify restored file contents byte-for-byte
    expect(await readFile(join(ws, "fileA.txt"), "utf-8")).toBe("A_modified\n");
    expect(await readFile(join(ws, "new_file.txt"), "utf-8")).toBe("untracked content\n");

    await persistenceB.close();
  });

  it("CF-05B: Exact Git Index / Staging Restore with mixed staged/unstaged/untracked state", async () => {
    // Construct exact mixed state:
    // - fileA.txt: staged A2, working A3
    // - fileB.txt: unstaged B2 (not staged)
    // - fileC.txt: new staged file C1
    // - fileD.txt: new untracked file D1
    await writeFile(join(ws, "fileA.txt"), "A2\n");
    await execFile("git", ["add", "fileA.txt"], { cwd: ws });
    await writeFile(join(ws, "fileA.txt"), "A3\n");

    await writeFile(join(ws, "fileB.txt"), "B2\n");

    await writeFile(join(ws, "fileC.txt"), "C1\n");
    await execFile("git", ["add", "fileC.txt"], { cwd: ws });

    await writeFile(join(ws, "fileD.txt"), "D1\n");

    // Record pre-checkpoint representations
    const { stdout: statusBefore } = await execFile("git", ["status", "--porcelain=v2"], { cwd: ws });
    const { stdout: diffBefore } = await execFile("git", ["diff"], { cwd: ws });
    const { stdout: diffCachedBefore } = await execFile("git", ["diff", "--cached"], { cwd: ws });
    const hashA_before = sha256(await readFile(join(ws, "fileA.txt")));
    const hashB_before = sha256(await readFile(join(ws, "fileB.txt")));
    const hashC_before = sha256(await readFile(join(ws, "fileC.txt")));
    const hashD_before = sha256(await readFile(join(ws, "fileD.txt")));

    const svc = createCheckpointService(ws);
    const chk = await svc.createCheckpoint({
      checkpointId: "chk-mixed-001",
      label: "Mixed staging checkpoint",
    });

    // Invariant: Checkpoint creation MUST be observational (before == immediately after)
    const { stdout: statusAfterCreation } = await execFile("git", ["status", "--porcelain=v2"], { cwd: ws });
    const { stdout: diffAfterCreation } = await execFile("git", ["diff"], { cwd: ws });
    const { stdout: diffCachedAfterCreation } = await execFile("git", ["diff", "--cached"], { cwd: ws });
    expect(statusAfterCreation).toBe(statusBefore);
    expect(diffAfterCreation).toBe(diffBefore);
    expect(diffCachedAfterCreation).toBe(diffCachedBefore);

    // Corrupt both index and working tree
    await writeFile(join(ws, "fileA.txt"), "A_corrupt\n");
    await execFile("git", ["add", "fileA.txt"], { cwd: ws });
    await writeFile(join(ws, "fileB.txt"), "B_corrupt\n");
    await execFile("git", ["add", "fileB.txt"], { cwd: ws });
    await rm(join(ws, "fileC.txt"));
    await rm(join(ws, "fileD.txt"));

    // Restore checkpoint
    const restoreRes = await svc.restoreCheckpoint("chk-mixed-001", { force: true });
    expect(restoreRes.success).toBe(true);

    // Verify post-restore representations match checkpoint-time state exactly
    const { stdout: statusAfterRestore } = await execFile("git", ["status", "--porcelain=v2"], { cwd: ws });
    const { stdout: diffAfterRestore } = await execFile("git", ["diff"], { cwd: ws });
    const { stdout: diffCachedAfterRestore } = await execFile("git", ["diff", "--cached"], { cwd: ws });

    expect(statusAfterRestore).toBe(statusBefore);
    expect(diffAfterRestore).toBe(diffBefore);
    expect(diffCachedAfterRestore).toBe(diffCachedBefore);

    // Verify file hashes
    expect(sha256(await readFile(join(ws, "fileA.txt")))).toBe(hashA_before);
    expect(sha256(await readFile(join(ws, "fileB.txt")))).toBe(hashB_before);
    expect(sha256(await readFile(join(ws, "fileC.txt")))).toBe(hashC_before);
    expect(sha256(await readFile(join(ws, "fileD.txt")))).toBe(hashD_before);
  });

  it("CF-05C: Durable Ref Validation fails closed when durable Git ref is deleted or corrupt", async () => {
    const persistence = createSessionPersistence({ dbPath: dbFile });
    persistence.upsertSession({
      id: "sess-ref-1",
      title: "Ref Validation Session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
    });

    const svc = createCheckpointService(ws, persistence);
    await writeFile(join(ws, "fileA.txt"), "A_ref_test\n");

    const chk = await svc.createCheckpoint({
      checkpointId: "chk-ref-001",
      sessionId: "sess-ref-1",
      label: "Ref validation test",
    });

    // Deliberately delete durable ref in Git object database
    await execFile("git", ["update-ref", "-d", "refs/codeforge/checkpoints/chk-ref-001"], { cwd: ws });

    // Restart service
    persistence.close();
    const persistence2 = createSessionPersistence({ dbPath: dbFile });
    const svc2 = createCheckpointService(ws, persistence2);

    // Attempting restore must fail closed with CHECKPOINT_UNAVAILABLE error
    await expect(svc2.restoreCheckpoint("chk-ref-001", { force: true })).rejects.toThrow(
      /CHECKPOINT_UNAVAILABLE/,
    );

    persistence2.close();
  });
});
