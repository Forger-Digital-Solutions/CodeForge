import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CloudPublicationMaterializer } from "../src/publication-executor.js";

const execFile = promisify(execFileCallback);
const owned: string[] = [];
const git = async (cwd: string, args: string[]) => (await execFile("git", args, { cwd })).stdout.trim();

afterEach(async () => { while (owned.length) await fs.rm(owned.pop()!, { recursive: true, force: true }); });

describe("CF-11B cloud materializer", () => {
  it("verifies a bundle in a disposable bare repository and rejects digest tampering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf11-cloud-artifact-")); owned.push(root);
    await execFile("git", ["init", "-b", "main"], { cwd: root }); await execFile("git", ["config", "user.name", "CodeForge"], { cwd: root }); await execFile("git", ["config", "user.email", "codeforge@example.test"], { cwd: root });
    await fs.writeFile(path.join(root, "file.txt"), "base\n"); await execFile("git", ["add", "-f", "."], { cwd: root }); await execFile("git", ["commit", "-m", "base"], { cwd: root }); const base = await git(root, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(root, "file.txt"), "delivery\n"); await execFile("git", ["add", "-f", "."], { cwd: root }); await execFile("git", ["commit", "-m", "delivery"], { cwd: root }); const head = await git(root, ["rev-parse", "HEAD"]); const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
    const bundlePath = path.join(root, "delivery.bundle"); await execFile("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: root }); const bundle = await fs.readFile(bundlePath); const manifest = { version: 1 as const, publicationId: "publication-1", deliveryId: "delivery-1", missionId: "mission-1", repository: "github.com/codeforge/fixture", targetRef: "main", targetSha: base, certifiedHead: head, certifiedTree: tree, bytes: bundle.byteLength, sha256: crypto.createHash("sha256").update(bundle).digest("hex"), createdAt: new Date().toISOString() };
    await expect(new CloudPublicationMaterializer().verify({ manifest, bundle })).resolves.toMatchObject({ certifiedHead: head, certifiedTree: tree });
    await expect(new CloudPublicationMaterializer().verify({ manifest: { ...manifest, sha256: "0".repeat(64) }, bundle })).rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
  });
});
