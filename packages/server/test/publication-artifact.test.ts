import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createPublicationArtifact } from "../src/publication-artifact.js";

const execFile = promisify(execFileCallback);
const owned: string[] = [];
const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf11-artifact-")); owned.push(root);
  await execFile("git", ["init", "-b", "main"], { cwd: root });
  await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root });
  await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
  await fs.writeFile(path.join(root, "file.txt"), "base\n"); await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "base"], { cwd: root });
  const base = await git(root, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(root, "file.txt"), "delivery\n"); await execFile("git", ["add", "."], { cwd: root }); await execFile("git", ["commit", "-m", "delivery"], { cwd: root });
  return { root, base, head: await git(root, ["rev-parse", "HEAD"]), tree: await git(root, ["rev-parse", "HEAD^{tree}"]) };
}

afterEach(async () => { while (owned.length) await fs.rm(owned.pop()!, { recursive: true, force: true }); });

describe("CF-11B publication artifact", () => {
  it("reads the certified Git lineage without changing the local worktree", async () => {
    const f = await fixture(); const before = await git(f.root, ["status", "--porcelain=v2"]);
    const artifact = await createPublicationArtifact({ workspacePath: f.root, publicationId: "publication-1", deliveryId: "delivery-1", missionId: "mission-1", repository: "github.com/codeforge/fixture", targetRef: "main", targetSha: f.base, certifiedHead: f.head, certifiedTree: f.tree });
    expect(artifact.manifest.certifiedHead).toBe(f.head); expect(artifact.manifest.certifiedTree).toBe(f.tree); expect(artifact.manifest.sha256).toMatch(/^[a-f0-9]{64}$/); expect(artifact.bundle.byteLength).toBeGreaterThan(0); expect(await git(f.root, ["status", "--porcelain=v2"])).toBe(before);
  });

  it("rejects a stale delivery identity before producing an artifact", async () => {
    const f = await fixture();
    await expect(createPublicationArtifact({ workspacePath: f.root, publicationId: "publication-1", deliveryId: "delivery-1", missionId: "mission-1", repository: "github.com/codeforge/fixture", targetRef: "main", targetSha: f.base, certifiedHead: f.base, certifiedTree: f.tree })).rejects.toThrow("PUBLICATION_ARTIFACT_DELIVERY_CHANGED");
  });
});
